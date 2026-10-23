/** The subset of a `pg` Client the leader election needs. */
export interface LeaderClient {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  end(): Promise<void>;
  on(event: 'error' | 'end' | 'notification', listener: (...args: any[]) => void): unknown;
}

/** Postgres channel names are identifiers; these are the only characters used here. */
const CHANNEL_PATTERN = /^[a-z0-9_]{1,63}$/;

export interface LeaderElectionOptions {
  /** Instances using the same key compete for the same leadership. */
  lockKey: string;
  /** Creates the dedicated connection that holds the lock (not a pooled one). */
  createClient: () => LeaderClient;
  /** How often a standby retries, and how often the leader checks its connection. */
  retryMs?: number;
  onAcquire: () => void;
  onLose: () => void;
  /** Runs after each successful heartbeat while leading. Errors are logged, not fatal. */
  onLeaderTick?: () => Promise<void> | void;
  /**
   * Runs on each regular retry while on standby (not the quick polls after a handoff
   * request), e.g. to keep state that's shown to users current. Errors are logged, not fatal.
   */
  onStandbyTick?: () => Promise<void> | void;
  /**
   * Postgres channel for step-down requests and release notices. With one, a standby asks
   * the leader to hand over, and the leader steps down for a newer instance (see
   * stepDownFor); a leader that resigns tells standbys, so one takes over at once. Without
   * one, leadership only changes when the leader's session ends.
   */
  handoffChannel?: string;
  /** Identifies this instance in step-down requests and logs. */
  instanceId?: string;
  /** When this instance started (ms since the epoch). The newest instance should lead. */
  startedAt?: number;
  /** After stepping down, how long to stay out of the race so the newer instance gets the lock. */
  yieldGraceMs?: number;
  /** After asking for a handoff, how often to try the lock, a few times, before the usual retry. */
  handoffPollMs?: number;
  /**
   * When stepping down, runs after onLose and before the lock is released, e.g. to let work
   * already under way finish so the old and new leader never overlap. It should settle
   * promptly (it holds up the handoff); if it rejects, the connection is closed instead.
   */
  beforeRelease?: () => Promise<void>;
}

/** A standby's request for the leader to step down. */
interface HandoffRequest {
  instanceId: string;
  startedAt: number;
}

/** A resigning leader's notice that the lock is free: `{ released: <its instance id> }`. */
interface ReleaseNotice {
  released: string;
}

/** How many quick lock attempts follow each step-down request. */
const HANDOFF_POLLS = 5;

/** The largest timestamp a Date can hold, in ms; a request's start time must be within it. */
const MAX_DATE_MS = 8.64e15;
const MAX_INSTANCE_ID_LENGTH = 200;

/**
 * Elects one leader among instances sharing a Postgres database, using a session-level
 * advisory lock held on a dedicated connection.
 *
 * Postgres releases the lock when the leader's session ends: when its process exits, or
 * when the connection drops (TCP keepalives detect a vanished peer within about a minute).
 * A standby then acquires it on its next retry.
 *
 * With a handoff channel, the newest instance also takes over from a running leader: an old
 * instance can keep running for a long time after a deploy or an instance replacement (while
 * its WebSocket subscribers stay connected), but new traffic goes to the new one. And a
 * leader that shuts down (see resign) tells the standbys, so one takes over right away
 * instead of on its next retry.
 */
export class LeaderElection {
  isLeader = false;
  readonly instanceId: string;
  readonly startedAt: number;

  private client: LeaderClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly retryMs: number;
  private readonly handoffPollMs: number;
  private readonly yieldGraceMs: number;
  private yieldedUntil = 0;
  private handoffPollsLeft = 0;
  /** Whether the current connection LISTENs on the handoff channel. */
  private listening = false;
  /** A tick is under way; a wake-up then runs the next one straight after it. */
  private ticking = false;
  private wakeRequested = false;
  /** A step-down for a newer instance under way: it still holds the lock until it finishes. */
  private handoff: Promise<void> | null = null;

  constructor(private readonly options: LeaderElectionOptions) {
    this.retryMs = options.retryMs ?? 10_000;
    this.handoffPollMs = Math.min(options.handoffPollMs ?? 1_000, this.retryMs);
    this.yieldGraceMs = options.yieldGraceMs ?? 60_000;
    this.instanceId = options.instanceId ?? Math.random().toString(36).slice(2, 10);
    this.startedAt = options.startedAt ?? Date.now();
    if (options.handoffChannel !== undefined && !CHANNEL_PATTERN.test(options.handoffChannel)) {
      throw new Error(`Invalid handoff channel: ${options.handoffChannel}`);
    }
  }

  /** Start competing for leadership. Safe to call more than once. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  /** Stop competing and release leadership (ending the session releases the lock). */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.dropConnection('stopped');
  }

  /**
   * Stop competing and hand leadership over cleanly, e.g. when the instance shuts down:
   * stop leading (onLose), let work under way finish (beforeRelease), release the lock, then
   * tell the standbys so one takes over at once. If any step fails, closing the connection
   * releases the lock instead, and a standby takes over on its next retry.
   */
  async resign(): Promise<void> {
    const client = this.client;
    const wasLeader = this.isLeader;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!wasLeader || !client) {
      // Stepping down for a newer instance: it holds the lock until work under way finishes,
      // so let it complete rather than cut it short (the shutdown deadline still applies)
      await this.handoff;
      await this.dropConnection('stopped');
      return;
    }
    this.isLeader = false;
    try {
      this.options.onLose();
      console.log(`👋 [LEADER] Resigning leadership for ${this.options.lockKey} (instance ${this.instanceId})`);
      await this.options.beforeRelease?.();
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [this.options.lockKey]);
      if (this.options.handoffChannel) {
        const notice: ReleaseNotice = { released: this.instanceId };
        await client.query('SELECT pg_notify($1, $2)', [this.options.handoffChannel, JSON.stringify(notice)]);
      }
    } catch (err) {
      console.error(`❌ [LEADER] Resigning ${this.options.lockKey} failed; closing the connection instead:`, err);
    }
    if (client === this.client) await this.dropConnection('resigned');
  }

  /** Try for the lock now rather than at the next retry (after a release notice). */
  private wakeUp(): void {
    if (!this.running) return;
    if (this.ticking) {
      this.wakeRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), 0);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    let nextDelay = this.retryMs;
    this.ticking = true;
    try {
      if (this.isLeader) {
        // Heartbeat: fails if the connection (and with it the lock) is gone
        await this.client!.query('SELECT 1');
        // It may have stepped down while the heartbeat was in flight
        if (this.isLeader) await this.runLeaderTick();
      } else if (Date.now() < this.yieldedUntil) {
        // Just stepped down: leave the lock to the instance that asked for it
      } else {
        if (!this.client) {
          const client = await this.openConnection();
          // stop() may have run while the connection was opening; don't keep it
          if (!this.running) {
            await client.end().catch(() => {});
            return;
          }
          this.client = client;
        }
        const result = await this.client.query(
          'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
          [this.options.lockKey],
        );
        if (result.rows[0]?.acquired && this.running) {
          this.handoffPollsLeft = 0;
          const client = this.client;
          await this.listenForHandoffRequests();
          // stop() (or a lost connection) may have ended this session while LISTEN was in
          // flight; its lock went with it, so don't lead
          if (!this.running || this.client !== client) return;
          this.isLeader = true;
          console.log(`👑 [LEADER] Acquired leadership for ${this.options.lockKey} (instance ${this.instanceId})`);
          this.options.onAcquire();
        } else if (this.options.handoffChannel && this.running) {
          // Hear when the leader resigns, and take over then
          await this.listenForHandoffRequests();
          // Ask the leader to hand over, then try the lock a few times in quick succession
          if (this.handoffPollsLeft === 0) {
            await this.requestHandoff();
            this.handoffPollsLeft = HANDOFF_POLLS;
          } else {
            this.handoffPollsLeft--;
          }
          if (this.handoffPollsLeft > 0) nextDelay = this.handoffPollMs;
        }
      }
      if (!this.isLeader && this.running && nextDelay === this.retryMs) await this.runStandbyTick();
    } catch (err) {
      console.error(`❌ [LEADER] Leadership check for ${this.options.lockKey} failed:`, err);
      await this.dropConnection('connection error');
    } finally {
      this.ticking = false;
      if (this.wakeRequested) {
        this.wakeRequested = false;
        nextDelay = 0;
      }
      if (this.running) {
        this.timer = setTimeout(() => void this.tick(), nextDelay);
        this.timer.unref?.();
      }
    }
  }

  private async requestHandoff(): Promise<void> {
    const request: HandoffRequest = { instanceId: this.instanceId, startedAt: this.startedAt };
    await this.client!.query('SELECT pg_notify($1, $2)', [this.options.handoffChannel, JSON.stringify(request)]);
  }

  /** LISTENs on the handoff channel, once per connection: requests reach the leader, notices the standbys. */
  private async listenForHandoffRequests(): Promise<void> {
    if (!this.options.handoffChannel || this.listening) return;
    const client = this.client!;
    // The channel matches CHANNEL_PATTERN, so it's safe as a quoted identifier
    await client.query(`LISTEN "${this.options.handoffChannel}"`);
    if (client === this.client) this.listening = true;
  }

  /** Whether a requester should lead instead of this instance: the newer one leads. */
  private isNewer(request: HandoffRequest): boolean {
    if (request.startedAt !== this.startedAt) return request.startedAt > this.startedAt;
    return request.instanceId > this.instanceId; // Started the same millisecond: any fixed order
  }

  private onNotification(client: LeaderClient, message: { channel?: string; payload?: string }): void {
    if (client !== this.client || message.channel !== this.options.handoffChannel) return;
    let parsed: any;
    try {
      parsed = JSON.parse(message.payload ?? '');
    } catch {
      return;
    }
    if (this.isLeader) this.onHandoffRequest(parsed);
    else this.onReleaseNotice(parsed);
  }

  /** A standby hears that the leader resigned: try for the lock now, even right after yielding. */
  private onReleaseNotice(parsed: any): void {
    // Notices come from other instances, so check them before acting on one
    const released = parsed?.released;
    if (typeof released !== 'string' || released.length === 0 || released.length > MAX_INSTANCE_ID_LENGTH) return;
    if (released === this.instanceId || !this.running) return;
    this.yieldedUntil = 0;
    this.handoffPollsLeft = 0;
    this.wakeUp();
  }

  /** The leader hears a standby asking it to step down. */
  private onHandoffRequest(parsed: any): void {
    // Requests come from other instances, so check them fully before acting on one
    const { instanceId, startedAt } = parsed ?? {};
    if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > MAX_INSTANCE_ID_LENGTH) return;
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || Math.abs(startedAt) > MAX_DATE_MS) return;
    const request: HandoffRequest = { instanceId, startedAt };
    if (request.instanceId === this.instanceId || !this.isNewer(request)) return;
    this.stepDownFor(request).catch((err) => {
      console.error(`❌ [LEADER] Stepping down for ${this.options.lockKey} failed:`, err);
    });
  }

  /**
   * Hands leadership to a newer instance: stops leading first (the firehose closes and posts
   * in flight are dropped), then releases the lock, so two instances never process at once.
   * If the lock can't be released cleanly, the connection is closed, which releases it too.
   */
  private stepDownFor(request: HandoffRequest): Promise<void> {
    if (!this.isLeader || !this.client) return Promise.resolve();
    const handoff = this.handOver(this.client, request).finally(() => {
      if (this.handoff === handoff) this.handoff = null;
    });
    this.handoff = handoff;
    return handoff;
  }

  private async handOver(client: LeaderClient, request: HandoffRequest): Promise<void> {
    this.isLeader = false;
    this.yieldedUntil = Date.now() + this.yieldGraceMs;
    // Stop leading first, then give up the lock. If anything fails, onLose included, closing
    // the connection releases the lock instead, so it's never held by an instance not leading.
    try {
      this.options.onLose();
      console.log(
        `🤝 [LEADER] Stepping down for ${this.options.lockKey}: newer instance ${request.instanceId} ` +
          `(started ${new Date(request.startedAt).toISOString()}) takes over from ${this.instanceId}`,
      );
      await this.options.beforeRelease?.();
      // It stays LISTENing, to hear if the newer leader resigns and take over again
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [this.options.lockKey]);
    } catch (err) {
      console.error(`❌ [LEADER] Releasing ${this.options.lockKey} failed; closing the connection instead:`, err);
      if (client === this.client) await this.dropConnection('handoff');
    }
  }

  private async runLeaderTick(): Promise<void> {
    try {
      await this.options.onLeaderTick?.();
    } catch (err) {
      console.error(`❌ [LEADER] Leader tick for ${this.options.lockKey} failed:`, err);
    }
  }

  private async runStandbyTick(): Promise<void> {
    try {
      await this.options.onStandbyTick?.();
    } catch (err) {
      console.error(`❌ [LEADER] Standby tick for ${this.options.lockKey} failed:`, err);
    }
  }

  private async openConnection(): Promise<LeaderClient> {
    const client = this.options.createClient();
    const lost = () => {
      if (client === this.client) void this.dropConnection('connection closed');
    };
    client.on('error', lost);
    client.on('end', lost);
    client.on('notification', (message) => this.onNotification(client, message));
    await client.connect();
    // Let Postgres notice a vanished leader in ~60s rather than the OS default of hours
    await client.query('SET tcp_keepalives_idle = 30');
    await client.query('SET tcp_keepalives_interval = 10');
    await client.query('SET tcp_keepalives_count = 3');
    return client;
  }

  private async dropConnection(reason: string): Promise<void> {
    const client = this.client;
    this.client = null;
    this.listening = false;
    if (this.isLeader) {
      this.isLeader = false;
      console.warn(`⚠️ [LEADER] Lost leadership for ${this.options.lockKey} (${reason})`);
      this.options.onLose();
    }
    await client?.end().catch(() => {});
  }
}

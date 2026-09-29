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
   * Postgres channel for step-down requests. With one, a standby asks the leader to hand
   * over, and the leader steps down for a newer instance (see stepDownFor). Without one,
   * leadership only changes when the leader's session ends.
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
 * its WebSocket subscribers stay connected), but new traffic goes to the new one.
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

  private async tick(): Promise<void> {
    let nextDelay = this.retryMs;
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
    } catch (err) {
      console.error(`❌ [LEADER] Leadership check for ${this.options.lockKey} failed:`, err);
      await this.dropConnection('connection error');
    } finally {
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

  private async listenForHandoffRequests(): Promise<void> {
    if (!this.options.handoffChannel) return;
    // The channel matches CHANNEL_PATTERN, so it's safe as a quoted identifier
    await this.client!.query(`LISTEN "${this.options.handoffChannel}"`);
  }

  /** Whether a requester should lead instead of this instance: the newer one leads. */
  private isNewer(request: HandoffRequest): boolean {
    if (request.startedAt !== this.startedAt) return request.startedAt > this.startedAt;
    return request.instanceId > this.instanceId; // Started the same millisecond: any fixed order
  }

  private onNotification(client: LeaderClient, message: { channel?: string; payload?: string }): void {
    if (client !== this.client || !this.isLeader || message.channel !== this.options.handoffChannel) return;
    let request: HandoffRequest;
    try {
      const parsed = JSON.parse(message.payload ?? '');
      // Requests come from other instances, so check them fully before acting on one
      const { instanceId, startedAt } = parsed ?? {};
      if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > MAX_INSTANCE_ID_LENGTH) return;
      if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || Math.abs(startedAt) > MAX_DATE_MS) return;
      request = { instanceId: parsed.instanceId, startedAt: parsed.startedAt };
    } catch {
      return;
    }
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
  private async stepDownFor(request: HandoffRequest): Promise<void> {
    const client = this.client;
    if (!this.isLeader || !client) return;
    this.isLeader = false;
    this.yieldedUntil = Date.now() + this.yieldGraceMs;
    // Stop leading before anything else can fail, then give up the lock one way or another
    try {
      this.options.onLose();
      console.log(
        `🤝 [LEADER] Stepping down for ${this.options.lockKey}: newer instance ${request.instanceId} ` +
          `(started ${new Date(request.startedAt).toISOString()}) takes over from ${this.instanceId}`,
      );
      await this.options.beforeRelease?.();
      await client.query(`UNLISTEN "${this.options.handoffChannel}"`);
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
    if (this.isLeader) {
      this.isLeader = false;
      console.warn(`⚠️ [LEADER] Lost leadership for ${this.options.lockKey} (${reason})`);
      this.options.onLose();
    }
    await client?.end().catch(() => {});
  }
}

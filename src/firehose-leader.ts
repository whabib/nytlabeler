/** The subset of a `pg` Client the leader election needs. */
export interface LeaderClient {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  end(): Promise<void>;
  on(event: 'error' | 'end', listener: (...args: any[]) => void): unknown;
}

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
}

/**
 * Elects one leader among instances sharing a Postgres database, using a session-level
 * advisory lock held on a dedicated connection.
 *
 * Postgres releases the lock when the leader's session ends: when its process exits, or
 * when the connection drops (TCP keepalives detect a vanished peer within about a minute).
 * A standby then acquires it on its next retry.
 */
export class LeaderElection {
  isLeader = false;

  private client: LeaderClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly retryMs: number;

  constructor(private readonly options: LeaderElectionOptions) {
    this.retryMs = options.retryMs ?? 10_000;
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
    try {
      if (this.isLeader) {
        // Heartbeat: fails if the connection (and with it the lock) is gone
        await this.client!.query('SELECT 1');
        await this.runLeaderTick();
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
          this.isLeader = true;
          console.log(`👑 [LEADER] Acquired leadership for ${this.options.lockKey}`);
          this.options.onAcquire();
        }
      }
    } catch (err) {
      console.error(`❌ [LEADER] Leadership check for ${this.options.lockKey} failed:`, err);
      await this.dropConnection('connection error');
    } finally {
      if (this.running) {
        this.timer = setTimeout(() => void this.tick(), this.retryMs);
        this.timer.unref?.();
      }
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

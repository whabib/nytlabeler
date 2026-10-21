/**
 * Cloud Run sends SIGTERM before it stops an instance (after a deploy, an instance
 * replacement or scaling in), then SIGKILL 10 seconds later.
 */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** Exit before Cloud Run's 10-second grace period runs out, even if the handover hangs. */
export const SHUTDOWN_TIMEOUT_MS = 8_000;

export interface ShutdownOptions {
  /** Hands firehose leadership over (see resignFirehoseLeadership). */
  resign: () => Promise<void>;
  /** Defaults to process.exit. */
  exit?: (code: number) => void;
  /** Defaults to the process itself. */
  signals?: { once(signal: string, listener: () => void): unknown };
  timeoutMs?: number;
}

/**
 * On SIGTERM or SIGINT, hands firehose leadership over, then exits. Without this, the
 * process exits at once: a standby only takes over on its next retry, up to 10 seconds
 * later, and posts being labeled are cut off. A second identical signal (pressing Ctrl-C
 * twice) exits immediately, as usual.
 */
export function installShutdownHandlers(options: ShutdownOptions): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const signals = options.signals ?? process;
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`🛑 Received ${signal}; handing over firehose leadership before exiting...`);
    const deadline = setTimeout(() => {
      console.warn(`⚠️ Handover didn't finish within ${timeoutMs} ms; exiting anyway.`);
      exit(0);
    }, timeoutMs);
    deadline.unref?.();
    try {
      await options.resign();
    } catch (err) {
      console.error('❌ Handing over firehose leadership failed:', err);
    }
    clearTimeout(deadline);
    exit(0);
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    signals.once(signal, () => void shutdown(signal));
  }
}

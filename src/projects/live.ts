import { parseConfig } from './config.js';
import type { PluginConfig } from '../domain/types.js';

/** Serialize snapshots read at execution time; stale notifications cannot restore old settings. */
export class LiveConfig {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private applied: string;
  private rejected?: { key: string; error: unknown };
  constructor(private read: () => unknown, initial: PluginConfig, private apply: (config: PluginConfig) => Promise<void>, private report: (error: unknown) => void) {
    this.applied = JSON.stringify(initial);
  }
  refresh(retryFailed = false): Promise<void> {
    const operation = this.queue.then(async () => {
      if (this.closed) return;
      let key = '';
      try {
        const value = this.read();
        key = JSON.stringify(value);
        const config = parseConfig(value);
        key = JSON.stringify(config);
        if (key === this.applied) { this.rejected = undefined; return; }
        if (key === this.rejected?.key && !retryFailed) throw this.rejected.error;
        await this.apply(config);
        this.applied = key; this.rejected = undefined;
      } catch (error) {
        if (this.rejected?.key !== key) this.report(error);
        this.rejected = { key, error }; throw error;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async close(): Promise<void> { this.closed = true; await this.queue; }
}

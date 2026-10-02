import { api, type Locator } from "./api";

export type SaveStatus = { kind: "saved"; at: number } | { kind: "pending" } | { kind: "error"; message: string };

const IDLE_MS = 500;
const MAX_WAIT_MS = 2000;

/**
 * Coalesces reading positions into backend saves: page turns and jumps save
 * immediately, continuous movement saves after 500 ms idle and at least every
 * 2 s. A failed save keeps the pending position so Retry can resend it.
 */
export class ProgressSaver {
  private pending: { locator: Locator; percent: number } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt = 0;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private bookId: number,
    private onStatus: (s: SaveStatus) => void,
    private onUpdate: (locator: Locator, percent: number) => void = () => {},
  ) {}

  update(locator: Locator, percent: number, immediate: boolean) {
    this.onUpdate(locator, percent);
    if (!this.pending) this.firstPendingAt = Date.now();
    this.pending = { locator, percent };
    this.onStatus({ kind: "pending" });
    if (immediate || Date.now() - this.firstPendingAt >= MAX_WAIT_MS) {
      void this.flush();
      return;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.flush(), IDLE_MS);
  }

  flush(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.inflight = this.inflight.then(async () => {
      const job = this.pending;
      if (!job) return;
      this.pending = null;
      try {
        const at = await api.saveProgress(this.bookId, job.locator, job.percent);
        this.onStatus({ kind: "saved", at });
      } catch (e) {
        this.pending ??= job;
        this.onStatus({ kind: "error", message: String(e) });
      }
    });
    return this.inflight;
  }
}

/** A destructive action shown with an Undo bar and run when the bar goes away. */
export type PendingAction =
  | { kind: "remove-book"; bookId: number }
  | { kind: "delete-copy"; bookId: number }
  | { kind: "delete-collection"; collectionId: number }
  | { kind: "remove-folder"; folderId: number }
  | { kind: "delete-annotation"; annotationId: number };

export const UNDO_MS = 6000;

export type HoldReason = "hover" | "hidden";

export interface Scheduler<T> {
  /** Shows `action`; an action already showing commits first. */
  schedule(action: T): void;
  /** Drops the showing action without committing it. */
  undo(): void;
  /** Commits the showing action and waits for every commit still running. */
  flush(): Promise<void>;
  /** The countdown stops while any hold is on. */
  hold(reason: HoldReason, on: boolean): void;
}

interface Options<T> {
  ms: number;
  commit(action: T): Promise<void>;
  /** The action the bar shows, or null. */
  onChange(action: T | null): void;
}

export function createScheduler<T>({ ms, commit, onChange }: Options<T>): Scheduler<T> {
  let current: T | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let remaining = ms;
  let startedAt = 0;
  const holds = new Set<HoldReason>();
  const running = new Set<Promise<void>>();

  const stop = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    remaining -= Date.now() - startedAt;
  };
  const start = () => {
    if (current === null || timer !== null || holds.size > 0) return;
    startedAt = Date.now();
    timer = setTimeout(() => {
      timer = null;
      commitCurrent();
    }, Math.max(0, remaining));
  };
  const take = () => {
    stop();
    const a = current;
    current = null;
    if (a !== null) onChange(null);
    return a;
  };
  const commitCurrent = () => {
    const a = take();
    if (a === null) return;
    const p = commit(a).finally(() => running.delete(p));
    running.add(p);
  };

  return {
    schedule(action) {
      commitCurrent();
      current = action;
      remaining = ms;
      onChange(action);
      start();
    },
    undo() {
      take();
    },
    async flush() {
      commitCurrent();
      await Promise.allSettled([...running]);
    },
    hold(reason, on) {
      if (on) {
        holds.add(reason);
        stop();
      } else {
        holds.delete(reason);
        start();
      }
    },
  };
}

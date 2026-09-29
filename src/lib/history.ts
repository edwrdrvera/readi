import type { Locator } from "./api";

/**
 * Per-book Back history for this session. Contents, link, and search jumps
 * push the position they leave; Back pops without pushing.
 */
const stacks = new Map<number, Locator[]>();
const listeners = new Set<() => void>();
const LIMIT = 100;

export const backHistory = {
  push(bookId: number, from: Locator | null) {
    if (!from) return;
    const stack = stacks.get(bookId) ?? [];
    stack.push(from);
    stacks.set(bookId, stack.slice(-LIMIT));
    listeners.forEach((l) => l());
  },
  pop(bookId: number): Locator | null {
    const loc = stacks.get(bookId)?.pop() ?? null;
    listeners.forEach((l) => l());
    return loc;
  },
  size: (bookId: number) => stacks.get(bookId)?.length ?? 0,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

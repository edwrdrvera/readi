import { api } from "./lib/api";
import { useApp } from "./lib/store";
import { activeReader } from "./reader/handle";

// Shared by the M2 and M3 self-test phases.

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(what: string, fn: () => T | Promise<T>, timeoutMs = 60_000): Promise<NonNullable<T>> {
  void api.selftestLog(`wait: ${what} (${document.visibilityState})`);
  const start = performance.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

export async function openAndWait(id: number) {
  const started = performance.now();
  await useApp.getState().openBook(id);
  const reader = await until("reader", () => (activeReader()?.bookId === id ? activeReader() : null));
  await reader.ready;
  return { reader, openMs: Math.round(performance.now() - started) };
}

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createScheduler } from "./pending";

let committed: string[];
let shown: (string | null)[];
const make = () =>
  createScheduler<string>({
    ms: 6000,
    commit: async (a) => void committed.push(a),
    onChange: (a) => void shown.push(a),
  });

beforeEach(() => {
  vi.useFakeTimers();
  committed = [];
  shown = [];
});
afterEach(() => vi.useRealTimers());

it("undo cancels without committing, even after the timer would have fired", async () => {
  const s = make();
  s.schedule("a");
  s.undo();
  await vi.advanceTimersByTimeAsync(10_000);
  await s.flush();
  expect(committed).toEqual([]);
  expect(shown).toEqual(["a", null]);
});

it("expiry commits exactly once", async () => {
  const s = make();
  s.schedule("a");
  await vi.advanceTimersByTimeAsync(5999);
  expect(committed).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(10_000);
  await s.flush();
  s.undo();
  expect(committed).toEqual(["a"]);
  expect(shown.at(-1)).toBeNull();
});

it("scheduling a second action commits the first and shows the second", async () => {
  const s = make();
  s.schedule("a");
  s.schedule("b");
  await vi.advanceTimersByTimeAsync(0);
  expect(committed).toEqual(["a"]);
  expect(shown.at(-1)).toBe("b");
  s.undo();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(committed).toEqual(["a"]);
});

it("flush commits all and waits for them", async () => {
  let release!: () => void;
  const done: string[] = [];
  const s = createScheduler<string>({
    ms: 6000,
    commit: (a) => (a === "a" ? new Promise<void>((r) => (release = r)).then(() => void done.push(a)) : Promise.resolve(void done.push(a))),
    onChange: () => {},
  });
  s.schedule("a");
  s.schedule("b");
  const flushed = s.flush().then(() => "flushed");
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toEqual(["b"]);
  release();
  expect(await flushed).toBe("flushed");
  expect(done.sort()).toEqual(["a", "b"]);
});

it("holds pause the countdown and resume with the time left", async () => {
  const s = make();
  s.schedule("a");
  await vi.advanceTimersByTimeAsync(4000);
  s.hold("hover", true);
  s.hold("hidden", true);
  await vi.advanceTimersByTimeAsync(60_000);
  s.hold("hover", false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(committed).toEqual([]);
  s.hold("hidden", false);
  await vi.advanceTimersByTimeAsync(1999);
  expect(committed).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(committed).toEqual(["a"]);
});

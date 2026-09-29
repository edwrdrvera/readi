import { beforeEach, describe, expect, it, vi } from "vitest";

const saved: unknown[] = [];
let fail = false;
vi.mock("./api", () => ({
  api: {
    saveProgress: vi.fn(async (_id: number, locator: unknown) => {
      if (fail) throw new Error("disk full");
      saved.push(locator);
      return Date.now();
    }),
  },
}));

const { ProgressSaver } = await import("./progress");
const loc = (page_index: number) => ({ format: "pdf" as const, v: 1 as const, page_index, x: 0, y: 0 });

describe("ProgressSaver", () => {
  beforeEach(() => {
    saved.length = 0;
    fail = false;
    vi.useFakeTimers();
  });

  it("saves page turns immediately", async () => {
    const s = new ProgressSaver(1, () => {});
    s.update(loc(3), 0.1, true);
    await vi.runAllTimersAsync();
    expect(saved).toEqual([loc(3)]);
  });

  it("debounces scrolling to the last position after 500 ms idle", async () => {
    const s = new ProgressSaver(1, () => {});
    s.update(loc(1), 0, false);
    s.update(loc(2), 0, false);
    await vi.advanceTimersByTimeAsync(499);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual([loc(2)]);
  });

  it("saves at least every 2 s during continuous movement", async () => {
    const s = new ProgressSaver(1, () => {});
    for (let i = 0; i < 25; i++) {
      s.update(loc(i), 0, false);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(saved.length).toBeGreaterThanOrEqual(1);
    expect(saved[0]).toEqual(loc(20));
  });

  it("keeps the position after a failed save and resends on retry", async () => {
    const statuses: string[] = [];
    const s = new ProgressSaver(1, (st) => statuses.push(st.kind));
    fail = true;
    s.update(loc(7), 0, true);
    await vi.runAllTimersAsync();
    expect(statuses.at(-1)).toBe("error");
    fail = false;
    await s.flush();
    expect(saved).toEqual([loc(7)]);
    expect(statuses.at(-1)).toBe("saved");
  });
});

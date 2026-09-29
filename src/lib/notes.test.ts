import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_IDLE_MS, NoteSaver, type NoteStatus } from "./notes";

describe("NoteSaver", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const setup = (save: (n: string | null) => Promise<void>) => {
    const statuses: NoteStatus["kind"][] = [];
    const saver = new NoteSaver("", save);
    saver.subscribe((s) => statuses.push(s.kind));
    return { saver, statuses };
  };

  it("saves once after the typing pause", async () => {
    const save = vi.fn(async () => {});
    const { saver, statuses } = setup(save);
    saver.update("a");
    await vi.advanceTimersByTimeAsync(NOTE_IDLE_MS - 100);
    saver.update("ab");
    await vi.advanceTimersByTimeAsync(NOTE_IDLE_MS - 1);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledExactlyOnceWith("ab");
    expect(statuses).toEqual(["saving", "saved"]);
  });

  it("flushes immediately and saves an emptied note as null", async () => {
    const save = vi.fn(async () => {});
    const saver = new NoteSaver("old", save);
    saver.update("  ");
    await saver.flush();
    expect(save).toHaveBeenCalledWith(null);
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft after a failure and retries it", async () => {
    let fail = true;
    const save = vi.fn(async () => {
      if (fail) throw new Error("disk full");
    });
    const { saver, statuses } = setup(save);
    saver.update("keep me");
    await saver.flush();
    expect(statuses.at(-1)).toBe("error");
    expect(saver.text).toBe("keep me");
    expect(saver.dirty).toBe(true);
    fail = false;
    await saver.flush();
    expect(save).toHaveBeenLastCalledWith("keep me");
    expect(statuses.at(-1)).toBe("saved");
    expect(saver.dirty).toBe(false);
  });

  it("does not report saved while newer text is waiting", async () => {
    let release!: () => void;
    const save = vi.fn(() => new Promise<void>((r) => (release = r)));
    const { saver, statuses } = setup(save);
    saver.update("one");
    const first = saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    saver.update("one two");
    release();
    await first;
    expect(statuses.at(-1)).toBe("saving");
    await vi.advanceTimersByTimeAsync(NOTE_IDLE_MS);
    release();
    await saver.flush();
    expect(save).toHaveBeenLastCalledWith("one two");
    expect(statuses.at(-1)).toBe("saved");
  });
});

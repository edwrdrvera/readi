import { describe, expect, it } from "vitest";
import { nearestLineSpacing } from "./prefs";

describe("nearestLineSpacing", () => {
  it("maps legacy stored values onto the named steps", () => {
    expect([1.3, 1.5, 1.7, 1.9].map(nearestLineSpacing)).toEqual(["tight", "normal", "normal", "loose"]);
    expect([1.4, 1.6, 1.85].map(nearestLineSpacing)).toEqual(["tight", "normal", "loose"]);
  });
});

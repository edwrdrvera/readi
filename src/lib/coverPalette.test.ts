import { describe, expect, it } from "vitest";
import { spineColors } from "./coverPalette";

const px = (...colors: [number, number, number, number][]) => colors.flat();

describe("spineColors", () => {
  it("averages opaque pixels and skips transparent ones", () => {
    expect(spineColors(px([200, 0, 0, 255], [100, 0, 0, 255], [0, 255, 0, 0]))?.bg).toBe("rgb(150 0 0)");
  });
  it("puts light ink on a dark cover and dark ink on a light one", () => {
    expect(spineColors(px([20, 30, 60, 255]))?.ink).toBe("#f5f5f7");
    expect(spineColors(px([240, 230, 210, 255]))?.ink).toBe("#1d1d1f");
  });
  it("returns null when every pixel is transparent", () => {
    expect(spineColors(px([10, 10, 10, 0]))).toBeNull();
  });
});

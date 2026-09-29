import { describe, expect, it } from "vitest";
import { fitScale, pageAt, pageLabel, pageSize, spreadOf, stack, stepSpread, toPdf, toViewport } from "./pdfLayout";

const letter = { view: [0, 0, 612, 792], rotate: 0 };

describe("point transforms", () => {
  it("maps the top-left of an unrotated page to the viewport origin", () => {
    expect(toViewport(letter, 2, 0, 792)).toEqual([0, 0]);
    expect(toViewport(letter, 2, 612, 0)).toEqual([1224, 1584]);
  });

  it("maps a rotated page's top-left corner to the origin", () => {
    const rotated = { view: [0, 0, 612, 792], rotate: 90 };
    expect(toViewport(rotated, 1, 0, 0)).toEqual([0, 0]);
    expect(pageSize(rotated)).toEqual({ width: 792, height: 612 });
  });

  it("round-trips at every rotation and a non-zero origin", () => {
    for (const rotate of [0, 90, 180, 270]) {
      const geom = { view: [10, 20, 400, 700], rotate };
      const [vx, vy] = toViewport(geom, 1.7, 123, 456);
      const [x, y] = toPdf(geom, 1.7, vx, vy);
      expect(x).toBeCloseTo(123);
      expect(y).toBeCloseTo(456);
    }
  });

  it("keeps a point's PDF coordinates when the zoom changes", () => {
    const [vx, vy] = toViewport(letter, 1, 100, 500);
    const [zx, zy] = toViewport(letter, 3, 100, 500);
    expect([zx, zy]).toEqual([vx * 3, vy * 3]);
  });
});

describe("spreads", () => {
  it("shows the first page alone, then consecutive pairs", () => {
    expect(spreadOf(0, "double", 6)).toEqual([0]);
    expect(spreadOf(1, "double", 6)).toEqual([1, 2]);
    expect(spreadOf(2, "double", 6)).toEqual([1, 2]);
    expect(spreadOf(5, "double", 6)).toEqual([5]);
    expect(spreadOf(4, "single", 6)).toEqual([4]);
  });

  it("steps by spread and stops at the ends", () => {
    expect(stepSpread(0, 1, "double", 6)).toBe(1);
    expect(stepSpread(2, 1, "double", 6)).toBe(3);
    expect(stepSpread(2, -1, "double", 6)).toBe(0);
    expect(stepSpread(5, 1, "double", 6)).toBe(5);
    expect(stepSpread(0, -1, "double", 6)).toBe(0);
    expect(stepSpread(3, 1, "single", 6)).toBe(4);
  });
});

describe("fit scale", () => {
  const page = { width: 600, height: 800 };
  it("fits width, page, or uses an explicit scale", () => {
    expect(fitScale("fit-width", [page], { width: 1200, height: 400 }, 0)).toBe(2);
    expect(fitScale("fit-page", [page], { width: 1200, height: 400 }, 0)).toBe(0.5);
    expect(fitScale(1.5, [page], { width: 10, height: 10 }, 0)).toBe(1.5);
  });

  it("fits a two-page spread with its gap", () => {
    expect(fitScale("fit-width", [page, page], { width: 1210, height: 9999 }, 10)).toBe(1);
  });
});

describe("stacking", () => {
  it("places pages with padding and gaps and finds the page at an offset", () => {
    const { tops, total } = stack([100, 200, 100], 10, 5);
    expect(tops).toEqual([10, 115, 320]);
    expect(total).toBe(430);
    expect(pageAt(tops, 0)).toBe(0);
    expect(pageAt(tops, 114)).toBe(0);
    expect(pageAt(tops, 115)).toBe(1);
    expect(pageAt(tops, 10_000)).toBe(2);
  });
});

describe("page label", () => {
  it("shows the printed label only when it differs from the physical number", () => {
    expect(pageLabel(4, 40, ["i", "ii", "iii", "iii", "iv"])).toBe("iv · 5 of 40");
    expect(pageLabel(4, 40, null)).toBe("5 of 40");
    expect(pageLabel(4, 40, ["1", "2", "3", "4", "5"])).toBe("5 of 40");
  });
});

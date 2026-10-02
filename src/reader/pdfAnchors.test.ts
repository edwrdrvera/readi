import { describe, expect, it } from "vitest";
import { pageSegment, pointInQuad, quadPolygon, rectToQuad, segmentOffset, sortKey } from "./pdfAnchors";

describe("pdf text units", () => {
  const items = [
    { str: "Hello", hasEOL: false },
    { str: "world.", hasEOL: false },
    { str: "", hasEOL: true },
    { str: "Next\tline", hasEOL: true },
    { str: "", hasEOL: false },
    { str: "end", hasEOL: false },
  ];

  it("joins items with spaces and breaks lines after hasEOL, including on empty items", () => {
    const { text, mapping } = pageSegment(items);
    expect(text).toBe("Hello world.\nNext line\nend");
    expect(mapping.units).toEqual([
      [0, 0, 5],
      [6, 1, 6],
      [13, 3, 9],
      [23, 5, 3],
    ]);
  });

  it("resolves unit points to segment offsets", () => {
    const { text, mapping } = pageSegment(items);
    const start = segmentOffset(mapping, [1, 0])!;
    const end = segmentOffset(mapping, [3, 4])!;
    expect(text.slice(start, end)).toBe("world.\nNext");
  });

  it("rejects points on empty or unknown items and offsets past a unit's end", () => {
    const { mapping } = pageSegment(items);
    expect(segmentOffset(mapping, [2, 0])).toBeNull();
    expect(segmentOffset(mapping, [9, 0])).toBeNull();
    expect(segmentOffset(mapping, [0, 6])).toBeNull();
  });

  it("gives a page without text an empty segment", () => {
    expect(pageSegment([]).text).toBe("");
    expect(pageSegment([{ str: "", hasEOL: true }]).mapping.units).toEqual([]);
  });
});

describe("quads", () => {
  it("round-trips a viewport rectangle at every rotation and scale", () => {
    for (const rotate of [0, 90, 180, 270]) {
      for (const scale of [0.5, 1, 2.25]) {
        const geom = { view: [10, 20, 400, 700], rotate };
        const r = { left: 30, top: 40, right: 130, bottom: 60 };
        const q = rectToQuad(geom, scale, r);
        const poly = quadPolygon(geom, scale, q);
        const expected = [
          [r.left, r.top],
          [r.right, r.top],
          [r.right, r.bottom],
          [r.left, r.bottom],
        ];
        poly.forEach(([x, y], k) => {
          expect(x).toBeCloseTo(expected[k][0], 6);
          expect(y).toBeCloseTo(expected[k][1], 6);
        });
        // The same quad drawn at another scale lands on the scaled rectangle.
        const [ul] = quadPolygon(geom, scale * 2, q);
        expect(ul[0]).toBeCloseTo(r.left * 2, 6);
        expect(ul[1]).toBeCloseTo(r.top * 2, 6);
      }
    }
  });

  it("stores unrotated quads in PDF space with y up", () => {
    const q = rectToQuad({ view: [0, 0, 612, 792], rotate: 0 }, 2, { left: 0, top: 0, right: 200, bottom: 20 });
    expect(q.map((v) => v + 0)).toEqual([0, 792, 100, 792, 0, 782, 100, 782]);
  });

  it("hit-tests points inside the quad only", () => {
    const q = rectToQuad({ view: [0, 0, 612, 792], rotate: 90 }, 1, { left: 10, top: 10, right: 50, bottom: 30 });
    const [cx, cy] = [(q[0] + q[6]) / 2, (q[1] + q[7]) / 2];
    expect(pointInQuad(q, cx, cy)).toBe(true);
    expect(pointInQuad(q, cx + 100, cy)).toBe(false);
  });

  it("orders keys by page, then from the top of the page down", () => {
    const geom = { view: [0, 0, 612, 792], rotate: 0 };
    expect(sortKey(3, geom, 792)).toBe(3);
    expect(sortKey(3, geom, 396)).toBeCloseTo(3.5);
    expect(sortKey(3, geom, 0)).toBeLessThan(4);
  });
});

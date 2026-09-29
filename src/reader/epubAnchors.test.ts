import { describe, expect, it } from "vitest";
import { buildSegment, type SegmentUnit } from "../lib/textmap";
import { boundQuote, findQuote, offsetOf, pointAt, quoteMatches, QUOTE_MAX_BYTES } from "./epubAnchors";

const units: SegmentUnit[] = [
  { text: "Call me ", sep: "" },
  { text: "Ishmael", sep: "" },
  { text: "", sep: "" },
  { text: ".\tSome years", sep: "" },
  { text: "ago, never mind", sep: "\n" },
];

describe("text mapping round trip", () => {
  const { text, mapping } = buildSegment(units);
  const unitText = (i: number, from: number, to?: number) => units[i].text.slice(from, to).replace(/\s/g, " ");

  it("reads a match spanning units back from its unit points", () => {
    const start = text.indexOf("me Ishmael. Some");
    const end = start + "me Ishmael. Some".length;
    const a = pointAt(mapping, start, "start")!;
    const b = pointAt(mapping, end, "end")!;
    expect(a).toEqual([0, 5]);
    expect(b).toEqual([3, 6]);
    expect(unitText(0, 5) + unitText(1, 0) + unitText(3, 0, 6)).toBe("me Ishmael. Some");
    expect(text.slice(offsetOf(mapping, a)!, offsetOf(mapping, b)!)).toBe("me Ishmael. Some");
  });

  it("snaps offsets on a block separator to the neighboring units", () => {
    const sep = text.indexOf("\n");
    expect(pointAt(mapping, sep, "start")).toEqual([4, 0]);
    expect(pointAt(mapping, sep, "end")).toEqual([3, units[3].text.length]);
  });

  it("rejects points outside a unit or on an empty unit", () => {
    expect(offsetOf(mapping, [2, 0])).toBeNull();
    expect(offsetOf(mapping, [1, 99])).toBeNull();
  });
});

describe("quote and context recovery", () => {
  const text = "The cat sat.\nA dog ran. The cat sat on the mat. Birds sang and the cat sat.";

  it("finds a unique quote despite whitespace differences", () => {
    const m = findQuote(text, "sat.  A dog", null);
    expect(m).toEqual({ start: text.indexOf("sat.\nA"), end: text.indexOf("sat.\nA") + "sat.\nA dog".length });
  });

  it("reports a missing quote", () => {
    expect(findQuote(text, "the horse", "whatever")).toBe("none");
  });

  it("uses context to pick one of several matches", () => {
    const m = findQuote(text, "The cat sat", "A dog ran. The cat sat on the mat.");
    const start = text.indexOf("The cat sat on");
    expect(m).toEqual({ start, end: start + "The cat sat".length });
  });

  it("stays ambiguous when context cannot tell matches apart", () => {
    expect(findQuote("x cat y x cat y", "cat", "x cat y")).toBe("ambiguous");
    expect(findQuote(text, "cat sat", null)).toBe("ambiguous");
  });

  it("bounds quotes and still matches a cut quote as a prefix", () => {
    const long = "word ".repeat(2000);
    const q = boundQuote(long);
    expect(new TextEncoder().encode(q).length).toBeLessThanOrEqual(QUOTE_MAX_BYTES);
    expect(quoteMatches(long, q)).toBe(true);
    expect(quoteMatches("The cat sat on", "The cat")).toBe(false);
  });
});

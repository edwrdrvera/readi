import { describe, expect, it } from "vitest";
import type { TocItem } from "./api";
import { outlineToc } from "./toc";

const toc = (...labels: string[]): TocItem[] => labels.map((label, i) => ({ label, target: String(i), children: [] }));

describe("outlineToc", () => {
  it("splits a flat list into front matter, numbered body, and back matter", () => {
    const items = toc("Title Page", "Chapter 1: The Diary (Part 1)", "Chapter 12: The Summons", "Extra Chapter: A Wild Blade", "Chapter 13: Explanations", "Newsletter");
    const o = outlineToc(items);
    expect(items.map((i) => o.get(i)!.section)).toEqual(["front", "body", "body", "body", "body", "back"]);
    expect(o.get(items[2])).toEqual({ section: "body", number: "12", title: "The Summons" });
    expect(o.get(items[3])).toEqual({ section: "body", number: null, title: "Extra Chapter: A Wild Blade" });
  });

  it("reads roman numerals, bare numbers, and parts", () => {
    const o = outlineToc(toc("Chapter iv. Storm", "3. Harbour", "Part 2"));
    expect([...o.values()].map((e) => [e.number, e.title])).toEqual([["IV", "Storm"], ["3", "Harbour"], ["2", "Part 2"]]);
  });

  it("keeps everything in the body when no entry is numbered", () => {
    const o = outlineToc(toc("Preface", "The Voyage", "Afterword"));
    expect([...o.values()].every((e) => e.section === "body" && e.number === null)).toBe(true);
  });

  it("does not read words that merely start with a numbering keyword as chapters", () => {
    const o = outlineToc(toc("Bookkeeping", "Partings"));
    expect([...o.values()].map((e) => e.number)).toEqual([null, null]);
  });
});

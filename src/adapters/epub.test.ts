import { describe, expect, it, vi } from "vitest";

vi.mock("foliate-js/view.js", () => ({ makeBook: vi.fn() }));
const { epubMetadata } = await import("./epub");

const section = (heading: string | null, linear = "yes") => ({
  linear,
  size: 1,
  createDocument: async () => ({ querySelector: () => (heading ? { textContent: heading } : null) }) as unknown as Document,
});

describe("epubMetadata contents fallback", () => {
  it("lists readable spine sections by index when the book has no navigation", async () => {
    const meta = await epubMetadata({ sections: [section("Opening"), section(null, "no"), section(null)] });
    expect(meta.toc).toEqual([
      { label: "Opening", target: "0", children: [] },
      { label: "Section 2", target: "2", children: [] },
    ]);
  });

  it("keeps nav entries when present", async () => {
    const meta = await epubMetadata({ toc: [{ label: "One", href: "a.xhtml" }], sections: [section("x")] });
    expect(meta.toc).toEqual([{ label: "One", target: "a.xhtml", children: [] }]);
  });
});

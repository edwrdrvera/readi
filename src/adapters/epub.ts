import { makeBook, type FoliateBook, type FoliateTocItem } from "foliate-js/view.js";
import { bookUrl, type ExtractedMetadata, type TextSegment, type TocItem } from "../lib/api";

export const EPUB_EXTRACTOR_VERSION = 1;

export async function loadEpub(id: number, signal?: AbortSignal): Promise<FoliateBook> {
  const res = await fetch(bookUrl(id), { signal });
  if (!res.ok) throw new Error(`Book file unavailable (${res.status})`);
  const file = new File([await res.blob()], `${id}.epub`, { type: "application/epub+zip" });
  return makeBook(file);
}

// foliate returns language maps or contributor objects for some fields.
export function metadataText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(metadataText).filter(Boolean).join(", ") || null;
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if ("name" in v) return metadataText(v.name);
    const first = Object.values(v)[0];
    return metadataText(first);
  }
  return String(value);
}

function authorsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list.map(metadataText).filter((a): a is string => !!a);
}

function convertToc(items: FoliateTocItem[] | undefined): TocItem[] {
  return (items ?? []).map((item) => ({
    label: (item.label ?? "").trim() || "Untitled",
    target: item.href ?? "",
    children: convertToc(item.subitems),
  }));
}

/** Contents from nav/NCX, falling back to a flat list of readable spine sections. */
export async function epubMetadata(book: FoliateBook): Promise<ExtractedMetadata> {
  let toc = convertToc(book.toc);
  if (toc.length === 0) {
    toc = await Promise.all(
      book.sections
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.linear !== "no")
        .map(async ({ s, i }, n) => {
          const doc = await s.createDocument().catch(() => null);
          const heading = doc?.querySelector("h1,h2,h3,title")?.textContent?.trim();
          return { label: heading || `Section ${n + 1}`, target: String(i), children: [] };
        }),
    );
  }
  const m = book.metadata ?? {};
  return {
    title: metadataText(m.title),
    authors: authorsOf(m.author),
    language: metadataText(m.language),
    toc,
  };
}

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

export async function epubText(book: FoliateBook, signal?: AbortSignal): Promise<TextSegment[]> {
  const segments: TextSegment[] = [];
  for (const [order, section] of book.sections.entries()) {
    signal?.throwIfAborted();
    const doc = await section.createDocument();
    const text = doc.body?.textContent ?? "";
    segments.push({ order, label: doc.title || null, text });
    await yieldToUi();
  }
  return segments;
}

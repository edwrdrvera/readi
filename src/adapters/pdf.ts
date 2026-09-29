import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { bookUrl, type ExtractedMetadata, type TextSegment, type TocItem } from "../lib/api";
import { HTTP_FILE_CHANGED, reportFileChanged } from "../lib/fileChanged";
import { pageSegment, type PdfTextItem } from "../reader/pdfAnchors";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export const PDF_EXTRACTOR_VERSION = 2;
const MAX_REQUEST = 4 << 20; // matches the book:// protocol cap

/**
 * Feeds PDF.js byte ranges fetched over book://, so only the parts of a file
 * PDF.js asks for are ever read. Aborting cancels in-flight requests.
 */
class BookRangeTransport extends pdfjs.PDFDataRangeTransport {
  private controller = new AbortController();
  constructor(private id: number, length: number) {
    super(length, null);
  }

  override requestDataRange(begin: number, end: number) {
    void this.fetchRange(begin, end);
  }

  // PDF.js matches a delivery to its request by `begin` and accepts exactly
  // one delivery per request, so ranges above the protocol cap are fetched in
  // pieces and handed over as a single buffer.
  private async fetchRange(begin: number, end: number) {
    const data = new Uint8Array(end - begin);
    try {
      for (let start = begin; start < end; start += MAX_REQUEST) {
        const stop = Math.min(end, start + MAX_REQUEST);
        const res = await fetch(bookUrl(this.id), {
          headers: { Range: `bytes=${start}-${stop - 1}` },
          signal: this.controller.signal,
        });
        if (res.status === HTTP_FILE_CHANGED) reportFileChanged(this.id);
        if (res.status !== 206) throw new Error(`range request failed: ${res.status}`);
        data.set(new Uint8Array(await res.arrayBuffer()), start - begin);
      }
      this.onDataRange(begin, data);
    } catch (e) {
      if (!this.controller.signal.aborted) console.error(e);
    }
  }

  override abort() {
    this.controller.abort();
  }
}

export function loadPdf(id: number, length: number) {
  return pdfjs.getDocument({
    range: new BookRangeTransport(id, length),
    // PDF.js prefetches every top-level /Pages kid, and in a flat page tree
    // each page dict sits between large image streams. Every one of those
    // fetches costs a whole chunk, so a 256 KiB chunk made opening a 600-page,
    // 263 MB PDF read ~158 MB. 16 KiB keeps that walk to a few MB.
    rangeChunkSize: 1 << 14,
    disableAutoFetch: true,
    disableStream: true,
    enableXfa: false,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
  });
}

export type PdfDoc = pdfjs.PDFDocumentProxy;
export type PdfPage = pdfjs.PDFPageProxy;
export const TextLayer = pdfjs.TextLayer;
export type TextLayer = pdfjs.TextLayer;

async function outlineToToc(doc: PdfDoc, items: Awaited<ReturnType<PdfDoc["getOutline"]>> | null | undefined): Promise<TocItem[]> {
  const out: TocItem[] = [];
  for (const item of items ?? []) {
    let page: number | null = null;
    try {
      const dest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
      if (dest?.[0]) page = typeof dest[0] === "number" ? dest[0] : await doc.getPageIndex(dest[0]);
    } catch {
      page = null;
    }
    const children = await outlineToToc(doc, item.items);
    if (page === null && children.length === 0) continue;
    out.push({ label: item.title.trim() || "Untitled", target: String(page ?? children[0].target), children });
  }
  return out;
}

export async function pdfMetadata(doc: PdfDoc): Promise<ExtractedMetadata> {
  const { info } = (await doc.getMetadata().catch(() => ({ info: {} }))) as { info: Record<string, unknown> };
  let toc = await outlineToToc(doc, await doc.getOutline().catch(() => null));
  if (toc.length === 0) {
    const labels = await doc.getPageLabels().catch(() => null);
    toc = Array.from({ length: doc.numPages }, (_, i) => ({
      label: `Page ${labels?.[i] ?? i + 1}`,
      target: String(i),
      children: [],
    }));
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return {
    title: str(info.Title),
    authors: str(info.Author) ? [info.Author as string] : [],
    language: str(info.Language),
    toc,
  };
}

export type PdfTextContent = { items: Array<PdfTextItem & Record<string, unknown>>; styles: Record<string, unknown>; lang: string | null };

/**
 * PDF.js's getTextContent() uses `for await` over a ReadableStream, which
 * WKWebView does not support (TypeError: undefined is not a function), so
 * read the text stream with an explicit reader. Extraction and the text layer
 * both read through here so item indexes agree.
 */
export async function readTextContent(page: PdfPage): Promise<PdfTextContent> {
  const reader = page.streamTextContent().getReader();
  const out: PdfTextContent = { items: [], styles: {}, lang: null };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    const chunk = value as PdfTextContent;
    out.lang ??= chunk.lang;
    Object.assign(out.styles, chunk.styles);
    for (const it of chunk.items) if (typeof it.str === "string") out.items.push({ ...it, str: it.str, hasEOL: !!it.hasEOL });
  }
}

// PDF.js keeps every fetched chunk until its document is destroyed, and text
// extraction fetches whole image XObjects, so a long PDF is extracted through
// a fresh document every PAGES_PER_DOCUMENT pages to bound memory.
const PAGES_PER_DOCUMENT = 50;

export async function pdfText(id: number, length: number, numPages: number, signal?: AbortSignal): Promise<TextSegment[]> {
  const segments: TextSegment[] = [];
  for (let first = 0; first < numPages; first += PAGES_PER_DOCUMENT) {
    const task = loadPdf(id, length);
    try {
      const doc = await task.promise;
      for (let i = first; i < Math.min(numPages, first + PAGES_PER_DOCUMENT); i++) {
        signal?.throwIfAborted();
        const page = await doc.getPage(i + 1);
        segments.push({ order: i, label: null, ...pageSegment((await readTextContent(page)).items) });
        page.cleanup();
      }
    } finally {
      await task.destroy();
    }
  }
  return segments;
}

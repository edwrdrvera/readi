import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { bookUrl } from "../lib/api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

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

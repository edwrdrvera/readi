import { api, type BookSummary } from "./api";
import { epubMetadata, epubText, loadEpub, EPUB_EXTRACTOR_VERSION } from "../adapters/epub";
import { loadPdf, pdfMetadata, pdfText, PDF_EXTRACTOR_VERSION } from "../adapters/pdf";

type Listener = () => void;

/**
 * App-level extraction queue: JavaScript adapters parse, Rust persists.
 * It lives outside the reader so closing a book does not stop indexing.
 * One job runs at a time.
 */
class ExtractionQueue {
  private running = false;
  private firstClaim = true;
  private listeners = new Set<Listener>();

  onChange(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  kick() {
    if (this.running) return;
    this.running = true;
    void this.drain().finally(() => {
      this.running = false;
    });
  }

  private async drain() {
    for (;;) {
      const book = await api.claimExtractionJob(this.firstClaim);
      this.firstClaim = false;
      if (!book) return;
      this.emit();
      try {
        await this.extract(book);
      } catch (e) {
        await api.failExtraction(book.id, e instanceof Error ? e.message : String(e));
      }
      this.emit();
    }
  }

  private async extract(book: BookSummary) {
    if (book.format === "epub") {
      const epub = await loadEpub(book.id);
      await api.submitMetadata(book.id, await epubMetadata(epub));
      this.emit();
      await api.submitText(book.id, EPUB_EXTRACTOR_VERSION, await epubText(epub));
      epub.destroy?.();
    } else {
      const task = loadPdf(book.id, book.file_size);
      let numPages: number;
      try {
        const doc = await task.promise;
        numPages = doc.numPages;
        await api.submitMetadata(book.id, await pdfMetadata(doc));
      } finally {
        await task.destroy();
      }
      this.emit();
      await api.submitText(book.id, PDF_EXTRACTOR_VERSION, await pdfText(book.id, book.file_size, numPages));
    }
  }
}

export const extraction = new ExtractionQueue();

import { loadEpub } from "./epub";
import { loadPdf } from "./pdf";
import type { BookSummary } from "../lib/api";

const MAX_EDGE = 400;
const PDF_RENDER_WIDTH = 360;
const JPEG_QUALITY = 0.8;
const MAX_BYTES = 1 << 20;

type Source = HTMLCanvasElement | ImageBitmap;

function toJpeg(source: Source): Promise<number[]> {
  const scale = Math.min(1, MAX_EDGE / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext("2d")!;
  // JPEG has no alpha; transparent covers would otherwise turn black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error("could not encode cover"));
        if (blob.size > MAX_BYTES) return reject(new Error("cover too large"));
        void blob.arrayBuffer().then((buf) => resolve(Array.from(new Uint8Array(buf))), reject);
      },
      "image/jpeg",
      JPEG_QUALITY,
    ),
  );
}

async function epubCover(id: number): Promise<Source> {
  const book = await loadEpub(id);
  try {
    const blob = await book.getCover?.();
    if (!blob) throw new Error("no cover");
    return await createImageBitmap(blob);
  } finally {
    book.destroy?.();
  }
}

async function pdfCover(id: number, size: number): Promise<Source> {
  const task = loadPdf(id, size);
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PDF_RENDER_WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
    return canvas;
  } finally {
    await task.destroy();
  }
}

/** JPEG bytes for the book's cover, or null when there is none or it cannot be made. */
export async function makeCover(book: BookSummary): Promise<number[] | null> {
  try {
    const source = book.format === "epub" ? await epubCover(book.id) : await pdfCover(book.id, book.file_size);
    const bytes = await toJpeg(source);
    if (source instanceof ImageBitmap) source.close();
    return bytes;
  } catch {
    return null;
  }
}

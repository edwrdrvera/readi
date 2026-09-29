import type { Annotation, SearchHit } from "./api";
import { useApp } from "./store";
import { activeReader, type ReaderHandle } from "../reader/handle";

const READER_WAIT_MS = 15000;

/** The open book's reader once it has registered and restored its position. */
export async function readerFor(bookId: number): Promise<ReaderHandle | null> {
  const start = Date.now();
  while (activeReader()?.bookId !== bookId) {
    if (Date.now() - start > READER_WAIT_MS || useApp.getState().screen.name !== "reader") return null;
    await new Promise((r) => setTimeout(r, 50));
  }
  const reader = activeReader()!;
  await reader.ready;
  return reader;
}

export async function showHit(bookId: number, hit: SearchHit) {
  const reader = await readerFor(bookId);
  if (!reader) return;
  if ((await reader.showHit(hit)) === "approximate") useApp.getState().notify("Opened the section; the exact match could not be located");
}

export async function showAnnotation(a: Annotation) {
  const reader = await readerFor(a.book_id);
  if (!reader) return;
  if ((await reader.showAnnotation(a)) === "approximate") useApp.getState().notify("Opened the section or page; the exact passage could not be located");
}

/** Opens a book from library search, then its hit once the reader is ready. */
export async function openBookAt(bookId: number, hit: SearchHit | null) {
  const current = useApp.getState().screen;
  if (current.name !== "reader" || current.detail.book.id !== bookId) await useApp.getState().openBook(bookId);
  const s = useApp.getState().screen;
  if (hit && s.name === "reader" && s.detail.book.id === bookId) await showHit(bookId, hit);
}

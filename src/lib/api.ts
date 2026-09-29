import { invoke } from "@tauri-apps/api/core";

export type Format = "epub" | "pdf";
export type IndexState = "queued" | "indexing" | "ready" | "no_searchable_text" | "failed";

export type Locator =
  | { format: "epub"; v: 1; cfi: string; section_index: number; section_fraction: number }
  | { format: "pdf"; v: 1; page_index: number; x: number; y: number };

export interface BookSummary {
  id: number;
  sha256: string;
  format: Format;
  title: string;
  authors: string[];
  reading_state: "unread" | "reading" | "finished";
  metadata_ready: boolean;
  index_state: IndexState;
  file_size: number;
  added_at: number;
  opened_at: number | null;
}

export interface TocItem {
  label: string;
  target: string;
  children: TocItem[];
}

export interface Progress {
  locator: Locator;
  percent: number;
  updated_at: number;
}

export interface BookDetail {
  book: BookSummary;
  progress: Progress | null;
  toc: TocItem[];
}

export type ImportOutcome =
  | { status: "imported"; path: string; result: { book: BookSummary; already_in_library: boolean } }
  | { status: "failed"; path: string; reason: string };

export const bookUrl = (id: number) => `book://localhost/${id}`;

export const api = {
  listBooks: () => invoke<BookSummary[]>("list_books"),
  importBooks: (paths: string[]) => invoke<ImportOutcome[]>("import_books", { paths }),
  openBook: (id: number) => invoke<BookDetail>("open_book", { id }),
  saveProgress: (id: number, locator: Locator, percent: number) =>
    invoke<number>("save_progress", { id, locator, percent }),
  transportStats: (id: number) => invoke<{ requests: number; bytes: number }>("transport_stats", { id }),
};

import { invoke } from "@tauri-apps/api/core";

export type Format = "epub" | "pdf";
export type IndexState = "queued" | "indexing" | "ready" | "no_searchable_text" | "failed";

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

export type ImportOutcome =
  | { status: "imported"; path: string; result: { book: BookSummary; already_in_library: boolean } }
  | { status: "failed"; path: string; reason: string };

export const api = {
  importBooks: (paths: string[]) => invoke<ImportOutcome[]>("import_books", { paths }),
};

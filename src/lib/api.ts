import { invoke } from "@tauri-apps/api/core";
import type { Overrides, PrefKey, Prefs } from "./prefs";

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
  /** Derived: at least one location is readable. False means Missing. */
  available: boolean;
  has_cover: boolean;
  /** Manual memberships plus derived watched-folder collections. */
  collection_ids: number[];
}

export type ReadingState = BookSummary["reading_state"];
export type Availability = "available" | "folder_unavailable" | "permission_denied" | "moved";

export interface Location {
  id: number;
  kind: "managed" | "watched";
  path: string;
  watched_folder_id: number | null;
  availability: Availability;
}

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ImportJob {
  id: number;
  source_path: string;
  state: JobState;
  outcome: "imported" | "added_copy" | "already_in_library" | null;
  book_id: number | null;
  error: string | null;
  bytes_done: number;
  bytes_total: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface Collection {
  id: number;
  name: string;
  kind: "manual" | "derived";
  watched_folder_id: number | null;
}

export interface WatchedFolder {
  id: number;
  path: string;
  access_state: "ok" | "unavailable" | "permission_denied";
  last_scan_at: number | null;
  show_collection: boolean;
}

export interface Exclusion {
  watched_folder_id: number;
  folder_path: string;
  sha256: string;
  title: string;
  excluded_at: number;
}

export type SortKey = "recent" | "title" | "author" | "added";

export interface LibraryView {
  sort: SortKey;
  format: Format | null;
  author: string | null;
  reading_state: ReadingState | null;
  availability: "available" | "missing" | null;
  collection_id: number | null;
}

export interface UiSettings {
  library: LibraryView;
  always_show_controls: boolean;
}

/** Backend events. */
export const EVENTS = {
  /** Payload: ImportJob, on every state change and at most every 100 ms of progress. */
  importJob: "import-job",
  /** No payload. Books, locations, collections, or folders changed outside a direct command reply. */
  libraryChanged: "library-changed",
} as const;

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
  locations: Location[];
}

export interface ExtractedMetadata {
  title: string | null;
  authors: string[];
  language: string | null;
  toc: TocItem[];
}

export interface TextSegment {
  order: number;
  label: string | null;
  text: string;
}

export const bookUrl = (id: number) => `book://localhost/${id}`;
export const coverUrl = (id: number) => `book://localhost/${id}/cover`;

export const api = {
  listBooks: () => invoke<BookSummary[]>("list_books"),
  /** Returns the queued jobs at once; progress arrives as EVENTS.importJob. */
  importBooks: (paths: string[]) => invoke<ImportJob[]>("import_books", { paths }),
  listImportJobs: () => invoke<ImportJob[]>("list_import_jobs"),
  cancelImport: (jobId: number) => invoke<void>("cancel_import", { jobId }),
  getLocations: (id: number) => invoke<Location[]>("get_locations", { id }),
  /** Verifies the file's hash matches, then relinks (inside a watched folder) or adds a managed copy. */
  locateBook: (id: number, path: string) => invoke<BookSummary>("locate_book", { id, path }),
  /** Deletes the book's records; excludes its hash from the watched folders it was in. Never touches watched originals. */
  removeBook: (id: number) => invoke<void>("remove_book", { id }),
  /** Deletes only the managed copy; fails if it is the book's only location. */
  removeManagedCopy: (id: number) => invoke<void>("remove_managed_copy", { id }),
  setReadingState: (id: number, state: ReadingState) => invoke<void>("set_reading_state", { id, state }),
  listCollections: () => invoke<Collection[]>("list_collections"),
  createCollection: (name: string) => invoke<Collection>("create_collection", { name }),
  renameCollection: (id: number, name: string) => invoke<void>("rename_collection", { id, name }),
  deleteCollection: (id: number) => invoke<void>("delete_collection", { id }),
  setCollectionMembership: (collectionId: number, bookIds: number[], member: boolean) =>
    invoke<void>("set_collection_membership", { collectionId, bookIds, member }),
  listWatchedFolders: () => invoke<WatchedFolder[]>("list_watched_folders"),
  addWatchedFolder: (path: string) => invoke<WatchedFolder>("add_watched_folder", { path }),
  removeWatchedFolder: (id: number) => invoke<void>("remove_watched_folder", { id }),
  setFolderCollection: (id: number, enabled: boolean) => invoke<void>("set_folder_collection", { id, enabled }),
  rescanWatchedFolders: () => invoke<void>("rescan_watched_folders"),
  listExclusions: () => invoke<Exclusion[]>("list_exclusions"),
  restoreExclusion: (folderId: number, sha256: string) => invoke<void>("restore_exclusion", { folderId, sha256 }),
  getUiSettings: () => invoke<UiSettings>("get_ui_settings"),
  setUiSettings: (settings: UiSettings) => invoke<void>("set_ui_settings", { settings }),
  claimCoverJob: () => invoke<BookSummary | null>("claim_cover_job"),
  /** PNG or JPEG bytes, at most 1 MiB; null records that the book has no cover. */
  submitCover: (id: number, bytes: number[] | null) => invoke<void>("submit_cover", { id, bytes }),
  openBook: (id: number) => invoke<BookDetail>("open_book", { id }),
  saveProgress: (id: number, locator: Locator, percent: number) =>
    invoke<number>("save_progress", { id, locator, percent }),
  claimExtractionJob: (reclaimStale: boolean) =>
    invoke<BookSummary | null>("claim_extraction_job", { reclaimStale }),
  submitMetadata: (id: number, metadata: ExtractedMetadata) => invoke<void>("submit_metadata", { id, metadata }),
  submitText: (id: number, extractorVersion: number, segments: TextSegment[]) =>
    invoke<IndexState>("submit_text", { id, extractorVersion, segments }),
  failExtraction: (id: number, error: string) => invoke<void>("fail_extraction", { id, error }),
  transportStats: (id: number) => invoke<{ requests: number; bytes: number }>("transport_stats", { id }),
  countTextMatches: (id: number, word: string) => invoke<number>("count_text_matches", { id, word }),
  getPrefs: (bookId?: number) => invoke<{ defaults: Prefs; overrides: Overrides }>("get_prefs", { bookId: bookId ?? null }),
  setDefaultPrefs: (prefs: Prefs) => invoke<void>("set_default_prefs", { prefs }),
  setBookPref: <K extends PrefKey>(bookId: number, key: K, value: Prefs[K] | null) =>
    invoke<void>("set_book_pref", { bookId, key, value }),
  resetBookPrefs: (bookId: number) => invoke<void>("reset_book_prefs", { bookId }),
  selftestConfig: () =>
    invoke<{ phase: string; fixtures: string[]; sha256: Record<string, string>; m3: unknown } | null>("selftest_config"),
  selftestReport: (report: unknown) => invoke<void>("selftest_report", { report }),
  selftestLog: (line: string) => invoke<void>("selftest_log", { line }),
};

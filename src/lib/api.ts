import { invoke } from "@tauri-apps/api/core";
import type { TextMapping } from "./textmap";
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
  /** Last saved reading position, 0..1. Null until the book is opened. */
  percent: number | null;
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
  library_layout: LibraryLayout;
}

export type LibraryLayout = "grid" | "shelf";

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
  /** Present from extractor version 2. See lib/textmap.ts. */
  mapping: TextMapping | null;
}

/** A point inside an extraction unit: [unit index, UTF-16 offset in that unit]. See lib/textmap.ts. */
export type UnitPoint = [number, number];

export interface SearchHit {
  /** EPUB section index or zero-based PDF page index. */
  order: number;
  /** Section label, or null for PDF pages. */
  label: string | null;
  /** Matched text as indexed, for verifying the resolved range. */
  match_text: string;
  /** Surrounding text with whitespace collapsed; the match is snippet[match[0]..match[1]] in UTF-16 units. */
  snippet: string;
  snippet_match: [number, number];
  /** Absent when the segment has no usable mapping; the hit then opens its section or page as approximate. */
  range: { start: UnitPoint; end: UnitPoint } | null;
}

export interface SearchGroup {
  order: number;
  label: string | null;
  hits: SearchHit[];
}

export interface BookSearch {
  /** The book's index state when the search ran. Only "ready" means an empty result is "no matches". */
  index_state: IndexState;
  groups: SearchGroup[];
  /** More hits exist than were returned. */
  truncated: boolean;
}

export interface LibraryBookResult {
  book: BookSummary;
  /** Title or an author matched every query term. */
  metadata_match: boolean;
  /** Up to 3 text hits, best first. */
  hits: SearchHit[];
}

export interface LibrarySearch {
  /** Metadata matches first, then text relevance. */
  results: LibraryBookResult[];
  /** Books whose index is queued or indexing, so text results may be incomplete. */
  indexing: number;
  /** Books with no searchable text (for example image-only PDFs). */
  no_text: number;
  failed: number;
}

export type HighlightColor = "yellow" | "green" | "blue" | "pink";
export const HIGHLIGHT_COLORS: HighlightColor[] = ["yellow", "green", "blue", "pink"];

/** Where an annotation points. Bookmarks use "position"; highlights use a range. */
export type Anchor =
  | { type: "position"; locator: Locator }
  | { type: "epub_range"; v: 1; cfi: string; section_index: number }
  | { type: "pdf_quads"; v: 1; page_index: number; quads: Array<[number, number, number, number, number, number, number, number]> };

/** "unknown" until the reader has tried to resolve it this session or before. */
export type AnchorState = "unknown" | "resolved" | "unresolved";

export interface Annotation {
  id: number;
  book_id: number;
  kind: "highlight" | "bookmark";
  anchor: Anchor;
  quote: string | null;
  context: string | null;
  color: HighlightColor | null;
  note: string | null;
  /** Reading order: section or page index plus the fraction within it. */
  sort_key: number;
  anchor_state: AnchorState;
  created_at: number;
  updated_at: number;
}

export interface NewAnnotation {
  book_id: number;
  kind: Annotation["kind"];
  anchor: Anchor;
  quote: string | null;
  context: string | null;
  color: HighlightColor | null;
  note: string | null;
  sort_key: number;
}

/** Fields to change. `note: null` clears the note; an absent key leaves it. */
export interface AnnotationPatch {
  color?: HighlightColor;
  note?: string | null;
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
  restoreExclusion: (folderPath: string, sha256: string) => invoke<void>("restore_exclusion", { folderPath, sha256 }),
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
  /** Requeues a failed extraction job. */
  retryExtraction: (id: number) => invoke<void>("retry_extraction", { id }),
  /** Queues a rebuild of the book's text index; progress and annotations are untouched. */
  reindexBook: (id: number) => invoke<void>("reindex_book", { id }),
  searchBook: (id: number, query: string) => invoke<BookSearch>("search_book", { id, query }),
  searchLibrary: (query: string) => invoke<LibrarySearch>("search_library", { query }),
  listAnnotations: (bookId: number) => invoke<Annotation[]>("list_annotations", { bookId }),
  createAnnotation: (annotation: NewAnnotation) => invoke<Annotation>("create_annotation", { annotation }),
  updateAnnotation: (id: number, patch: AnnotationPatch) => invoke<Annotation>("update_annotation", { id, patch }),
  deleteAnnotation: (id: number) => invoke<void>("delete_annotation", { id }),
  setAnchorStates: (states: Array<[number, AnchorState]>) => invoke<void>("set_anchor_states", { states }),
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

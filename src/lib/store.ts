import { create } from "zustand";
import {
  api,
  type Annotation,
  type AnnotationPatch,
  type BookDetail,
  type BookSummary,
  type Collection,
  type Exclusion,
  type ImportJob,
  type LibraryView,
  type Location,
  type HighlightColor,
  type ReadingState,
  type UiSettings,
  type WatchedFolder,
} from "./api";
import { extraction } from "./extraction";
import { onFileChanged } from "./fileChanged";
import { upsertJob } from "./jobs";
import { DEFAULT_VIEW, effectiveView, hasFilters, matchesView } from "./libraryView";
import { DEFAULT_PREFS, type Overrides, type PrefKey, type Prefs } from "./prefs";
import type { SaveStatus } from "./progress";
import { applyAnchorStates, byReadingOrder } from "./annotations";
import { dropNote, flushNotes } from "./notes";
import { createScheduler, UNDO_MS, type HoldReason, type PendingAction } from "./pending";
import { activeReader, type SelectionInfo } from "../reader/handle";

export const DEFAULT_UI_SETTINGS: UiSettings = { library: DEFAULT_VIEW, always_show_controls: false };

/** The action the Undo bar shows, with its message worked out while the item was still listed. */
export interface Pending {
  action: PendingAction;
  message: string;
}

export type CollectionEditor = { mode: "create"; addBookIds: number[] } | { mode: "rename"; collectionId: number };

const CANCELLED_NOTICE_MS = 4000;

export type SidebarTab = "contents" | "annotations" | "search";

type Page = { name: "library" } | { name: "reader"; detail: BookDetail };
/** Settings remembers the page it covers; a reader underneath stays mounted at its position. */
export type Screen = Page | { name: "settings"; back: Page };

/** Where the open reader is, for the Contents sidebar. */
export interface ReaderPosition {
  tocHref: string | null;
  sectionIndex: number | null;
}

/** The open book's last reported position, for the reader footer and PDF contents. */
export interface ReadingProgress {
  percent: number | null;
  pdfPage: number | null;
  /** PDF page label from pageLabel(), e.g. "iv · 3 of 48". */
  pdfPageLabel: string | null;
}

interface AppState {
  screen: Screen;
  books: BookSummary[];
  notices: string[];
  saveStatus: SaveStatus | null;
  defaults: Prefs;
  /** Overrides of the open book; empty in the Library. */
  overrides: Overrides;
  sidebar: { open: boolean; pinned: boolean; tab: SidebarTab };
  /** The open book's annotations in reading order. */
  annotations: Annotation[];
  /** The reader's current text selection, while the highlight popover is up. */
  selection: SelectionInfo | null;
  /** The annotation whose editor is open. */
  editingId: number | null;
  /** The search field: the Library's search and actions, or the reader's actions. */
  search: { open: boolean; query: string };
  /** The open book's search query, kept while the sidebar closes for a jump. */
  bookQuery: string;
  aaOpen: boolean;
  position: ReaderPosition;
  progress: ReadingProgress;
  jobs: Record<number, ImportJob>;
  /** import_books calls not yet answered, shown as "Preparing import…". */
  pendingImports: number;
  collections: Collection[];
  folders: WatchedFolder[];
  exclusions: Exclusion[];
  uiSettings: UiSettings;
  focusedBookId: number | null;
  /** Locations per book, loaded on demand and cleared when the library changes. */
  locations: Record<number, Location[]>;
  infoBookId: number | null;
  pending: Pending | null;
  collectionEditor: CollectionEditor | null;
  refreshBooks(): Promise<void>;
  /** Books, collections, folders, and exclusions, after any backend-side change. */
  refreshLibrary(): Promise<void>;
  receiveJob(job: ImportJob): void;
  loadJobs(): Promise<void>;
  dismissJob(id: number): void;
  cancelImport(id: number): Promise<void>;
  setPendingImports(delta: number): void;
  loadUiSettings(): Promise<void>;
  setUiSettings(patch: Partial<UiSettings>): Promise<void>;
  setView(patch: Partial<LibraryView>): Promise<void>;
  /** Scrolls to and rings a book, resetting filters that hide it. */
  focusBook(id: number): void;
  loadLocations(id: number): Promise<Location[]>;
  showBookInfo(id: number | null): void;
  /** Hides the item now and runs the action when the Undo bar goes away. */
  schedule(action: PendingAction): void;
  undo(): void;
  /** Runs the waiting action now; the window calls this before closing. */
  flushPending(): Promise<void>;
  holdPending(reason: HoldReason, on: boolean): void;
  setCollectionEditor(e: CollectionEditor | null): void;
  setReadingState(id: number, state: ReadingState): Promise<void>;
  setMembership(collectionId: number, bookIds: number[], member: boolean): Promise<void>;
  /** Returns the backend's error text when the file does not match. */
  locateBook(id: number, path: string): Promise<string | null>;
  /** Both return the backend's error text, or null once saved. */
  createCollection(name: string, addBookIds: number[]): Promise<string | null>;
  renameCollection(id: number, name: string): Promise<string | null>;
  addFolder(path: string): Promise<void>;
  setFolderCollection(id: number, enabled: boolean): Promise<void>;
  rescan(): Promise<void>;
  restoreExclusion(e: Exclusion): Promise<void>;
  /** Runs a library mutation, then refreshes; failures become a notice. */
  mutate(label: string, fn: () => Promise<unknown>): Promise<boolean>;
  openBook(id: number): Promise<void>;
  /** Flushes the open reader's progress before leaving it. */
  closeBook(): Promise<void>;
  notify(message: string): void;
  setSaveStatus(s: SaveStatus | null): void;
  loadDefaults(): Promise<void>;
  setDefault<K extends PrefKey>(key: K, value: Prefs[K]): Promise<void>;
  /** Writes a per-book override for the open book; null clears it. */
  setOverride<K extends PrefKey>(key: K, value: Prefs[K] | null): Promise<void>;
  resetOverrides(): Promise<void>;
  setSidebar(s: Partial<AppState["sidebar"]>): void;
  openSettings(): void;
  /** Back to the page Settings covered. */
  closeSettings(): void;
  /** Leaves Settings for the Library, closing a book it covered. */
  showLibrary(): Promise<void>;
  setAaOpen(open: boolean): void;
  setPosition(p: ReaderPosition): void;
  setProgress(p: Partial<ReadingProgress>): void;
  setSelection(s: SelectionInfo | null): void;
  /** Editing opens the Annotations tab; closing the card closes a sidebar that editing opened. */
  setEditing(id: number | null): void;
  setSearch(patch: Partial<AppState["search"]>): void;
  setBookQuery(q: string): void;
  loadAnnotations(bookId: number): Promise<void>;
  /** Draws the open book's highlights and persists how each resolved. */
  redrawHighlights(): Promise<void>;
  /** Highlights the current selection; returns the new annotation. */
  addHighlight(color: HighlightColor): Promise<Annotation | null>;
  addBookmark(): Promise<void>;
  /** Throws on failure so note editors can keep their draft. */
  updateAnnotation(id: number, patch: AnnotationPatch): Promise<void>;
}

/**
 * Lists as the backend last returned them. The store shows them minus items whose
 * removal is waiting in the Undo bar or still committing.
 */
const raw = { books: [] as BookSummary[], collections: [] as Collection[], folders: [] as WatchedFolder[] };
let hidden: PendingAction[] = [];
const hides = (kind: PendingAction["kind"], id: number) =>
  hidden.some(
    (a) =>
      a.kind === kind &&
      ((a.kind === "remove-book" && a.bookId === id) ||
        (a.kind === "delete-collection" && a.collectionId === id) ||
        (a.kind === "remove-folder" && a.folderId === id) ||
        (a.kind === "delete-annotation" && a.annotationId === id)),
  );
const visible = () => ({
  books: raw.books.filter((b) => !hides("remove-book", b.id)),
  collections: raw.collections.filter((c) => !hides("delete-collection", c.id)),
  folders: raw.folders.filter((f) => !hides("remove-folder", f.id)),
});
const visibleAnnotations = (list: Annotation[]) => list.filter((a) => !hides("delete-annotation", a.id));
/** Annotations taken out of the list while their deletion waits, to put back on undo. */
const stashedAnnotations = new Map<number, Annotation>();

let sidebarOpenedForNote = false;

const quoted = (s: string) => `“${s}”`;

function undoMessage(a: PendingAction, s: AppState): string {
  switch (a.kind) {
    case "remove-book":
      return `Removed ${quoted(raw.books.find((b) => b.id === a.bookId)?.title ?? "the book")} from the library`;
    case "delete-copy":
      return `Deleted the managed copy of ${quoted(raw.books.find((b) => b.id === a.bookId)?.title ?? "the book")}`;
    case "delete-collection":
      return `Deleted ${quoted(raw.collections.find((c) => c.id === a.collectionId)?.name ?? "the collection")}`;
    case "remove-folder":
      return `Removed folder ${quoted(raw.folders.find((f) => f.id === a.folderId)?.path ?? "")}`;
    case "delete-annotation":
      return s.annotations.find((x) => x.id === a.annotationId)?.kind === "bookmark" ? "Deleted the bookmark" : "Deleted the highlight";
  }
}

/** The book in the reader, including one Settings covers. */
export const readerDetail = (screen: Screen) =>
  screen.name === "reader" ? screen.detail : screen.name === "settings" && screen.back.name === "reader" ? screen.back.detail : null;
const openBookId = (s: AppState) => readerDetail(s.screen)?.book.id ?? null;

export const useApp = create<AppState>((set, get) => ({
  screen: { name: "library" },
  books: [],
  notices: [],
  saveStatus: null,
  defaults: DEFAULT_PREFS,
  overrides: {},
  sidebar: { open: false, pinned: false, tab: "contents" },
  annotations: [],
  selection: null,
  editingId: null,
  search: { open: false, query: "" },
  bookQuery: "",
  aaOpen: false,
  position: { tocHref: null, sectionIndex: null },
  progress: { percent: null, pdfPage: null, pdfPageLabel: null },
  jobs: {},
  pendingImports: 0,
  collections: [],
  folders: [],
  exclusions: [],
  uiSettings: DEFAULT_UI_SETTINGS,
  focusedBookId: null,
  locations: {},
  infoBookId: null,
  pending: null,
  collectionEditor: null,
  async refreshBooks() {
    raw.books = await api.listBooks();
    set({ books: visible().books });
  },
  async refreshLibrary() {
    try {
      const [books, collections, folders, exclusions] = await Promise.all([
        api.listBooks(),
        api.listCollections(),
        api.listWatchedFolders(),
        api.listExclusions(),
      ]);
      Object.assign(raw, { books, collections, folders });
      set({ ...visible(), exclusions, locations: {} });
    } catch (e) {
      get().notify(`Could not load the library: ${e}`);
    }
  },
  receiveJob(job) {
    const prev = get().jobs[job.id];
    const jobs = upsertJob(get().jobs, job);
    if (jobs === get().jobs) return;
    set({ jobs });
    if (prev?.state === job.state) return;
    if (job.state === "cancelled") setTimeout(() => get().dismissJob(job.id), CANCELLED_NOTICE_MS);
    if (job.state !== "done") return;
    extraction.kick();
    void get()
      .refreshLibrary()
      .then(() => {
        if (job.outcome !== "already_in_library" || job.book_id === null) return;
        const book = get().books.find((b) => b.id === job.book_id);
        get().focusBook(job.book_id);
        get().notify(`“${book?.title ?? job.source_path.split("/").pop()}” is already in the library`);
      });
  },
  async loadJobs() {
    try {
      (await api.listImportJobs()).forEach(get().receiveJob);
    } catch (e) {
      // Polled while imports run; events still deliver job updates.
      console.warn("list_import_jobs failed", e);
    }
  },
  dismissJob(id) {
    const { [id]: _, ...jobs } = get().jobs;
    set({ jobs });
  },
  async cancelImport(id) {
    try {
      await api.cancelImport(id);
    } catch (e) {
      get().notify(`Could not cancel: ${e}`);
    }
  },
  setPendingImports(delta) {
    set((s) => ({ pendingImports: Math.max(0, s.pendingImports + delta) }));
  },
  async loadUiSettings() {
    try {
      set({ uiSettings: await api.getUiSettings() });
    } catch (e) {
      get().notify(`Could not load library settings: ${e}`);
    }
  },
  async setUiSettings(patch) {
    const previous = get().uiSettings;
    const uiSettings = { ...previous, ...patch };
    set({ uiSettings });
    try {
      await api.setUiSettings(uiSettings);
    } catch (e) {
      set({ uiSettings: previous });
      get().notify(`Could not save settings: ${e}`);
    }
  },
  setView(patch) {
    return get().setUiSettings({ library: { ...get().uiSettings.library, ...patch } });
  },
  focusBook(id) {
    set({ focusedBookId: id });
    const book = get().books.find((b) => b.id === id);
    const view = effectiveView(get().uiSettings.library);
    if (!book || matchesView(book, view)) return;
    const onlyNav = view.collection_id === null && !hasFilters(view);
    void get().setView({ ...DEFAULT_VIEW, sort: view.sort, format: book.format });
    if (!onlyNav) get().notify(`Filters were cleared to show “${book.title}”`);
  },
  async loadLocations(id) {
    const locations = await api.getLocations(id);
    set((s) => ({ locations: { ...s.locations, [id]: locations } }));
    return locations;
  },
  showBookInfo(infoBookId) {
    set(infoBookId === null ? { infoBookId } : { infoBookId, focusedBookId: infoBookId });
    if (infoBookId !== null) void get().loadLocations(infoBookId).catch((e) => get().notify(`Could not load locations: ${e}`));
  },
  schedule(action) {
    const message = undoMessage(action, get());
    hidden.push(action);
    if (action.kind === "delete-annotation") {
      const a = get().annotations.find((x) => x.id === action.annotationId);
      if (a) stashedAnnotations.set(a.id, a);
      if (get().editingId === action.annotationId) get().setEditing(null);
      set({ annotations: visibleAnnotations(get().annotations) });
      void get().redrawHighlights();
    } else {
      if (action.kind === "remove-book" && get().infoBookId === action.bookId) set({ infoBookId: null });
      if (action.kind === "delete-collection" && get().uiSettings.library.collection_id === action.collectionId) void get().setView({ collection_id: null });
      set(visible());
    }
    scheduler.schedule({ action, message });
  },
  undo() {
    const p = get().pending;
    scheduler.undo();
    if (!p) return;
    hidden = hidden.filter((a) => a !== p.action);
    if (p.action.kind !== "delete-annotation") return set(visible());
    const a = stashedAnnotations.get(p.action.annotationId);
    stashedAnnotations.delete(p.action.annotationId);
    if (!a || openBookId(get()) !== a.book_id) return;
    set({ annotations: byReadingOrder([...get().annotations, a]) });
    void get().redrawHighlights();
  },
  flushPending() {
    return scheduler.flush();
  },
  holdPending(reason, on) {
    scheduler.hold(reason, on);
  },
  setCollectionEditor(collectionEditor) {
    set({ collectionEditor });
  },
  async mutate(label, fn) {
    try {
      await fn();
      return true;
    } catch (e) {
      get().notify(`${label}: ${e}`);
      return false;
    } finally {
      await get().refreshLibrary();
    }
  },
  async setReadingState(id, state) {
    await get().mutate("Could not change reading state", () => api.setReadingState(id, state));
    const s = get().screen;
    const book = get().books.find((b) => b.id === id);
    if (s.name === "reader" && s.detail.book.id === id && book) set({ screen: { name: "reader", detail: { ...s.detail, book } } });
  },
  async setMembership(collectionId, bookIds, member) {
    await get().mutate("Could not change the collection", () => api.setCollectionMembership(collectionId, bookIds, member));
  },
  async locateBook(id, path) {
    try {
      await api.locateBook(id, path);
    } catch (e) {
      return String(e);
    }
    await get().refreshLibrary();
    await get().loadLocations(id).catch(() => {});
    return null;
  },
  async createCollection(name, addBookIds) {
    try {
      const c = await api.createCollection(name);
      if (addBookIds.length > 0) await api.setCollectionMembership(c.id, addBookIds, true);
      return null;
    } catch (e) {
      return String(e);
    } finally {
      await get().refreshLibrary();
    }
  },
  async renameCollection(id, name) {
    try {
      await api.renameCollection(id, name);
      return null;
    } catch (e) {
      return String(e);
    } finally {
      await get().refreshLibrary();
    }
  },
  async addFolder(path) {
    await get().mutate("Could not add the folder", () => api.addWatchedFolder(path));
  },
  async setFolderCollection(id, enabled) {
    await get().mutate("Could not change the folder", () => api.setFolderCollection(id, enabled));
  },
  async rescan() {
    await get().mutate("Could not rescan", () => api.rescanWatchedFolders());
  },
  async restoreExclusion(e) {
    await get().mutate("Could not restore the book", () => api.restoreExclusion(e.folder_path, e.sha256));
  },
  async openBook(id) {
    const known = get().books.find((b) => b.id === id);
    if (known?.available === false) return get().showBookInfo(id);
    try {
      await Promise.all([activeReader()?.flush(), flushNotes()]);
      // Prefs load before the reader mounts so it lays out once, in the right mode.
      const [detail, prefs] = await Promise.all([api.openBook(id), api.getPrefs(id)]);
      if (detail.book.available === false) {
        set((s) => ({ locations: { ...s.locations, [id]: detail.locations } }));
        return get().showBookInfo(id);
      }
      set({
        screen: { name: "reader", detail },
        saveStatus: null,
        defaults: prefs.defaults,
        overrides: prefs.overrides,
        position: { tocHref: null, sectionIndex: null },
        progress: { percent: detail.progress?.percent ?? null, pdfPage: null, pdfPageLabel: null },
        focusedBookId: id,
        annotations: [],
        selection: null,
        editingId: null,
        bookQuery: "",
        search: { open: false, query: "" },
      });
      void get().loadAnnotations(id);
    } catch (e) {
      get().notify(`Could not open book: ${e}`);
    }
  },
  async closeBook() {
    await Promise.all([activeReader()?.flush(), flushNotes()]);
    set({
      screen: { name: "library" },
      overrides: {},
      sidebar: { ...get().sidebar, open: false },
      annotations: [],
      selection: null,
      editingId: null,
      search: { open: false, query: "" },
    });
    void get().refreshLibrary();
  },
  notify(message) {
    set((s) => ({ notices: [...s.notices.slice(-4), message] }));
    setTimeout(() => set((s) => ({ notices: s.notices.filter((n) => n !== message) })), 6000);
  },
  setSaveStatus(saveStatus) {
    set({ saveStatus });
  },
  async loadDefaults() {
    try {
      set({ defaults: (await api.getPrefs()).defaults });
    } catch (e) {
      get().notify(`Could not load settings: ${e}`);
    }
  },
  async setDefault(key, value) {
    const previous = get().defaults;
    const defaults = { ...previous, [key]: value };
    set({ defaults });
    try {
      await api.setDefaultPrefs(defaults);
    } catch (e) {
      set({ defaults: previous });
      get().notify(`Could not save settings: ${e}`);
    }
  },
  async setOverride(key, value) {
    const id = openBookId(get());
    if (id === null) return;
    const previous = get().overrides;
    const overrides = { ...previous };
    if (value === null) delete overrides[key];
    else overrides[key] = value;
    set({ overrides });
    try {
      await api.setBookPref(id, key, value);
    } catch (e) {
      if (openBookId(get()) === id) set({ overrides: previous });
      get().notify(`Could not save this book’s settings: ${e}`);
    }
  },
  async resetOverrides() {
    const id = openBookId(get());
    if (id === null) return;
    const previous = get().overrides;
    set({ overrides: {} });
    try {
      await api.resetBookPrefs(id);
    } catch (e) {
      if (openBookId(get()) === id) set({ overrides: previous });
      get().notify(`Could not reset this book’s settings: ${e}`);
    }
  },
  setSidebar(s) {
    const sidebar = { ...get().sidebar, ...s };
    if (!sidebar.open || sidebar.tab !== "annotations") {
      sidebarOpenedForNote = false;
      return set({ sidebar, editingId: null });
    }
    set({ sidebar });
  },
  openSettings() {
    const screen = get().screen;
    if (screen.name !== "settings") set({ screen: { name: "settings", back: screen }, aaOpen: false });
  },
  closeSettings() {
    const screen = get().screen;
    if (screen.name === "settings") set({ screen: screen.back });
  },
  async showLibrary() {
    const screen = get().screen;
    if (screen.name !== "settings") return;
    if (screen.back.name === "reader") {
      set({ screen: screen.back });
      await get().closeBook();
    } else set({ screen: screen.back });
  },
  setAaOpen(aaOpen) {
    set({ aaOpen });
  },
  setPosition(position) {
    set({ position });
  },
  setProgress(p) {
    set({ progress: { ...get().progress, ...p } });
  },
  setSelection(selection) {
    set({ selection });
  },
  setEditing(editingId) {
    const { sidebar } = get();
    if (editingId !== null) {
      if (get().editingId === null) sidebarOpenedForNote = !sidebar.open;
      return set({ editingId, sidebar: { ...sidebar, open: true, tab: "annotations" } });
    }
    if (sidebarOpenedForNote && !sidebar.pinned) set({ sidebar: { ...sidebar, open: false } });
    sidebarOpenedForNote = false;
    set({ editingId });
  },
  setSearch(patch) {
    set({ search: { ...get().search, ...patch } });
  },
  setBookQuery(bookQuery) {
    set({ bookQuery });
  },
  async loadAnnotations(bookId) {
    try {
      const list = await api.listAnnotations(bookId);
      if (openBookId(get()) !== bookId) return;
      set({ annotations: visibleAnnotations(byReadingOrder(list)) });
      await get().redrawHighlights();
    } catch (e) {
      get().notify(`Could not load annotations: ${e}`);
    }
  },
  async redrawHighlights() {
    const id = openBookId(get());
    const reader = activeReader();
    if (id === null || reader?.bookId !== id) return;
    let states;
    try {
      await reader.ready;
      states = await reader.setAnnotations(get().annotations.filter((a) => a.kind === "highlight"));
    } catch (e) {
      return get().notify(`Could not draw highlights: ${e}`);
    }
    if (openBookId(get()) !== id || states.length === 0) return;
    set({ annotations: applyAnchorStates(get().annotations, states) });
    try {
      await api.setAnchorStates(states);
    } catch (e) {
      console.warn("set_anchor_states failed", e);
    }
  },
  async addHighlight(color) {
    const sel = get().selection;
    const id = openBookId(get());
    if (!sel || id === null) return null;
    try {
      const a = await api.createAnnotation({
        book_id: id,
        kind: "highlight",
        anchor: sel.anchor,
        quote: sel.quote,
        context: sel.context,
        color,
        note: null,
        sort_key: sel.sort_key,
      });
      activeReader()?.clearSelection();
      set({ selection: null, annotations: byReadingOrder([...get().annotations, a]) });
      await get().redrawHighlights();
      return a;
    } catch (e) {
      get().notify(`Could not add the highlight: ${e}`);
      return null;
    }
  },
  async addBookmark() {
    const id = openBookId(get());
    const reader = activeReader();
    if (id === null || reader?.bookId !== id) return;
    const at = reader.bookmark();
    if (!at) return get().notify("Could not add a bookmark here");
    try {
      const a = await api.createAnnotation({ book_id: id, kind: "bookmark", anchor: at.anchor, quote: at.quote, context: null, color: null, note: null, sort_key: at.sort_key });
      set({ annotations: byReadingOrder([...get().annotations, a]) });
      get().notify("Bookmark added");
    } catch (e) {
      get().notify(`Could not add the bookmark: ${e}`);
    }
  },
  async updateAnnotation(id, patch) {
    const a = await api.updateAnnotation(id, patch);
    set({ annotations: get().annotations.map((x) => (x.id === id ? a : x)) });
    if (patch.color !== undefined) await get().redrawHighlights();
  },
}));

// A crash while the Undo bar is up means the action never ran: the item comes back, which is the safe way to fail.
const scheduler = createScheduler<Pending>({
  ms: UNDO_MS,
  onChange: (pending) => useApp.setState({ pending }),
  async commit({ action: a }) {
    const { mutate } = useApp.getState();
    try {
      switch (a.kind) {
        case "remove-book":
          await mutate("Could not remove the book", () => api.removeBook(a.bookId));
          return;
        case "delete-copy":
          await mutate("Could not delete the managed copy", () => api.removeManagedCopy(a.bookId));
          return;
        case "delete-collection":
          await mutate("Could not delete the collection", () => api.deleteCollection(a.collectionId));
          return;
        case "remove-folder":
          await mutate("Could not remove the folder", () => api.removeWatchedFolder(a.folderId));
          return;
        case "delete-annotation":
          try {
            await api.deleteAnnotation(a.annotationId);
            dropNote(a.annotationId);
          } catch (e) {
            useApp.getState().notify(`Could not delete: ${e}`);
            const stashed = stashedAnnotations.get(a.annotationId);
            const s = useApp.getState();
            if (stashed && openBookId(s) === stashed.book_id) {
              useApp.setState({ annotations: byReadingOrder([...s.annotations, stashed]) });
              void s.redrawHighlights();
            }
          }
          stashedAnnotations.delete(a.annotationId);
          return;
      }
    } finally {
      hidden = hidden.filter((x) => x !== a);
      if (a.kind !== "delete-annotation") useApp.setState(visible());
    }
  },
});

onFileChanged((bookId) => {
  const s = useApp.getState();
  if (openBookId(s) !== bookId) return;
  s.notify("This file changed on disk. Readi is checking it again.");
  void s.closeBook();
});

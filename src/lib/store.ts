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
import { DEFAULT_VIEW, matchesView } from "./libraryView";
import { DEFAULT_PREFS, type Overrides, type PrefKey, type Prefs } from "./prefs";
import type { SaveStatus } from "./progress";
import { applyAnchorStates, byReadingOrder } from "./annotations";
import { dropNote, flushNotes } from "./notes";
import { activeReader, type SelectionInfo } from "../reader/handle";

export const DEFAULT_UI_SETTINGS: UiSettings = { library: DEFAULT_VIEW, always_show_controls: false };

/** A destructive action waiting for explicit confirmation. */
export type Confirmation =
  | { kind: "remove-book"; bookId: number }
  | { kind: "delete-copy"; bookId: number }
  | { kind: "delete-collection"; collectionId: number }
  | { kind: "remove-folder"; folderId: number };

export type CollectionEditor = { mode: "create"; addBookIds: number[] } | { mode: "rename"; collectionId: number };

const CANCELLED_NOTICE_MS = 4000;

export type SidebarTab = "contents" | "annotations" | "search";

type Screen = { name: "library" } | { name: "reader"; detail: BookDetail };

/** Where the open reader is, for the Contents sidebar. */
export interface ReaderPosition {
  tocHref: string | null;
  sectionIndex: number | null;
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
  librarySearchOpen: boolean;
  /** The open book's search query, kept while the sidebar closes for a jump. */
  bookQuery: string;
  settingsOpen: boolean;
  aaOpen: boolean;
  position: ReaderPosition;
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
  confirmation: Confirmation | null;
  collectionEditor: CollectionEditor | null;
  paletteOpen: boolean;
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
  setConfirmation(c: Confirmation | null): void;
  setCollectionEditor(e: CollectionEditor | null): void;
  setPaletteOpen(open: boolean): void;
  setReadingState(id: number, state: ReadingState): Promise<void>;
  setMembership(collectionId: number, bookIds: number[], member: boolean): Promise<void>;
  /** Returns the backend's error text when the file does not match. */
  locateBook(id: number, path: string): Promise<string | null>;
  createCollection(name: string, addBookIds: number[]): Promise<void>;
  renameCollection(id: number, name: string): Promise<void>;
  /** Carries out the pending confirmation. */
  confirm(): Promise<void>;
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
  setSettingsOpen(open: boolean): void;
  setAaOpen(open: boolean): void;
  setPosition(p: ReaderPosition): void;
  setSelection(s: SelectionInfo | null): void;
  setEditing(id: number | null): void;
  setLibrarySearchOpen(open: boolean): void;
  setBookQuery(q: string): void;
  loadAnnotations(bookId: number): Promise<void>;
  /** Draws the open book's highlights and persists how each resolved. */
  redrawHighlights(): Promise<void>;
  /** Highlights the current selection; returns the new annotation. */
  addHighlight(color: HighlightColor): Promise<Annotation | null>;
  addBookmark(): Promise<void>;
  /** Throws on failure so note editors can keep their draft. */
  updateAnnotation(id: number, patch: AnnotationPatch): Promise<void>;
  deleteAnnotation(id: number): Promise<void>;
}

const openBookId = (s: AppState) => (s.screen.name === "reader" ? s.screen.detail.book.id : null);

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
  librarySearchOpen: false,
  bookQuery: "",
  settingsOpen: false,
  aaOpen: false,
  position: { tocHref: null, sectionIndex: null },
  jobs: {},
  pendingImports: 0,
  collections: [],
  folders: [],
  exclusions: [],
  uiSettings: DEFAULT_UI_SETTINGS,
  focusedBookId: null,
  locations: {},
  infoBookId: null,
  confirmation: null,
  collectionEditor: null,
  paletteOpen: false,
  async refreshBooks() {
    set({ books: await api.listBooks() });
  },
  async refreshLibrary() {
    try {
      const [books, collections, folders, exclusions] = await Promise.all([
        api.listBooks(),
        api.listCollections(),
        api.listWatchedFolders(),
        api.listExclusions(),
      ]);
      set({ books, collections, folders, exclusions, locations: {} });
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
    const view = get().uiSettings.library;
    if (book && !matchesView(book, view)) {
      void get().setView({ ...DEFAULT_VIEW, sort: view.sort });
      get().notify(`Filters were cleared to show “${book.title}”`);
    }
  },
  async loadLocations(id) {
    const locations = await api.getLocations(id);
    set((s) => ({ locations: { ...s.locations, [id]: locations } }));
    return locations;
  },
  showBookInfo(infoBookId) {
    set({ infoBookId });
    if (infoBookId !== null) void get().loadLocations(infoBookId).catch((e) => get().notify(`Could not load locations: ${e}`));
  },
  setConfirmation(confirmation) {
    set({ confirmation });
    // The removal copy depends on where the book's files are.
    if (confirmation?.kind === "remove-book" || confirmation?.kind === "delete-copy") void get().loadLocations(confirmation.bookId).catch(() => {});
  },
  setCollectionEditor(collectionEditor) {
    set({ collectionEditor });
  },
  setPaletteOpen(paletteOpen) {
    set({ paletteOpen });
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
    await get().mutate("Could not create the collection", async () => {
      const c = await api.createCollection(name);
      if (addBookIds.length > 0) await api.setCollectionMembership(c.id, addBookIds, true);
    });
  },
  async renameCollection(id, name) {
    await get().mutate("Could not rename the collection", () => api.renameCollection(id, name));
  },
  async confirm() {
    const c = get().confirmation;
    set({ confirmation: null });
    if (!c) return;
    const { mutate } = get();
    switch (c.kind) {
      case "remove-book":
        if (get().infoBookId === c.bookId) set({ infoBookId: null });
        await mutate("Could not remove the book", () => api.removeBook(c.bookId));
        return;
      case "delete-copy":
        await mutate("Could not delete the managed copy", () => api.removeManagedCopy(c.bookId));
        return;
      case "delete-collection":
        if (get().uiSettings.library.collection_id === c.collectionId) void get().setView({ collection_id: null });
        await mutate("Could not delete the collection", () => api.deleteCollection(c.collectionId));
        return;
      case "remove-folder":
        await mutate("Could not remove the folder", () => api.removeWatchedFolder(c.folderId));
        return;
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
        aaOpen: false,
        focusedBookId: id,
        annotations: [],
        selection: null,
        editingId: null,
        bookQuery: "",
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
      aaOpen: false,
      sidebar: { ...get().sidebar, open: false },
      annotations: [],
      selection: null,
      editingId: null,
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
    set({ sidebar: { ...get().sidebar, ...s } });
  },
  setSettingsOpen(settingsOpen) {
    set({ settingsOpen });
  },
  setAaOpen(aaOpen) {
    set({ aaOpen });
  },
  setPosition(position) {
    set({ position });
  },
  setSelection(selection) {
    set({ selection });
  },
  setEditing(editingId) {
    set({ editingId });
  },
  setLibrarySearchOpen(librarySearchOpen) {
    set({ librarySearchOpen });
  },
  setBookQuery(bookQuery) {
    set({ bookQuery });
  },
  async loadAnnotations(bookId) {
    try {
      const list = await api.listAnnotations(bookId);
      if (openBookId(get()) !== bookId) return;
      set({ annotations: byReadingOrder(list) });
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
  async deleteAnnotation(id) {
    try {
      await api.deleteAnnotation(id);
    } catch (e) {
      return get().notify(`Could not delete: ${e}`);
    }
    dropNote(id);
    set({ annotations: get().annotations.filter((a) => a.id !== id), editingId: get().editingId === id ? null : get().editingId });
    await get().redrawHighlights();
  },
}));

onFileChanged((bookId) => {
  const s = useApp.getState();
  if (openBookId(s) !== bookId) return;
  s.notify("This file changed on disk. Readi is checking it again.");
  void s.closeBook();
});

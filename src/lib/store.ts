import { create } from "zustand";
import { api, type BookDetail, type BookSummary } from "./api";
import { DEFAULT_PREFS, type Overrides, type PrefKey, type Prefs } from "./prefs";
import type { SaveStatus } from "./progress";
import { activeReader } from "../reader/handle";

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
  sidebar: { open: boolean; pinned: boolean };
  settingsOpen: boolean;
  aaOpen: boolean;
  position: ReaderPosition;
  refreshBooks(): Promise<void>;
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
}

const openBookId = (s: AppState) => (s.screen.name === "reader" ? s.screen.detail.book.id : null);

export const useApp = create<AppState>((set, get) => ({
  screen: { name: "library" },
  books: [],
  notices: [],
  saveStatus: null,
  defaults: DEFAULT_PREFS,
  overrides: {},
  sidebar: { open: false, pinned: false },
  settingsOpen: false,
  aaOpen: false,
  position: { tocHref: null, sectionIndex: null },
  async refreshBooks() {
    set({ books: await api.listBooks() });
  },
  async openBook(id) {
    try {
      await activeReader()?.flush();
      // Prefs load before the reader mounts so it lays out once, in the right mode.
      const [detail, prefs] = await Promise.all([api.openBook(id), api.getPrefs(id)]);
      set({
        screen: { name: "reader", detail },
        saveStatus: null,
        defaults: prefs.defaults,
        overrides: prefs.overrides,
        position: { tocHref: null, sectionIndex: null },
        aaOpen: false,
      });
    } catch (e) {
      get().notify(`Could not open book: ${e}`);
    }
  },
  async closeBook() {
    await activeReader()?.flush();
    set({ screen: { name: "library" }, overrides: {}, aaOpen: false, sidebar: { ...get().sidebar, open: false } });
    void get().refreshBooks();
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
}));

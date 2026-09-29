import { create } from "zustand";
import { api, type BookDetail, type BookSummary } from "./api";
import type { SaveStatus } from "./progress";

type Screen = { name: "library" } | { name: "reader"; detail: BookDetail };

interface AppState {
  screen: Screen;
  books: BookSummary[];
  notices: string[];
  saveStatus: SaveStatus | null;
  refreshBooks(): Promise<void>;
  openBook(id: number): Promise<void>;
  closeBook(): void;
  notify(message: string): void;
  setSaveStatus(s: SaveStatus | null): void;
}

export const useApp = create<AppState>((set, get) => ({
  screen: { name: "library" },
  books: [],
  notices: [],
  saveStatus: null,
  async refreshBooks() {
    set({ books: await api.listBooks() });
  },
  async openBook(id) {
    try {
      set({ screen: { name: "reader", detail: await api.openBook(id) }, saveStatus: null });
    } catch (e) {
      get().notify(`Could not open book: ${e}`);
    }
  },
  closeBook() {
    set({ screen: { name: "library" } });
    void get().refreshBooks();
  },
  notify(message) {
    set((s) => ({ notices: [...s.notices.slice(-4), message] }));
    setTimeout(() => set((s) => ({ notices: s.notices.filter((n) => n !== message) })), 6000);
  },
  setSaveStatus(saveStatus) {
    set({ saveStatus });
  },
}));

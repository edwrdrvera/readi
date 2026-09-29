import { create } from "zustand";
import { api, type BookSummary } from "./api";

interface AppState {
  books: BookSummary[];
  notices: string[];
  refreshBooks(): Promise<void>;
  notify(message: string): void;
}

export const useApp = create<AppState>((set) => ({
  books: [],
  notices: [],
  async refreshBooks() {
    set({ books: await api.listBooks() });
  },
  notify(message) {
    set((s) => ({ notices: [...s.notices.slice(-4), message] }));
    setTimeout(() => set((s) => ({ notices: s.notices.filter((n) => n !== message) })), 6000);
  },
}));

import type { Locator } from "../lib/api";

/** What the app shell (and the packaged self test) can ask of an open reader. */
export interface ReaderHandle {
  /** The book this handle belongs to, so callers never act on a previous book's reader. */
  bookId: number;
  ready: Promise<void>;
  location(): Locator | null;
  next(): Promise<void>;
  prev(): Promise<void>;
  goTo(target: string | number): Promise<void>;
  flush(): Promise<void>;
  /** Present for EPUB so checks can reach the rendered section documents. */
  documents?(): Document[];
}

let active: ReaderHandle | null = null;
export const setActiveReader = (h: ReaderHandle | null) => {
  active = h;
};
export const activeReader = () => active;

import type { Locator } from "../lib/api";

/** How a restore landed. "approximate" is disclosed to the user. */
export type RestoreQuality = "exact" | "approximate";

/** What the app shell (and the packaged self test) can ask of an open reader. */
export interface ReaderHandle {
  /** The book this handle belongs to, so callers never act on a previous book's reader. */
  bookId: number;
  /** Reading direction of the book. PDFs are always ltr. */
  dir(): "ltr" | "rtl";
  /** Resolves once the initial position is restored and visible. */
  ready: Promise<void>;
  location(): Locator | null;
  /** Logical next/previous page or viewport, in reading order. */
  next(): Promise<void>;
  prev(): Promise<void>;
  /** Physical left/right, mapped through the reading direction. */
  goLeft(): Promise<void>;
  goRight(): Promise<void>;
  /** Small scroll step for Up/Down. No-op in horizontal mode. */
  scrollBy(dir: 1 | -1): void;
  /** A contents target: EPUB href or section index, PDF zero-based page index. Records Back history. */
  goTo(target: string | number): Promise<void>;
  /** Restores a stored locator without recording history, as Back does. */
  goToLocator(locator: Locator): Promise<RestoreQuality>;
  /**
   * Resolves after the reader has finished laying out for the current prefs
   * and window size, with the previously visible passage back in view.
   */
  settled(): Promise<void>;
  /** Text at the start of the visible passage (EPUB) or `p<page>@<x>,<y>` in PDF points. */
  anchor(): string;
  /** True when an anchor from an earlier `anchor()` call is still in view. */
  isVisible(anchor: string): boolean;
  flush(): Promise<void>;
  /** Present for EPUB so checks can reach the rendered section documents. */
  documents?(): Document[];
}

let active: ReaderHandle | null = null;
export const setActiveReader = (h: ReaderHandle | null) => {
  active = h;
};
export const activeReader = () => active;

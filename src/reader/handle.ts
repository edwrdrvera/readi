import type { Anchor, AnchorState, Annotation, Locator, SearchHit } from "../lib/api";

/** How a restore landed. "approximate" is disclosed to the user. */
export type RestoreQuality = "exact" | "approximate";

/** A text selection ready to become a highlight. */
export interface SelectionInfo {
  anchor: Anchor;
  quote: string;
  /** Nearby text for quote and context recovery. */
  context: string;
  sort_key: number;
  /** Selection bounds in the app window's coordinates, for placing the highlight popover. */
  rect: { x: number; y: number; width: number; height: number };
}

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
  /**
   * Opens a search hit's exact range and marks it, recording Back history.
   * "approximate" when the range did not resolve to the hit's text and only
   * its section or page opened.
   */
  showHit(hit: SearchHit): Promise<RestoreQuality>;
  /** Opens an annotation's range or position, recording Back history. */
  showAnnotation(a: Annotation): Promise<RestoreQuality>;
  /** Calls back with the current selection whenever it changes, or null when it clears. */
  onSelection(cb: (s: SelectionInfo | null) => void): () => void;
  clearSelection(): void;
  /** Anchor, sort key, and a short quote of the visible text for a bookmark at the current position. */
  bookmark(): { anchor: Anchor; quote: string | null; sort_key: number } | null;
  /**
   * Draws these highlights and replaces any drawn before. Resolves with each
   * highlight's resolution: "unresolved" when neither its stored range nor a
   * unique quote/context match within its section or page was found.
   */
  setAnnotations(list: Annotation[]): Promise<Array<[number, AnchorState]>>;
  /** Present for EPUB so checks can reach the rendered section documents. */
  documents?(): Document[];
}

let active: ReaderHandle | null = null;
export const setActiveReader = (h: ReaderHandle | null) => {
  active = h;
};
export const activeReader = () => active;


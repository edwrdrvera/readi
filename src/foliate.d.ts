declare module "foliate-js/view.js" {
  export interface FoliateTocItem {
    label?: string;
    href?: string;
    subitems?: FoliateTocItem[];
  }
  export interface FoliateSection {
    id?: string;
    linear?: string;
    size: number;
    createDocument(): Promise<Document>;
  }
  export interface FoliateBook {
    metadata?: { title?: unknown; author?: unknown; language?: unknown };
    toc?: FoliateTocItem[];
    sections: FoliateSection[];
    dir?: string;
    splitTOCHref?(href: string): unknown;
    getCover?(): Promise<Blob | null> | Blob | null;
    destroy?(): void;
  }
  export interface RelocateDetail {
    cfi: string;
    fraction: number;
    section: { current: number; total: number };
    location?: { current: number; total: number };
    tocItem?: { label?: string; href?: string };
    range?: Range;
  }
  export function makeBook(file: File | string): Promise<FoliateBook>;
  export class View extends HTMLElement {
    book: FoliateBook;
    renderer: HTMLElement & {
      setAttribute(name: string, value: string): void;
      setStyles?(css: string): void;
      getContents?(): Array<{ doc: Document | null; index: number }>;
      goTo(target: { index: number; anchor?: number }): Promise<void>;
      next(distance?: number): Promise<void>;
      prev(distance?: number): Promise<void>;
      readonly start: number;
      readonly end: number;
      readonly viewSize: number;
      readonly scrolled: boolean;
    };
    lastLocation?: RelocateDetail;
    open(book: FoliateBook | File): Promise<void>;
    init(opts: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>;
    goTo(target: string | number): Promise<unknown>;
    goToFraction(frac: number): Promise<void>;
    resolveNavigation(target: string | number): { index: number } | undefined;
    getCFI(index: number, range: Range): string;
    getSectionFractions(): number[];
    next(): Promise<void>;
    prev(): Promise<void>;
    goLeft(): Promise<void>;
    goRight(): Promise<void>;
    close(): void;
  }
}

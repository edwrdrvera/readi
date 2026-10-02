/**
 * Reading preferences. Settings holds a complete set of defaults; each book
 * stores only the keys the user changed while reading it. Resetting a book
 * deletes its overrides.
 */

export type ThemePref = "system" | "light" | "dark" | "sepia";
export type Theme = Exclude<ThemePref, "system">;
export type ReadingMode = "vertical" | "horizontal";
/** EPUB: one or two columns. PDF: single page or two-page spread. */
export type Spread = "single" | "double";
export type FontFamily = "publisher" | "serif" | "sans";
/** A number is a scale relative to the page's natural size (1 = 72 dpi). */
export type PdfZoom = "fit-width" | "fit-page" | number;
export type PdfEffect = "none" | "sepia" | "invert";
export type PageWidth = "narrow" | "medium" | "wide";
export type TextAlign = "left" | "justify";

export interface Prefs {
  reading_mode: ReadingMode;
  spread: Spread;
  theme: ThemePref;
  font_family: FontFamily;
  /** CSS px. */
  font_size: number;
  line_height: number;
  pdf_zoom: PdfZoom;
  pdf_effect: PdfEffect;
  page_width: PageWidth;
  text_align: TextAlign;
}

export type PrefKey = keyof Prefs;
export type Overrides = Partial<Prefs>;

export const DEFAULT_PREFS: Prefs = {
  reading_mode: "horizontal",
  spread: "single",
  theme: "system",
  font_family: "publisher",
  font_size: 18,
  line_height: 1.6,
  pdf_zoom: "fit-page",
  pdf_effect: "none",
  page_width: "medium",
  text_align: "left",
};

export const FONT_SIZE = { min: 12, max: 36, step: 2 } as const;
export const LINE_HEIGHTS = { tight: 1.4, normal: 1.6, loose: 1.85 } as const;
export type LineSpacing = keyof typeof LINE_HEIGHTS;

/** Nearest named step, so values stored before the named steps still select one. */
export const nearestLineSpacing = (value: number): LineSpacing =>
  (Object.keys(LINE_HEIGHTS) as LineSpacing[]).reduce((best, k) =>
    Math.abs(LINE_HEIGHTS[k] - value) <= Math.abs(LINE_HEIGHTS[best] - value) ? k : best,
  );

export const PAGE_WIDTHS: Record<PageWidth, number> = { narrow: 520, medium: 620, wide: 760 };
export const PDF_SCALE = { min: 0.25, max: 5, factor: 1.2 } as const;

export const resolvePrefs = (defaults: Prefs, overrides: Overrides): Prefs => ({ ...defaults, ...overrides });

export const resolveTheme = (pref: ThemePref, systemDark: boolean): Theme =>
  pref === "system" ? (systemDark ? "dark" : "light") : pref;

export const THEME_COLORS: Record<Theme, { bg: string; fg: string; link: string }> = {
  light: { bg: "#ffffff", fg: "#1d1d1f", link: "#0a60c9" },
  dark: { bg: "#1c1c1e", fg: "#e5e5ea", link: "#64a8ff" },
  sepia: { bg: "#f4ecd8", fg: "#5b4636", link: "#8a4b12" },
};

export const stepFontSize = (size: number, dir: 1 | -1) =>
  Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, size + dir * FONT_SIZE.step));

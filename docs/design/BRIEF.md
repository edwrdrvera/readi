# Design adoption brief

Source of truth: `docs/design/prototype.html` (the design team's clickable mock; the `<x-dc>` markup is the layout, the `Component.renderVals` script at the bottom is the behavior and the token table `T`). Build the real app to match it. The theme tokens in `src/styles.css` already equal `T` exactly; do not change them.

Mock surfaces map onto existing real data. Where the mock shows fake data, use the real thing. Where the app has a real feature the mock omits, keep it and style it in the mock's idiom (segmented controls, 11px muted section labels, 13px body, 6px radii).

## Data shape changes (do these first, one commit)

1. `BookSummary.percent: number | null` (0..1), from `progress.percent` joined in `SUMMARY_SELECT` (`src-tauri/src/db.rs`, `model.rs`, `src/lib/api.ts`). Add a Rust test.
2. Two new reading prefs, string enums so the existing `book_preferences` column machinery in `src-tauri/src/prefs.rs` works unchanged:
   - `page_width: "narrow" | "medium" | "wide"` (default `"medium"`), maps to 520 / 620 / 760 px.
   - `text_align: "left" | "justify"` (default `"left"`).
   Add to `Prefs` with `#[serde(default)]` so stored v1 defaults JSON (which lacks them) still parses; add to `Overrides`, `PrefKey` (+ `ALL`, `column`), and a new migration `ALTER TABLE book_preferences ADD COLUMN page_width TEXT; ... text_align TEXT;`. Extend the prefs tests (round trip, invalid values, v1 JSON without the keys still loads the user's other values). Mirror in `src/lib/prefs.ts`.
3. Line spacing becomes the mock's three named steps: `LINE_HEIGHTS = { tight: 1.4, normal: 1.6, loose: 1.85 }`; default 1.6 in Rust and TS. The segmented control highlights the nearest step so old stored values (1.3, 1.5, 1.7, 1.9) still show a selection.

## Library (mock: LIBRARY / DRAWER)

- Window: `titleBarStyle: "Overlay"`, `hiddenTitle: true` in `src-tauri/tauri.conf.json` so the real traffic lights sit where the mock draws them. Do not draw fake traffic lights. Every 52px top bar gets `data-tauri-drag-region` and leaves ~72px left padding for the lights where the mock has them (sidebar header; reader toolbar).
- Sidebar (220px, `bg-muted`, right border): 52px drag header, "Readi" 11px label, nav rows 30px: **Library** (EPUBs, count) and **Drawer** (PDFs, count). Implement as `LibraryView.format` = `"epub"` / `"pdf"` with `collection_id: null`. Then "Collections" label with the existing manual collections (keep the + button and the per-row actions menu) and "Folders" (derived). Active row `bg-accent text-accent-foreground`.
- Top bar 52px, bottom border: title (15px semibold: Library / Drawer / collection name), a 220px search field that opens the existing `LibrarySearch` (it is a button styled as the field), dark-mode toggle (sun/moon; toggles `defaults.theme` between light and dark), Import (+, `pickAndImport`), and keep the Settings gear (the mock has nowhere else for global settings).
- Filters and sort: keep them, as one compact row under the top bar at the grid's 40px gutter. Drop the Format filter (the nav now owns format).
- Library body (padding 28/40/40): "Continue reading" card (520px, border, `bg-popover`, 64x96 cover, title, `author · chapter` → use author only, progress bar 4px, `NN% ` label) for the most recently opened book with `reading_state === "reading"`; hidden when none. Then "All books" and a 6-column grid (`gap 32px 28px`, responsive: `repeat(auto-fill, minmax(140px, 1fr))` is fine below 6). Cover: 2/3, radius 3px, the mock's two-layer shadow; fallback tint cover shows title top (serif 14px semibold) and author bottom (10px, .85 opacity). Under the cover: title 12px/500 single-line ellipsis, meta 11px muted = `NN%` when reading, `Finished`, or `New` when unread. Keep Missing / index-state badges, context menu, and the hover actions button.
- Drawer body: the mock's table. Columns Name / Progress / Size / Added (no page count is stored; Progress replaces Pages). 44px rows, bottom borders, the small red "PDF" file glyph. Rows keep the same context menu as cards, open on click, and keyboard focus behavior of `BookCard` (`focusedBookId`).

## Reader (mock: READER)

- Toolbar: 52px, `bg-chrome`, bottom border, drag region. Order: back chevron (aria-label "Back to library"), TOC toggle (panel icon, `bg-muted` when open), Back-history button (keep), centered `Title — section label` (section label from the active TOC item; omit the dash when none), search, bookmark, `Aa` (serif text, `bg-muted` when the panel is open), Settings gear. Keep the auto-hide behavior and `always_show_controls`, save-error Retry, and every existing `aria-label`, `title`, and `data-testid` (the packaged self-tests in `src/selftest*.ts` drive them; grep before renaming anything).
- Left panel (existing `ReaderSidebar`, 240px): the mock's segmented tabs (`bg-muted` track is not in the mock; the mock uses active = `bg-popover`, inactive = transparent + muted text). Keep the three real tabs Contents / Annotations / Search, pin and close. TOC rows per mock: 13px, 7/10 padding, active `bg-accent`, page number right in 11px muted.
- Right panel: replace the `Aa` popover with a docked 272px panel (left border, `bg-background`, padding 18/18/24, 22px gaps), toggled by `Aa`, state in the store alongside `aaOpen` (reuse `aaOpen`). Sections, in mock order: Appearance (Light / Sepia / Dark swatches with "Aa" in each theme's reader colors, 2px primary ring on the active one; add a fourth "Auto" swatch for `system`, split light/dark), Font (Serif / Sans / Original = `publisher`), Text size (A – bar – A, step via `stepFontSize`, bar = position in `FONT_SIZE` range, `NN px` label), Line spacing, Page width, Scroll direction (Paged = `horizontal`, Scroll = `vertical`, the mock's radio cards), Pages (Single / Two-up, keep), Justify text switch. For PDFs show Scroll direction, Pages, Appearance, then PDF zoom and PDF page effect instead of the text sections. Keep per-book semantics: every control writes an override; show the "This book" marker + "Use default" per row and a "Reset to defaults" button at the bottom.
- Page: EPUB honors `page_width` via foliate's `max-inline-size` attribute on the renderer (in `applyLayout`, same unchanged-value guard) and `text_align` via `readerCss` (`p { text-align: justify; hyphens: auto }`).
- Paged mode (`reading_mode === "horizontal"`): 56px prev/next arrow buttons on both sides of the page, muted, calling `activeReader()?.goLeft()/goRight()`.
- Footer 36px, 11px muted: left label (`Page N of M` for PDF; section label for EPUB), 3px progress bar, `NN%`. Source the percent from the reader's save path (`useSaver` / store) rather than polling.

## Constraints

- Tailwind classes, the existing `cn`, lucide icons, shadcn `ui/*` primitives. No inline style objects except dynamic values (tints, widths).
- Keep existing keyboard commands and the command palette working (`src/lib/commands.ts`).
- Comments only for non-obvious why.
- Green before done: `pnpm tsc --noEmit`, `pnpm test`, `cargo test` in `src-tauri`, `pnpm build`.

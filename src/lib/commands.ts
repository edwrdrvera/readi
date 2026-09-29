import type { Format } from "./api";
import { backHistory } from "./history";
import { pickAndImport } from "./importing";
import { PDF_SCALE, resolvePrefs, stepFontSize, type PrefKey, type Prefs, type Theme } from "./prefs";
import { useApp } from "./store";
import { activeReader, type ReaderHandle } from "../reader/handle";

export interface CommandContext {
  screen: "library" | "reader";
  format: Format | null;
  bookId: number | null;
  /** The open book's reader, once it has registered. */
  reader: ReaderHandle | null;
  prefs: Prefs;
}

/** `key` is KeyboardEvent.key, compared case-insensitively. */
export interface Shortcut {
  key: string;
  meta?: boolean;
  shift?: boolean;
}

export interface Command {
  id: string;
  label: string;
  shortcuts: Shortcut[];
  /** Plain navigation keys that a focused control (button, radio group) may own. */
  yieldsToControls?: boolean;
  when(ctx: CommandContext): boolean;
  run(ctx: CommandContext): void | Promise<void>;
}

export function commandContext(): CommandContext {
  const s = useApp.getState();
  const detail = s.screen.name === "reader" ? s.screen.detail : null;
  const reader = activeReader();
  return {
    screen: s.screen.name,
    format: detail?.book.format ?? null,
    bookId: detail?.book.id ?? null,
    reader: detail && reader?.bookId === detail.book.id ? reader : null,
    prefs: resolvePrefs(s.defaults, s.overrides),
  };
}

/** In the reader a preference change applies to the open book; in the Library, to the defaults. */
function setPref<K extends PrefKey>(ctx: CommandContext, key: K, value: Prefs[K]) {
  const s = useApp.getState();
  return ctx.screen === "reader" ? s.setOverride(key, value) : s.setDefault(key, value);
}

const inReader = (ctx: CommandContext) => ctx.reader !== null;

function pdfZoomStep(ctx: CommandContext, dir: 1 | -1): number {
  const z = ctx.prefs.pdf_zoom;
  const current = typeof z === "number" ? z : Number(document.querySelector<HTMLElement>(".pdf-host")?.dataset.scale) || 1;
  const next = dir > 0 ? current * PDF_SCALE.factor : current / PDF_SCALE.factor;
  return Math.round(Math.min(PDF_SCALE.max, Math.max(PDF_SCALE.min, next)) * 1000) / 1000;
}

function sizeStep(ctx: CommandContext, dir: 1 | -1) {
  if (ctx.format === "pdf") return setPref(ctx, "pdf_zoom", pdfZoomStep(ctx, dir));
  return setPref(ctx, "font_size", stepFontSize(ctx.prefs.font_size, dir));
}

export async function goBack(ctx: CommandContext = commandContext()) {
  if (!ctx.reader || ctx.bookId === null) return;
  const loc = backHistory.pop(ctx.bookId);
  if (loc) await ctx.reader.goToLocator(loc);
}

const readingRegion = () => document.querySelector<HTMLElement>("[data-reading-region]");

let sidebarOpener: HTMLElement | null = null;

export function openSidebar(opener: Element | null = document.activeElement) {
  sidebarOpener = opener instanceof HTMLElement ? opener : null;
  useApp.getState().setSidebar({ open: true });
}

export function closeSidebar() {
  useApp.getState().setSidebar({ open: false });
  const target = sidebarOpener?.isConnected ? sidebarOpener : readingRegion();
  sidebarOpener = null;
  requestAnimationFrame(() => target?.focus());
}

const themeCommand = (theme: Theme, n: number): Command => ({
  id: `theme.${theme}`,
  label: `${theme[0].toUpperCase()}${theme.slice(1)} theme`,
  shortcuts: [{ key: String(n), meta: true }],
  when: () => true,
  run: (ctx) => setPref(ctx, "theme", theme),
});

export const commands: Command[] = [
  { id: "library.import", label: "Import…", shortcuts: [{ key: "o", meta: true }], when: () => true, run: () => pickAndImport() },
  {
    id: "library.return",
    label: "Return to Library",
    shortcuts: [],
    when: (ctx) => ctx.screen === "reader",
    run: () => useApp.getState().closeBook(),
  },
  {
    id: "sidebar.toggle",
    label: "Toggle Contents",
    shortcuts: [{ key: "\\", meta: true }],
    when: (ctx) => ctx.screen === "reader",
    run: () => (useApp.getState().sidebar.open ? closeSidebar() : openSidebar()),
  },
  { id: "nav.left", label: "Page left", shortcuts: [{ key: "ArrowLeft" }], yieldsToControls: true, when: inReader, run: (c) => c.reader!.goLeft() },
  { id: "nav.right", label: "Page right", shortcuts: [{ key: "ArrowRight" }], yieldsToControls: true, when: inReader, run: (c) => c.reader!.goRight() },
  { id: "nav.up", label: "Scroll up", shortcuts: [{ key: "ArrowUp" }], yieldsToControls: true, when: inReader, run: (c) => c.reader!.scrollBy(-1) },
  { id: "nav.down", label: "Scroll down", shortcuts: [{ key: "ArrowDown" }], yieldsToControls: true, when: inReader, run: (c) => c.reader!.scrollBy(1) },
  { id: "nav.next", label: "Next page", shortcuts: [{ key: " " }], yieldsToControls: true, when: inReader, run: (c) => c.reader!.next() },
  { id: "nav.prev", label: "Previous page", shortcuts: [{ key: " ", shift: true }], yieldsToControls: true, when: inReader, run: (c) => c.reader!.prev() },
  {
    id: "nav.back",
    label: "Back",
    shortcuts: [{ key: "[", meta: true }],
    when: (ctx) => inReader(ctx) && backHistory.size(ctx.bookId!) > 0,
    run: (ctx) => goBack(ctx),
  },
  {
    id: "mode.toggle",
    label: "Toggle vertical/horizontal",
    shortcuts: [{ key: "v", meta: true, shift: true }],
    when: () => true,
    run: (ctx) => setPref(ctx, "reading_mode", ctx.prefs.reading_mode === "vertical" ? "horizontal" : "vertical"),
  },
  themeCommand("light", 1),
  themeCommand("dark", 2),
  themeCommand("sepia", 3),
  {
    id: "text.bigger",
    label: "Larger text or zoom in",
    shortcuts: [{ key: "=", meta: true }, { key: "+", meta: true }, { key: "+", meta: true, shift: true }],
    when: inReader,
    run: (ctx) => sizeStep(ctx, 1),
  },
  {
    id: "text.smaller",
    label: "Smaller text or zoom out",
    shortcuts: [{ key: "-", meta: true }],
    when: inReader,
    run: (ctx) => sizeStep(ctx, -1),
  },
  {
    id: "ui.dismiss",
    label: "Dismiss",
    shortcuts: [{ key: "Escape" }],
    // Popovers and sheets dismiss themselves and mark the event handled.
    when: (ctx) => ctx.screen === "reader" && useApp.getState().sidebar.open && !useApp.getState().sidebar.pinned,
    run: () => closeSidebar(),
  },
];

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
const CONTROLS = "button, a[href], [role=radiogroup], [role=group], [role=dialog], [role=tree], summary";

const matches = (s: Shortcut, e: KeyboardEvent) =>
  s.key.toLowerCase() === e.key.toLowerCase() && !!s.meta === e.metaKey && !!s.shift === e.shiftKey && !e.ctrlKey && !e.altKey;

/**
 * The single keydown handler. Also receives keydown from EPUB section
 * documents, whose targets live in another realm, so checks avoid instanceof.
 */
export function handleKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return;
  const target = e.target as Element | null;
  if (target?.closest?.(EDITABLE)) return;
  const ctx = commandContext();
  const command = commands.find((c) => c.shortcuts.some((s) => matches(s, e)) && c.when(ctx));
  if (!command) return;
  if (command.yieldsToControls && target?.closest?.(CONTROLS)) return;
  e.preventDefault();
  void Promise.resolve(command.run(ctx)).catch((err) => useApp.getState().notify(`${command.label} failed: ${err}`));
}

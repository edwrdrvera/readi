import type { Format } from "./api";
import { backHistory } from "./history";
import { pickAndImport } from "./importing";
import { PDF_SCALE, resolvePrefs, stepFontSize, type PrefKey, type Prefs, type ThemePref } from "./prefs";
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
  /**
   * The native menu item owns this chord as its accelerator, so handleKeydown
   * skips it. Whether WebKit also delivers keydown for a menu key equivalent is
   * unreliable, and running from both paths would fire the command twice.
   */
  viaMenu?: boolean;
}

export interface Command {
  id: string;
  label: string;
  shortcuts: Shortcut[];
  /** Plain navigation keys that a focused control (button, radio group) may own. */
  yieldsToControls?: boolean;
  /** False keeps a command out of the palette. */
  palette?: boolean;
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

const themeCommand = (theme: ThemePref, n: number | null): Command => ({
  id: `theme.${theme}`,
  label: theme === "system" ? "Follow System theme" : `${theme[0].toUpperCase()}${theme.slice(1)} theme`,
  shortcuts: n === null ? [] : [{ key: String(n), meta: true, viaMenu: true }],
  when: () => true,
  run: (ctx) => setPref(ctx, "theme", theme),
});

let paletteOpener: HTMLElement | null = null;

export function openPalette(opener: Element | null = document.activeElement) {
  paletteOpener = opener instanceof HTMLElement ? opener : null;
  useApp.getState().setPaletteOpen(true);
}

/** Focus target when the palette closes. */
export function takePaletteOpener(): HTMLElement | null {
  const target = paletteOpener?.isConnected ? paletteOpener : readingRegion();
  paletteOpener = null;
  return target;
}

export const commands: Command[] = [
  {
    id: "palette.open",
    label: "Command Palette",
    shortcuts: [{ key: "k", meta: true }],
    palette: false,
    when: () => true,
    run: () => openPalette(),
  },
  { id: "library.import", label: "Import…", shortcuts: [{ key: "o", meta: true, viaMenu: true }], when: () => true, run: () => pickAndImport() },
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
    shortcuts: [{ key: "\\", meta: true, viaMenu: true }],
    when: (ctx) => ctx.screen === "reader",
    run: () => (useApp.getState().sidebar.open ? closeSidebar() : openSidebar()),
  },
  { id: "nav.left", palette: false, label: "Page left", shortcuts: [{ key: "ArrowLeft" }], yieldsToControls: true, when: inReader, run: (c) => c.reader!.goLeft() },
  { id: "nav.right", palette: false, label: "Page right", shortcuts: [{ key: "ArrowRight" }], yieldsToControls: true, when: inReader, run: (c) => c.reader!.goRight() },
  { id: "nav.up", palette: false, label: "Scroll up", shortcuts: [{ key: "ArrowUp" }], yieldsToControls: true, when: inReader, run: (c) => c.reader!.scrollBy(-1) },
  { id: "nav.down", palette: false, label: "Scroll down", shortcuts: [{ key: "ArrowDown" }], yieldsToControls: true, when: inReader, run: (c) => c.reader!.scrollBy(1) },
  { id: "nav.next", palette: false, label: "Next page", shortcuts: [{ key: " " }], yieldsToControls: true, when: inReader, run: (c) => c.reader!.next() },
  { id: "nav.prev", palette: false, label: "Previous page", shortcuts: [{ key: " ", shift: true }], yieldsToControls: true, when: inReader, run: (c) => c.reader!.prev() },
  {
    id: "nav.back",
    label: "Back",
    shortcuts: [{ key: "[", meta: true, viaMenu: true }],
    when: (ctx) => inReader(ctx) && backHistory.size(ctx.bookId!) > 0,
    run: (ctx) => goBack(ctx),
  },
  {
    id: "mode.toggle",
    label: "Toggle vertical/horizontal",
    shortcuts: [{ key: "v", meta: true, shift: true, viaMenu: true }],
    when: () => true,
    run: (ctx) => setPref(ctx, "reading_mode", ctx.prefs.reading_mode === "vertical" ? "horizontal" : "vertical"),
  },
  themeCommand("light", 1),
  themeCommand("dark", 2),
  themeCommand("sepia", 3),
  themeCommand("system", null),
  {
    id: "text.bigger",
    label: "Larger text or zoom in",
    shortcuts: [{ key: "=", meta: true, viaMenu: true }, { key: "+", meta: true }, { key: "+", meta: true, shift: true }],
    when: inReader,
    run: (ctx) => sizeStep(ctx, 1),
  },
  {
    id: "text.smaller",
    label: "Smaller text or zoom out",
    shortcuts: [{ key: "-", meta: true, viaMenu: true }],
    when: inReader,
    run: (ctx) => sizeStep(ctx, -1),
  },
  {
    id: "ui.dismiss",
    label: "Dismiss",
    palette: false,
    shortcuts: [{ key: "Escape" }],
    // Popovers and sheets dismiss themselves and mark the event handled.
    when: (ctx) => ctx.screen === "reader" && useApp.getState().sidebar.open && !useApp.getState().sidebar.pinned,
    run: () => closeSidebar(),
  },
];

/** Runs per command id, for proving that one trigger runs a command once. */
export const commandRuns: Record<string, number> = {};

function execute(command: Command, ctx: CommandContext) {
  commandRuns[command.id] = (commandRuns[command.id] ?? 0) + 1;
  const fail = (err: unknown) => useApp.getState().notify(`${command.label} failed: ${err}`);
  try {
    void Promise.resolve(command.run(ctx)).catch(fail);
  } catch (err) {
    fail(err);
  }
}

const dynamic = (id: string, label: string, run: () => unknown): Command => ({ id, label, shortcuts: [], when: () => true, run: async () => void (await run()) });

/** Contextual commands that depend on the open book, its collections, and the Library view. */
export function paletteCommands(ctx: CommandContext): Command[] {
  const s = useApp.getState();
  const out: Command[] = [];
  const manual = s.collections.filter((c) => c.kind === "manual");
  if (ctx.bookId !== null) {
    const id = ctx.bookId;
    const book = s.books.find((b) => b.id === id) ?? (s.screen.name === "reader" ? s.screen.detail.book : null);
    if (book?.reading_state !== "finished") out.push(dynamic("book.finished", "Mark as Finished", () => s.setReadingState(id, "finished")));
    if (book?.reading_state !== "unread") out.push(dynamic("book.unread", "Mark as Unread", () => s.setReadingState(id, "unread")));
    for (const c of manual) {
      const member = book?.collection_ids.includes(c.id) ?? false;
      out.push(
        member
          ? dynamic(`collection.remove.${c.id}`, `Remove from ${c.name}`, () => s.setMembership(c.id, [id], false))
          : dynamic(`collection.add.${c.id}`, `Add to ${c.name}`, () => s.setMembership(c.id, [id], true)),
      );
    }
  }
  if (ctx.screen === "library") {
    const current = s.uiSettings.library.collection_id;
    if (current !== null) out.push(dynamic("collection.all", "Show All Books", () => s.setView({ collection_id: null })));
    for (const c of s.collections) {
      if (c.id !== current) out.push(dynamic(`collection.show.${c.id}`, `Show collection ${c.name}`, () => s.setView({ collection_id: c.id })));
    }
  }
  out.push(
    dynamic("collection.new", "New Collection…", () =>
      s.setCollectionEditor({ mode: "create", addBookIds: ctx.bookId === null ? [] : [ctx.bookId] }),
    ),
  );
  return out;
}

/** Everything the palette lists right now: registry commands that apply, then contextual ones. */
export function paletteItems(ctx: CommandContext = commandContext()): Command[] {
  return [...commands.filter((c) => c.palette !== false && c.when(ctx)), ...paletteCommands(ctx)];
}

/** Closes the palette, then runs the chosen command once. */
export function runFromPalette(command: Command) {
  const ctx = commandContext();
  useApp.getState().setPaletteOpen(false);
  if (command.when(ctx)) execute(command, ctx);
}

export function runCommand(id: string) {
  const ctx = commandContext();
  const command = commands.find((c) => c.id === id);
  if (command?.when(ctx)) execute(command, ctx);
}

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
  const command = commands.find((c) => c.shortcuts.some((s) => !s.viaMenu && matches(s, e)) && c.when(ctx));
  if (!command) return;
  if (command.yieldsToControls && target?.closest?.(CONTROLS)) return;
  e.preventDefault();
  execute(command, ctx);
}

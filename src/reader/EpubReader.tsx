import { useEffect, useLayoutEffect, useRef } from "react";
import "foliate-js/view.js";
import type { View, RelocateDetail } from "foliate-js/view.js";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BookDetail, Locator } from "../lib/api";
import { loadEpub } from "../adapters/epub";
import { handleKeydown } from "../lib/commands";
import { backHistory } from "../lib/history";
import { THEME_COLORS, type Prefs, type Theme } from "../lib/prefs";
import { useApp } from "../lib/store";
import { useResolvedTheme } from "../lib/theme";
import { readerActivity } from "./activity";
import { setActiveReader, type RestoreQuality } from "./handle";
import { useSaver } from "./useSaver";

const NOT_CODE = ":not(pre, code, kbd, samp, tt, pre *, code *, kbd *, samp *, math, math *, svg, svg *)";
const FAMILIES = { serif: "ui-serif, 'New York', Georgia, serif", sans: "-apple-system, system-ui, 'Helvetica Neue', sans-serif" };

export function readerCss(prefs: Prefs, theme: Theme): string {
  const c = THEME_COLORS[theme];
  const family = prefs.font_family === "publisher" ? "" : `body, body *${NOT_CODE} { font-family: ${FAMILIES[prefs.font_family]} !important; }`;
  // Light keeps publisher colors; dark and sepia need inherited text so no
  // publisher color ends up dark on dark.
  const recolor = theme === "light" ? "" : `body *:not(a, a *) { color: inherit !important; background-color: transparent !important; }`;
  return `
    html { color-scheme: ${theme === "dark" ? "dark" : "light"}; font-size: ${prefs.font_size}px !important; }
    html, body { background: transparent !important; }
    body { color: ${c.fg} !important; font-size: 1rem !important; }
    p, li, blockquote, dd, dt, td, th, figcaption { line-height: ${prefs.line_height} !important; }
    a:link, a:visited { color: ${c.link} !important; }
    ${family}
    ${recolor}
    img, svg, video { max-width: 100%; height: auto; object-fit: contain; }
    pre { overflow-x: auto; max-width: 100%; white-space: pre; }
    table { display: block; overflow-x: auto; max-width: 100%; }
  `;
}

type Renderer = View["renderer"];

function percentOf(view: View, index: number, sectionFraction: number) {
  const f = view.getSectionFractions();
  const start = f[index] ?? 0;
  const end = f[index + 1] ?? 1;
  return Math.min(1, Math.max(0, start + (end - start) * sectionFraction));
}

function sectionFraction(view: View, d: RelocateDetail): number {
  const f = view.getSectionFractions();
  const i = d.section.current;
  const start = f[i] ?? 0;
  const end = f[i + 1] ?? 1;
  return Math.min(1, Math.max(0, end > start ? (d.fraction - start) / (end - start) : 0));
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function applyLayout(r: Renderer, prefs: Prefs) {
  const flow = prefs.reading_mode === "vertical" ? "scrolled" : "paginated";
  const columns = prefs.spread === "double" ? "2" : "1";
  // foliate re-renders on every attribute write, even an unchanged value.
  if (r.getAttribute("flow") !== flow) r.setAttribute("flow", flow);
  if (r.getAttribute("max-column-count") !== columns) r.setAttribute("max-column-count", columns);
}

/**
 * Reflowable EPUB. Horizontal mode is foliate's paginated flow; vertical mode
 * is its scrolled flow, which renders one section at a time. Continuity across
 * sections comes from treating overscroll at a section edge (wheel, Down,
 * Space) as a move into the adjacent section, anchored at its start or end.
 */
export function EpubReader({ detail, prefs }: { detail: BookDetail; prefs: Prefs }) {
  const host = useRef<HTMLDivElement>(null);
  const saver = useSaver(detail.book.id);
  const notify = useApp((s) => s.notify);
  const setPosition = useApp((s) => s.setPosition);
  const theme = useResolvedTheme(prefs.theme);
  const live = useRef({ prefs, theme });
  live.current = { prefs, theme };
  const control = useRef<{ view: View; relayout(): void } | null>(null);

  // A layout effect, so its cleanup closes foliate before React detaches the
  // host; a detached section document made foliate's ResizeObserver throw.
  useLayoutEffect(() => {
    const abort = new AbortController();
    const view = document.createElement("foliate-view") as View;
    const el = host.current!;
    const bookId = detail.book.id;
    let location: Locator | null = null;
    let lastReason: string | null = null;
    let resolveReady!: () => void;
    let rejectReady!: (e: unknown) => void;
    const ready = new Promise<void>((res, rej) => ((resolveReady = res), (rejectReady = rej)));
    ready.catch(() => {});

    // settled() waits for relocates to stop after a layout change.
    let layoutPending = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let waiters: Array<() => void> = [];
    const settleAfter = (ms: number) => {
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        layoutPending = false;
        waiters.forEach((w) => w());
        waiters = [];
      }, ms);
    };
    const relayout = () => {
      layoutPending = true;
      settleAfter(800);
    };
    addEventListener("resize", relayout);

    const r = () => view.renderer;
    const contents = () => r()?.getContents?.() ?? [];
    const docs = () => contents().map((c) => c.doc).filter((d): d is Document => !!d);

    view.addEventListener("relocate", (e) => {
      const d = (e as CustomEvent<RelocateDetail>).detail;
      location = { format: "epub", v: 1, cfi: d.cfi, section_index: d.section.current, section_fraction: sectionFraction(view, d) };
      saver.update(location, d.fraction, lastReason !== "scroll");
      setPosition({ tocHref: d.tocItem?.href ?? null, sectionIndex: d.section.current });
      if (layoutPending) settleAfter(250);
    });
    view.addEventListener("external-link", (e) => {
      e.preventDefault();
      const href = (e as CustomEvent<{ href: string }>).detail.href;
      if (/^https?:\/\//i.test(href) && window.confirm(`Open ${href} in your browser?`)) void openUrl(href);
    });
    view.addEventListener("link", (e) => {
      const href = (e as CustomEvent<{ href: string }>).detail.href;
      if (/^(javascript|file|data|vbscript):/i.test(href)) e.preventDefault();
      else backHistory.push(bookId, location);
    });

    // foliate reports a scrolled position only once scrolling stops, so a long
    // continuous scroll would never save; sample it while it runs.
    let lastSample = 0;
    const sampleScroll = () => {
      const rr = r();
      const now = performance.now();
      if (!rr?.scrolled || now - lastSample < 500) return;
      lastSample = now;
      const c = contents()[0];
      const doc = c?.doc;
      if (!doc?.body) return;
      const range = doc.caretRangeFromPoint?.(doc.body.getBoundingClientRect().left + 8, Math.max(0, rr.start) + 8);
      if (!range) return;
      const f = rr.viewSize > 0 ? Math.min(1, Math.max(0, rr.start / rr.viewSize)) : 0;
      location = { format: "epub", v: 1, cfi: view.getCFI(c.index, range), section_index: c.index, section_fraction: f };
      saver.update(location, percentOf(view, c.index, f), false);
    };

    let overscroll = 0;
    let overscrollReset: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (e: WheelEvent) => {
      readerActivity.ping();
      const rr = r();
      if (!rr?.scrolled || e.deltaY === 0) return;
      const atEnd = rr.viewSize - rr.end <= 2;
      const atStart = rr.start <= 0;
      if (!((e.deltaY > 0 && atEnd) || (e.deltaY < 0 && atStart))) {
        overscroll = 0;
        return;
      }
      overscroll += e.deltaY;
      clearTimeout(overscrollReset);
      overscrollReset = setTimeout(() => (overscroll = 0), 400);
      if (Math.abs(overscroll) < 150) return;
      const dir = Math.sign(overscroll);
      overscroll = 0;
      void (dir > 0 ? view.next() : view.prev());
    };
    el.addEventListener("wheel", onWheel, { passive: true });

    const restore = async (l: Locator): Promise<RestoreQuality> => {
      if (l.format !== "epub") return "approximate";
      let resolved: { index: number } | undefined;
      try {
        resolved = view.resolveNavigation(l.cfi);
      } catch {
        resolved = undefined;
      }
      if (resolved && resolved.index === l.section_index) {
        try {
          await r().goTo(resolved);
          if (contents()[0]?.index === l.section_index) return "exact";
        } catch {
          // The section fallback below still lands near the saved passage.
        }
      }
      const index = Math.min(Math.max(0, l.section_index), view.book.sections.length - 1);
      await r().goTo({ index, anchor: l.section_fraction });
      return "approximate";
    };

    setActiveReader({
      bookId,
      ready,
      location: () => location,
      dir: () => (view.book?.dir === "rtl" ? "rtl" : "ltr"),
      next: () => view.next(),
      prev: () => view.prev(),
      goLeft: () => view.goLeft(),
      goRight: () => view.goRight(),
      scrollBy: (dir) => {
        if (r()?.scrolled) void (dir > 0 ? r().next(80) : r().prev(80));
      },
      goTo: async (t) => {
        backHistory.push(bookId, location);
        await view.goTo(typeof t === "string" && /^\d+$/.test(t) ? Number(t) : t);
      },
      goToLocator: restore,
      settled: async () => {
        await ready;
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        if (layoutPending) await new Promise<void>((res) => waiters.push(res));
      },
      anchor: () => collapse(view.lastLocation?.range?.toString() ?? "").slice(0, 32),
      isVisible: (a) => !!a && collapse(view.lastLocation?.range?.toString() ?? "").includes(a.slice(0, 16)),
      flush: () => saver.flush(),
      documents: docs,
    });

    (async () => {
      const book = await loadEpub(bookId, abort.signal);
      if (abort.signal.aborted) return;
      el.append(view);
      await view.open(book);
      const rr = r();
      rr.addEventListener("relocate", (e) => (lastReason = (e as CustomEvent<{ reason: string | null }>).detail.reason));
      rr.addEventListener("scroll", sampleScroll);
      rr.addEventListener("load", (e) => {
        const doc = (e as CustomEvent<{ doc: Document }>).detail.doc;
        doc.addEventListener("keydown", handleKeydown);
        doc.addEventListener("pointermove", () => readerActivity.ping());
        doc.addEventListener("wheel", onWheel, { passive: true });
      });
      applyLayout(rr, live.current.prefs);
      rr.setStyles?.(readerCss(live.current.prefs, live.current.theme));
      control.current = { view, relayout };
      const saved = detail.progress?.locator;
      if (saved?.format === "epub") {
        if ((await restore(saved)) === "approximate") notify("Restored an approximate position");
      } else {
        await view.init({ lastLocation: null, showTextStart: true });
      }
      resolveReady();
    })().catch((e) => {
      rejectReady(e);
      if (!abort.signal.aborted) notify(`This EPUB could not be displayed: ${e instanceof Error ? e.message : e}`);
    });

    return () => {
      abort.abort();
      clearTimeout(quiet);
      clearTimeout(overscrollReset);
      removeEventListener("resize", relayout);
      el.removeEventListener("wheel", onWheel);
      control.current = null;
      setActiveReader(null);
      view.close?.();
      view.remove();
    };
  }, [detail, saver, notify, setPosition]);

  useEffect(() => {
    const c = control.current;
    if (!c) return;
    c.relayout();
    applyLayout(c.view.renderer, prefs);
    c.view.renderer.setStyles?.(readerCss(prefs, theme));
  }, [prefs, theme]);

  return (
    <div
      ref={host}
      data-reading-region
      tabIndex={-1}
      aria-label="Book text"
      className="epub-host min-h-0 flex-1 outline-none"
      style={{ background: THEME_COLORS[theme].bg }}
    />
  );
}

import { useEffect, useRef } from "react";
import "foliate-js/view.js";
import type { View, RelocateDetail } from "foliate-js/view.js";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BookDetail, Locator } from "../lib/api";
import { loadEpub } from "../adapters/epub";
import { useApp } from "../lib/store";
import { setActiveReader } from "./handle";
import { useSaver } from "./useSaver";

const READER_CSS = `
  html { color-scheme: light; }
  body { color: #1d1d1f !important; background: transparent !important; }
  img, svg, video { max-width: 100%; height: auto; }
  pre, table { overflow-x: auto; display: block; }
`;

function sectionFraction(view: View, detail: RelocateDetail): number {
  const fractions: number[] = (view as unknown as { getSectionFractions(): number[] }).getSectionFractions();
  const i = detail.section.current;
  const start = fractions[i] ?? 0;
  const end = fractions[i + 1] ?? 1;
  const f = end > start ? (detail.fraction - start) / (end - start) : 0;
  return Math.min(1, Math.max(0, f));
}

export function EpubReader({ detail }: { detail: BookDetail }) {
  const host = useRef<HTMLDivElement>(null);
  const saver = useSaver(detail.book.id);
  const notify = useApp((s) => s.notify);

  useEffect(() => {
    const abort = new AbortController();
    const view = document.createElement("foliate-view") as View;
    let location: Locator | null = null;
    let resolveReady!: () => void;
    let rejectReady!: (e: unknown) => void;
    const ready = new Promise<void>((res, rej) => ((resolveReady = res), (rejectReady = rej)));
    ready.catch(() => {});

    view.addEventListener("relocate", (e) => {
      const d = (e as CustomEvent<RelocateDetail>).detail;
      location = { format: "epub", v: 1, cfi: d.cfi, section_index: d.section.current, section_fraction: sectionFraction(view, d) };
      saver.update(location, d.fraction, true);
    });
    view.addEventListener("external-link", (e) => {
      e.preventDefault();
      const href = (e as CustomEvent<{ href: string }>).detail.href;
      if (/^https?:\/\//i.test(href) && window.confirm(`Open ${href} in your browser?`)) void openUrl(href);
    });
    view.addEventListener("link", (e) => {
      const href = (e as CustomEvent<{ href: string }>).detail.href;
      if (/^(javascript|file|data|vbscript):/i.test(href)) e.preventDefault();
    });

    const docs = () => (view.renderer?.getContents?.() ?? []).map((c) => c.doc).filter((d): d is Document => !!d);

    setActiveReader({
      bookId: detail.book.id,
      ready,
      location: () => location,
      dir: () => (view.book?.dir === "rtl" ? "rtl" : "ltr"),
      next: () => view.next(),
      prev: () => view.prev(),
      goLeft: () => view.goLeft(),
      goRight: () => view.goRight(),
      scrollBy: () => {},
      goTo: async (t) => void (await view.goTo(t)),
      goToLocator: async (l) => (l.format === "epub" && (await view.goTo(l.cfi)), "exact"),
      settled: () => ready,
      anchor: () => view.lastLocation?.range?.toString().trim().slice(0, 40) ?? "",
      isVisible: (a) => !!a && (view.lastLocation?.range?.toString() ?? "").includes(a),
      flush: () => saver.flush(),
      documents: docs,
    });

    (async () => {
      const book = await loadEpub(detail.book.id, abort.signal);
      if (abort.signal.aborted) return;
      host.current!.append(view);
      await view.open(book);
      view.renderer.setAttribute("flow", "paginated");
      view.renderer.setAttribute("max-column-count", "1");
      view.renderer.setStyles?.(READER_CSS);
      const saved = detail.progress?.locator;
      await view.init({ lastLocation: saved?.format === "epub" ? saved.cfi : null, showTextStart: !saved });
      resolveReady();
    })().catch((e) => {
      rejectReady(e);
      if (!abort.signal.aborted) notify(`This EPUB could not be displayed: ${e instanceof Error ? e.message : e}`);
    });

    return () => {
      abort.abort();
      setActiveReader(null);
      view.close?.();
      view.remove();
    };
  }, [detail, saver, notify]);

  return <div ref={host} className="epub-host" />;
}

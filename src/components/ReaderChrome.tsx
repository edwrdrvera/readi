import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BookmarkPlus, ChevronLeft, PanelLeft, Search, Settings, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BookDetail } from "@/lib/api";
import { closeSidebar, goBack, openBookSearch, openSettings, openSidebar } from "@/lib/commands";
import { backHistory } from "@/lib/history";
import { useApp } from "@/lib/store";
import { activeTocItem, flattenToc } from "@/lib/toc";
import { cn } from "@/lib/utils";
import { activeReader } from "@/reader/handle";
import { OmniboxActionsList, OmniboxInput, OmniboxProvider } from "./Omnibox";
import { readerActivity } from "@/reader/activity";

const HIDE_AFTER_MS = 2000;

/** Label of the contents entry the reader is in, or null when the book has none there. */
export function useSectionLabel(detail: BookDetail): string | null {
  const position = useApp((s) => s.position);
  const pdfPage = useApp((s) => s.progress.pdfPage);
  const flat = useMemo(() => flattenToc(detail.toc), [detail.toc]);
  return useMemo(() => activeTocItem(detail, flat, position, pdfPage)?.label ?? null, [detail, flat, position, pdfPage]);
}

const ICON = "size-[30px] [&_svg]:size-4";

export function ReaderChrome({ detail }: { detail: BookDetail }) {
  const bar = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(true);
  const saveStatus = useApp((s) => s.saveStatus);
  const closeBook = useApp((s) => s.closeBook);
  const sidebarOpen = useApp((s) => s.sidebar.open);
  const aaOpen = useApp((s) => s.aaOpen);
  const setAaOpen = useApp((s) => s.setAaOpen);
  const bookId = detail.book.id;
  const backSize = useSyncExternalStore(backHistory.subscribe, () => backHistory.size(bookId));
  const alwaysShow = useApp((s) => s.uiSettings.always_show_controls);
  const selecting = useApp((s) => s.selection !== null || s.editingId !== null);
  const searching = useApp((s) => s.search.open);
  const held = aaOpen || alwaysShow || selecting || searching;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      setVisible(true);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!bar.current?.contains(document.activeElement)) setVisible(false);
      }, HIDE_AFTER_MS);
    };
    show();
    const offActivity = readerActivity.subscribe(show);
    addEventListener("pointermove", show);
    const node = bar.current!;
    node.addEventListener("focusin", show);
    node.addEventListener("focusout", show);
    return () => {
      clearTimeout(timer);
      offActivity();
      removeEventListener("pointermove", show);
      node.removeEventListener("focusin", show);
      node.removeEventListener("focusout", show);
    };
  }, []);

  const shown = visible || held || saveStatus?.kind === "error";
  const section = useSectionLabel(detail);

  return (
    <header
      ref={bar}
      data-visible={shown}
      data-tauri-drag-region
      className="z-20 flex h-[52px] shrink-0 items-center gap-1.5 border-b bg-chrome pr-3.5 pl-[92px] text-[13px] backdrop-blur transition-opacity duration-200 data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
    >
      <Button variant="ghost" size="icon-sm" className={ICON} onClick={() => void closeBook()} aria-label="Back to library">
        <ChevronLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(ICON, sidebarOpen && "bg-muted")}
        aria-label="Sidebar"
        aria-pressed={sidebarOpen}
        title="Sidebar (⌘\)"
        onClick={(e) => (sidebarOpen ? closeSidebar() : openSidebar(e.currentTarget))}
      >
        <PanelLeft />
      </Button>
      <Button variant="ghost" size="icon-sm" className={ICON} aria-label="Back" title="Back (⌘[)" disabled={backSize === 0} onClick={() => void goBack()}>
        <Undo2 />
      </Button>
      {searching ? (
        <OmniboxProvider scope="reader">
          <div className="relative mx-2 flex min-w-0 flex-1 justify-center">
            <OmniboxInput autoFocus className="w-full max-w-[420px]" />
            <OmniboxActionsList />
          </div>
        </OmniboxProvider>
      ) : (
        <span data-tauri-drag-region className="mx-2 flex min-w-0 flex-1 items-baseline justify-center gap-2.5">
          <span data-tauri-drag-region className="truncate font-semibold">{detail.book.title}</span>
          {section && <span data-tauri-drag-region className="min-w-0 shrink truncate text-muted-foreground">{section}</span>}
        </span>
      )}
      {saveStatus?.kind === "error" && (
        <span className="text-destructive" role="alert">
          Progress not saved.{" "}
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void activeReader()?.flush()}>
            Retry
          </Button>
        </span>
      )}
      <Button variant="ghost" size="icon-sm" className={ICON} aria-label="Find in book" title="Find in Book (⌘F)" data-testid="search-open" onClick={(e) => openBookSearch(e.currentTarget)}>
        <Search />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className={ICON}
        aria-label="Add bookmark"
        title="Add Bookmark (⌘D)"
        data-testid="bookmark-add"
        onClick={() => void useApp.getState().addBookmark()}
      >
        <BookmarkPlus />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn("h-[30px] px-2 font-serif text-[15px] font-medium", aaOpen && "bg-muted")}
        aria-label="Appearance for this book"
        aria-pressed={aaOpen}
        title="Reading settings"
        onClick={() => setAaOpen(!aaOpen)}
      >
        Aa
      </Button>
      <Button variant="ghost" size="icon-sm" className={ICON} aria-label="Settings" onClick={() => openSettings()}>
        <Settings />
      </Button>
    </header>
  );
}

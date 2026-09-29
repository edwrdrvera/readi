import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ALargeSmall, BookmarkPlus, ChevronLeft, PanelLeft, Search, Settings, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import type { BookDetail } from "@/lib/api";
import { closeSidebar, goBack, openBookSearch, openSidebar } from "@/lib/commands";
import { backHistory } from "@/lib/history";
import type { PrefKey, Prefs } from "@/lib/prefs";
import { useApp } from "@/lib/store";
import { activeReader } from "@/reader/handle";
import { readerActivity } from "@/reader/activity";
import { PrefsForm } from "./PrefsForm";
import { openSettings } from "./SettingsSheet";

const HIDE_AFTER_MS = 2000;

export function ReaderChrome({ detail, prefs }: { detail: BookDetail; prefs: Prefs }) {
  const bar = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(true);
  const saveStatus = useApp((s) => s.saveStatus);
  const closeBook = useApp((s) => s.closeBook);
  const sidebarOpen = useApp((s) => s.sidebar.open);
  const aaOpen = useApp((s) => s.aaOpen);
  const setAaOpen = useApp((s) => s.setAaOpen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const overrides = useApp((s) => s.overrides);
  const setOverride = useApp((s) => s.setOverride);
  const resetOverrides = useApp((s) => s.resetOverrides);
  const bookId = detail.book.id;
  const backSize = useSyncExternalStore(backHistory.subscribe, () => backHistory.size(bookId));
  const alwaysShow = useApp((s) => s.uiSettings.always_show_controls);
  const selecting = useApp((s) => s.selection !== null || s.editingId !== null);
  const held = aaOpen || settingsOpen || alwaysShow || selecting;

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
  const overridden = Object.fromEntries(Object.keys(overrides).map((k) => [k, true])) as Partial<Record<PrefKey, boolean>>;
  const isPdf = detail.book.format === "pdf";

  return (
    <header
      ref={bar}
      data-visible={shown}
      className="absolute inset-x-0 top-0 z-20 flex items-center gap-1 border-b bg-chrome px-2 py-1 text-[13px] backdrop-blur transition-opacity duration-200 data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
    >
      <Button variant="ghost" size="sm" onClick={() => void closeBook()} aria-label="Back to library">
        <ChevronLeft /> Library
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Sidebar"
        aria-pressed={sidebarOpen}
        title="Sidebar (⌘\)"
        onClick={(e) => (sidebarOpen ? closeSidebar() : openSidebar(e.currentTarget))}
      >
        <PanelLeft />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Back" title="Back (⌘[)" disabled={backSize === 0} onClick={() => void goBack()}>
        <Undo2 />
      </Button>
      <span className="mx-2 min-w-0 flex-1 truncate text-center text-muted-foreground">{detail.book.title}</span>
      {saveStatus?.kind === "error" && (
        <span className="text-destructive" role="alert">
          Progress not saved.{" "}
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void activeReader()?.flush()}>
            Retry
          </Button>
        </span>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="Find in book" title="Find in Book (⌘F)" data-testid="search-open" onClick={(e) => openBookSearch(e.currentTarget)}>
        <Search />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Add bookmark"
        title="Add Bookmark (⌘D)"
        data-testid="bookmark-add"
        onClick={() => void useApp.getState().addBookmark()}
      >
        <BookmarkPlus />
      </Button>
      <Popover open={aaOpen} onOpenChange={setAaOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Appearance for this book">
            <ALargeSmall />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">This book</h2>
            <Button variant="outline" size="sm" disabled={Object.keys(overrides).length === 0} onClick={() => void resetOverrides()}>
              Reset to defaults
            </Button>
          </div>
          <PrefsForm
            values={prefs}
            groups={isPdf ? ["layout", "pdf"] : ["layout", "text"]}
            overridden={overridden}
            onChange={(k, v) => void setOverride(k, v)}
            onClear={(k) => void setOverride(k, null)}
          />
          <Separator className="my-3" />
          <p className="text-xs text-muted-foreground">Marked settings apply to this book only.</p>
        </PopoverContent>
      </Popover>
      <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={openSettings}>
        <Settings />
      </Button>
    </header>
  );
}

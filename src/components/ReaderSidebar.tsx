import { Pin, PinOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { BookDetail } from "@/lib/api";
import { closeSidebar } from "@/lib/commands";
import { useApp, type SidebarTab } from "@/lib/store";
import { cn } from "@/lib/utils";
import { AnnotationsTab } from "./AnnotationsTab";
import { ContentsTab } from "./ContentsTab";
import { SearchTab } from "./SearchTab";

const TABS: Array<{ id: SidebarTab; label: string }> = [
  { id: "contents", label: "Contents" },
  { id: "annotations", label: "Annotations" },
  { id: "search", label: "Search" },
];

export function ReaderSidebar({ detail }: { detail: BookDetail }) {
  const { open, pinned, tab } = useApp((s) => s.sidebar);
  const setSidebar = useApp((s) => s.setSidebar);
  if (!open) return null;

  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(i + step + TABS.length) % TABS.length];
    setSidebar({ tab: next.id });
    requestAnimationFrame(() => document.getElementById(`sidebar-tab-${next.id}`)?.focus());
  };

  return (
    <aside
      data-reader-sidebar
      aria-label="Sidebar"
      className={cn("z-30 flex w-72 shrink-0 flex-col border-r bg-background", pinned ? "relative" : "absolute inset-y-0 left-0 shadow-xl")}
      onKeyDown={(e) => {
        // The window handler skips editable targets, so Escape in the search or filter field lands here.
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        if (pinned) document.querySelector<HTMLElement>("[data-reading-region]")?.focus();
        else closeSidebar();
      }}
    >
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <div role="tablist" aria-label="Sidebar" className="flex flex-1 gap-0.5">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              id={`sidebar-tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`sidebar-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              data-testid={`sidebar-tab-${t.id}`}
              className={cn(
                "rounded-md px-2 py-1 text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                tab === t.id && "bg-accent font-medium text-accent-foreground",
              )}
              onClick={() => setSidebar({ tab: t.id })}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon-sm" aria-pressed={pinned} aria-label={pinned ? "Unpin sidebar" : "Pin sidebar"} onClick={() => setSidebar({ pinned: !pinned })}>
          {pinned ? <PinOff /> : <Pin />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close sidebar" onClick={closeSidebar}>
          <X />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div role="tabpanel" id={`sidebar-panel-${tab}`} aria-labelledby={`sidebar-tab-${tab}`}>
          {tab === "contents" && <ContentsTab detail={detail} />}
          {tab === "annotations" && <AnnotationsTab />}
          {tab === "search" && <SearchTab detail={detail} />}
        </div>
      </ScrollArea>
    </aside>
  );
}

import { ScrollArea } from "@/components/ui/scroll-area";
import type { BookDetail } from "@/lib/api";
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
  const { open, tab } = useApp((s) => s.sidebar);
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
      className="flex w-60 shrink-0 flex-col border-r bg-background"
      onKeyDown={(e) => {
        // The window handler skips editable targets, so Escape in the search or filter field lands here.
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        document.querySelector<HTMLElement>("[data-reading-region]")?.focus();
      }}
    >
      <div className="px-3 pt-3 pb-2">
        <div role="tablist" aria-label="Sidebar" className="flex gap-1 rounded-lg bg-muted p-0.5">
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
                "h-[26px] flex-1 rounded-md px-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === t.id ? "bg-popover text-foreground shadow-[0_1px_2px_rgba(0,0,0,.12)]" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setSidebar({ tab: t.id })}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {t.label}
            </button>
          ))}
        </div>
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

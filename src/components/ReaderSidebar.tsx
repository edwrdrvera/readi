import { ScrollArea } from "@/components/ui/scroll-area";
import type { BookDetail } from "@/lib/api";
import { useApp, type SidebarTab } from "@/lib/store";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

  return (
    <Tabs
      asChild
      value={tab}
      onValueChange={(v) => setSidebar({ tab: v as SidebarTab })}
      className="gap-0"
    >
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
          <TabsList aria-label="Sidebar" className="w-full">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} data-testid={`sidebar-tab-${t.id}`}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <TabsContent value="contents">
            <ContentsTab detail={detail} />
          </TabsContent>
          <TabsContent value="annotations">
            <AnnotationsTab />
          </TabsContent>
          <TabsContent value="search">
            <SearchTab detail={detail} />
          </TabsContent>
        </ScrollArea>
      </aside>
    </Tabs>
  );
}

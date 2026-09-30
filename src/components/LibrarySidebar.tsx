import { Archive, BookOpen, Folder, MoreHorizontal, Plus, Tag } from "lucide-react";
import type { Collection, Format } from "@/lib/api";
import { effectiveView } from "@/lib/libraryView";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function Entry({ active, icon, label, count, onClick, children }: { active: boolean; icon: React.ReactNode; label: string; count?: number; onClick(): void; children?: React.ReactNode }) {
  return (
    <li className="group relative flex items-center">
      <button
        aria-current={active ? "page" : undefined}
        onClick={onClick}
        className={cn(
          "flex h-[30px] min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] outline-none hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
          active && "bg-accent text-accent-foreground hover:bg-accent",
        )}
      >
        {icon}
        <span className="flex-1 truncate">{label}</span>
        {count !== undefined && <span className="text-[11px] text-muted-foreground">{count}</span>}
      </button>
      {children}
    </li>
  );
}

function ManualEntry({ c, active }: { c: Collection; active: boolean }) {
  const s = useApp.getState();
  return (
    <Entry active={active} icon={<Tag />} label={c.name} onClick={() => void s.setView({ collection_id: c.id, format: null })}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="absolute right-1 size-6 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100" aria-label={`Actions for ${c.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => s.setCollectionEditor({ mode: "rename", collectionId: c.id })}>Rename…</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => s.setConfirmation({ kind: "delete-collection", collectionId: c.id })}>
            Delete Collection…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Entry>
  );
}

const Label = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <h2 className={cn("px-[18px] pb-1.5 text-[11px] font-semibold tracking-[.02em] text-muted-foreground", className)}>{children}</h2>
);

export function LibrarySidebar() {
  const collections = useApp((s) => s.collections);
  const books = useApp((s) => s.books);
  const view = effectiveView(useApp((s) => s.uiSettings.library));
  const setView = useApp((s) => s.setView);
  const setCollectionEditor = useApp((s) => s.setCollectionEditor);
  const manual = collections.filter((c) => c.kind === "manual");
  const derived = collections.filter((c) => c.kind === "derived");
  const current = view.collection_id;
  const count = (f: Format) => books.filter((b) => b.format === f).length;
  const nav = (format: Format) => ({ active: current === null && view.format === format, count: count(format), onClick: () => void setView({ collection_id: null, format }) });
  return (
    <nav aria-label="Collections" className="flex w-[220px] shrink-0 flex-col overflow-y-auto border-r bg-muted">
      <div data-tauri-drag-region className="h-[52px] shrink-0" />
      <Label className="pt-2">Readi</Label>
      <ul className="flex flex-col gap-0.5 px-2.5">
        <Entry icon={<BookOpen />} label="Library" {...nav("epub")} />
        <Entry icon={<Archive />} label="Drawer" {...nav("pdf")} />
      </ul>
      <div className="flex items-center justify-between pt-5 pr-2.5">
        <Label className="pb-0">Collections</Label>
        <Button variant="ghost" size="icon-sm" className="size-6" aria-label="New Collection…" onClick={() => setCollectionEditor({ mode: "create", addBookIds: [] })}>
          <Plus />
        </Button>
      </div>
      <ul className="flex flex-col gap-0.5 px-2.5 pt-1.5">
        {manual.map((c) => (
          <ManualEntry key={c.id} c={c} active={current === c.id} />
        ))}
      </ul>
      {derived.length > 0 && (
        <>
          <Label className="pt-5">Folders</Label>
          <ul className="flex flex-col gap-0.5 px-2.5 pb-4">
            {derived.map((c) => (
              <Entry key={c.id} active={current === c.id} icon={<Folder />} label={c.name} onClick={() => void setView({ collection_id: c.id, format: null })} />
            ))}
          </ul>
        </>
      )}
    </nav>
  );
}

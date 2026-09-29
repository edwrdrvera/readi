import { Folder, Library as LibraryIcon, MoreHorizontal, Plus, Tag } from "lucide-react";
import type { Collection } from "@/lib/api";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function Entry({ active, icon, label, onClick, children }: { active: boolean; icon: React.ReactNode; label: string; onClick(): void; children?: React.ReactNode }) {
  return (
    <li className="group flex items-center">
      <button
        aria-current={active ? "page" : undefined}
        onClick={onClick}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
          active && "bg-accent text-accent-foreground",
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {children}
    </li>
  );
}

function ManualEntry({ c, active }: { c: Collection; active: boolean }) {
  const s = useApp.getState();
  return (
    <Entry active={active} icon={<Tag />} label={c.name} onClick={() => void s.setView({ collection_id: c.id })}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="size-6 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100" aria-label={`Actions for ${c.name}`}>
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

export function LibrarySidebar() {
  const collections = useApp((s) => s.collections);
  const current = useApp((s) => s.uiSettings.library.collection_id);
  const setView = useApp((s) => s.setView);
  const setCollectionEditor = useApp((s) => s.setCollectionEditor);
  const manual = collections.filter((c) => c.kind === "manual");
  const derived = collections.filter((c) => c.kind === "derived");
  return (
    <nav aria-label="Collections" className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r px-2 py-4">
      <ul className="flex flex-col gap-0.5">
        <Entry active={current === null} icon={<LibraryIcon />} label="All Books" onClick={() => void setView({ collection_id: null })} />
      </ul>
      <section className="flex flex-col gap-1">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Collections</h2>
          <Button variant="ghost" size="icon-sm" className="size-6" aria-label="New Collection…" onClick={() => setCollectionEditor({ mode: "create", addBookIds: [] })}>
            <Plus />
          </Button>
        </div>
        <ul className="flex flex-col gap-0.5">
          {manual.map((c) => (
            <ManualEntry key={c.id} c={c} active={current === c.id} />
          ))}
        </ul>
      </section>
      {derived.length > 0 && (
        <section className="flex flex-col gap-1">
          <h2 className="px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Folders</h2>
          <ul className="flex flex-col gap-0.5">
            {derived.map((c) => (
              <Entry key={c.id} active={current === c.id} icon={<Folder />} label={c.name} onClick={() => void setView({ collection_id: c.id })} />
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}

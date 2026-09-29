import { useMemo, useState } from "react";
import { Bookmark, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Annotation } from "@/lib/api";
import { filterAnnotations, positionLabel } from "@/lib/annotations";
import { closeSidebar } from "@/lib/commands";
import { showAnnotation } from "@/lib/jumps";
import { useApp } from "@/lib/store";
import { SWATCH } from "./HighlightPopover";

export function AnnotationsTab() {
  const annotations = useApp((s) => s.annotations);
  const setEditing = useApp((s) => s.setEditing);
  const deleteAnnotation = useApp((s) => s.deleteAnnotation);
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => filterAnnotations(annotations, filter), [annotations, filter]);

  const open = async (a: Annotation) => {
    if (!useApp.getState().sidebar.pinned) closeSidebar();
    await showAnnotation(a);
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <Input
        data-testid="annotation-filter"
        type="search"
        aria-label="Filter highlights and bookmarks by quote or note"
        placeholder="Filter quotes and notes"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {annotations.length === 0 ? (
        <p className="p-1 text-sm text-muted-foreground">Select text to highlight it, or press ⌘D to add a bookmark.</p>
      ) : shown.length === 0 ? (
        <p className="p-1 text-sm text-muted-foreground" role="status">
          No highlights or bookmarks match.
        </p>
      ) : (
        <ul aria-label="Highlights and bookmarks" className="m-0 flex list-none flex-col gap-1 p-0">
          {shown.map((a) => {
            const unresolved = a.anchor_state === "unresolved";
            const text = a.kind === "bookmark" ? a.quote || positionLabel(a) : a.quote || "Highlight";
            return (
              <li key={a.id} data-testid="annotation-item" data-id={a.id} data-anchor-state={a.anchor_state} className="group flex items-start gap-1 rounded-md hover:bg-muted">
                <button
                  className="flex min-w-0 flex-1 gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`${a.kind === "bookmark" ? "Bookmark" : `${a.color} highlight`}, ${positionLabel(a)}${unresolved ? ", unresolved" : ""}: ${text}`}
                  onClick={() => void open(a)}
                >
                  {a.kind === "bookmark" ? (
                    <Bookmark className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <span className="mt-1 size-2.5 shrink-0 rounded-full" style={{ background: SWATCH[a.color ?? "yellow"] }} aria-hidden />
                  )}
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="line-clamp-3 text-[13px] leading-snug">{text}</span>
                    {a.note && <span className="line-clamp-2 text-xs text-muted-foreground italic">{a.note}</span>}
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      {positionLabel(a)}
                      {unresolved && (
                        <Badge variant="destructive" className="h-4 px-1 text-[10px]" title="The passage could not be found in this copy; opening goes to its section or page">
                          Unresolved
                        </Badge>
                      )}
                    </span>
                  </span>
                </button>
                <span className="flex shrink-0 flex-col opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                  <Button variant="ghost" size="icon-sm" aria-label="Edit note" onClick={() => setEditing(a.id)}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={a.kind === "bookmark" ? "Delete bookmark" : "Delete highlight"} onClick={() => void deleteAnnotation(a.id)}>
                    <Trash2 />
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

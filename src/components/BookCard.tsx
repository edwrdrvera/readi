import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { coverUrl, type BookSummary } from "@/lib/api";
import { useApp } from "@/lib/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { BookMenuItems, contextKit, dropdownKit } from "./BookMenu";

const INDEX_BADGE: Partial<Record<BookSummary["index_state"], string>> = {
  queued: "Indexing",
  indexing: "Indexing",
  no_searchable_text: "No searchable text",
  failed: "Index failed",
};

const TINTS = ["#5b7fa6", "#7a6aa0", "#5f8f6e", "#a0735a", "#8a5d73", "#56858a"];

export const percentLabel = (percent: number | null) => `${Math.round((percent ?? 0) * 100)}%`;

export function bookMeta(book: BookSummary): string {
  if (book.reading_state === "finished") return "Finished";
  if (book.reading_state === "reading") return percentLabel(book.percent);
  return "New";
}

export function Cover({ book, className, small }: { book: BookSummary; className?: string; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  const base = cn("aspect-[2/3] w-full rounded-[3px] shadow-[0_1px_2px_rgba(0,0,0,.12),0_6px_16px_rgba(0,0,0,.08)]", className);
  if (book.has_cover && !failed) {
    return <img src={coverUrl(book.id)} alt="" loading="lazy" className={cn(base, "object-cover")} onError={() => setFailed(true)} />;
  }
  return (
    <div className={cn(base, "flex flex-col justify-between text-white", small ? "justify-end p-2" : "p-3")} style={{ background: TINTS[book.id % TINTS.length] }} aria-hidden>
      <span className={cn("line-clamp-5 font-serif leading-tight font-semibold", small ? "text-[9px]" : "text-sm")}>{book.title}</span>
      {!small && <span className="truncate text-[10px] opacity-85">{book.authors[0] ?? ""}</span>}
    </div>
  );
}

export function useFocusedRow(bookId: number) {
  const ref = useRef<HTMLLIElement>(null);
  const focused = useApp((s) => s.focusedBookId === bookId);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);
  return { ref, focused };
}

export const loadMenuLocations = (id: number) => (open: boolean) => void (open && useApp.getState().loadLocations(id).catch(() => {}));

export function BookCard({ book }: { book: BookSummary }) {
  const { ref, focused } = useFocusedRow(book.id);
  const openBook = useApp((s) => s.openBook);
  const focusBook = useApp((s) => s.focusBook);
  const author = book.authors[0] ?? "Unknown author";
  const loadForMenu = loadMenuLocations(book.id);

  return (
    <li ref={ref} data-book-id={book.id} data-focused={focused} className="group relative">
      <ContextMenu onOpenChange={loadForMenu}>
        <ContextMenuTrigger asChild>
          <button
            className="flex w-full flex-col gap-2 rounded-md text-left outline-none group-data-[focused=true]:ring-2 group-data-[focused=true]:ring-ring group-data-[focused=true]:ring-offset-4 group-data-[focused=true]:ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void openBook(book.id)}
            onFocus={() => focused || focusBook(book.id)}
            aria-label={`${book.title}, ${author}${book.available ? "" : ", missing"}`}
          >
            <div className={book.available ? "" : "opacity-50 grayscale"}>
              <Cover book={book} />
            </div>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-xs font-medium">{book.title}</span>
              <span className="text-[11px] text-muted-foreground">{bookMeta(book)}</span>
            </span>
            {(!book.available || INDEX_BADGE[book.index_state]) && (
              <span className="flex flex-wrap gap-1">
                {!book.available && <Badge variant="destructive">Missing</Badge>}
                {INDEX_BADGE[book.index_state] && (
                  <Badge variant={book.index_state === "failed" ? "destructive" : "outline"} data-testid="index-state" data-state={book.index_state}>
                    {INDEX_BADGE[book.index_state]}
                  </Badge>
                )}
              </span>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <BookMenuItems book={book} kit={contextKit} />
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenu onOpenChange={loadForMenu}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label={`More actions for ${book.title}`}
            className="absolute top-2 right-2 opacity-0 shadow-sm group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <BookMenuItems book={book} kit={dropdownKit} />
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

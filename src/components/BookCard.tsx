import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { coverUrl, type BookSummary } from "@/lib/api";
import { useApp } from "@/lib/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BookMenuItems, contextKit, dropdownKit } from "./BookMenu";

const TINTS = ["#5b7fa6", "#7a6aa0", "#5f8f6e", "#a0735a", "#8a5d73", "#56858a"];

function Cover({ book }: { book: BookSummary }) {
  const [failed, setFailed] = useState(false);
  if (book.has_cover && !failed) {
    return <img src={coverUrl(book.id)} alt="" loading="lazy" className="aspect-[2/3] w-full rounded-md object-cover shadow-sm" onError={() => setFailed(true)} />;
  }
  return (
    <div
      className="flex aspect-[2/3] w-full items-center justify-center rounded-md p-3 text-center text-sm font-semibold text-white shadow-sm"
      style={{ background: TINTS[book.id % TINTS.length] }}
      aria-hidden
    >
      <span className="line-clamp-5">{book.title}</span>
    </div>
  );
}

export function BookCard({ book }: { book: BookSummary }) {
  const ref = useRef<HTMLLIElement>(null);
  const focused = useApp((s) => s.focusedBookId === book.id);
  const openBook = useApp((s) => s.openBook);
  const loadLocations = useApp((s) => s.loadLocations);
  const author = book.authors[0] ?? "Unknown author";
  const loadForMenu = (open: boolean) => void (open && loadLocations(book.id).catch(() => {}));

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);

  return (
    <li ref={ref} data-book-id={book.id} data-focused={focused} className="group relative flex flex-col gap-1.5">
      <ContextMenu onOpenChange={loadForMenu}>
        <ContextMenuTrigger asChild>
          <button
            className="flex flex-col gap-1.5 rounded-lg p-1.5 text-left outline-none group-data-[focused=true]:ring-2 group-data-[focused=true]:ring-ring hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void openBook(book.id)}
            aria-label={`${book.title}, ${author}${book.available ? "" : ", missing"}`}
          >
            <div className={book.available ? "" : "opacity-50 grayscale"}>
              <Cover book={book} />
            </div>
            <span className="line-clamp-2 text-[13px] leading-snug font-semibold">{book.title}</span>
            <span className="truncate text-xs text-muted-foreground">{book.authors.join(", ") || "Unknown author"}</span>
            <span className="flex flex-wrap gap-1">
              {!book.available && <Badge variant="destructive">Missing</Badge>}
              {book.reading_state === "finished" && <Badge variant="secondary">Finished</Badge>}
              <Badge variant="outline">{book.format.toUpperCase()}</Badge>
            </span>
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
            className="absolute top-3 right-3 opacity-0 shadow-sm group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
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

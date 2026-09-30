import { MoreHorizontal } from "lucide-react";
import type { BookSummary } from "@/lib/api";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BookMenuItems, contextKit, dropdownKit } from "./BookMenu";
import { bookMeta, loadMenuLocations, useFocusedRow } from "./BookCard";

const COLUMNS = "grid grid-cols-[minmax(0,1fr)_90px_90px_130px_28px] items-center";

const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const dateLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function DrawerRow({ book }: { book: BookSummary }) {
  const { ref, focused } = useFocusedRow(book.id);
  const openBook = useApp((s) => s.openBook);
  const focusBook = useApp((s) => s.focusBook);
  const loadForMenu = loadMenuLocations(book.id);
  return (
    <li ref={ref} data-book-id={book.id} data-focused={focused} className="group relative border-b">
      <ContextMenu onOpenChange={loadForMenu}>
        <ContextMenuTrigger asChild>
          <button
            className={cn(COLUMNS, "h-11 w-full px-3 text-left text-[13px] outline-none group-data-[focused=true]:bg-accent/60 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset")}
            onClick={() => void openBook(book.id)}
            onFocus={() => focused || focusBook(book.id)}
            aria-label={`${book.title}${book.available ? "" : ", missing"}`}
          >
            <span className="flex min-w-0 items-center gap-3">
              <span aria-hidden className="flex h-7 w-[22px] shrink-0 items-end justify-center rounded-[2px] border bg-reader pb-[3px] text-[7px] font-bold text-[#c4251c]">
                PDF
              </span>
              <span className={book.available ? "truncate" : "truncate text-muted-foreground"}>{book.title}</span>
              {!book.available && <Badge variant="destructive">Missing</Badge>}
            </span>
            <span className="text-muted-foreground">{bookMeta(book)}</span>
            <span className="text-muted-foreground">{sizeLabel(book.file_size)}</span>
            <span className="text-muted-foreground">{dateLabel.format(book.added_at)}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <BookMenuItems book={book} kit={contextKit} />
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenu onOpenChange={loadForMenu}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`More actions for ${book.title}`}
            className="absolute top-1/2 right-2 size-7 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
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

export function DrawerTable({ books }: { books: BookSummary[] }) {
  return (
    <div className="text-[13px]">
      <div className={cn(COLUMNS, "border-b px-3 pb-2 text-[11px] text-muted-foreground")} aria-hidden>
        <span>Name</span>
        <span>Progress</span>
        <span>Size</span>
        <span>Added</span>
      </div>
      <ul className="list-none">
        {books.map((b) => (
          <DrawerRow key={b.id} book={b} />
        ))}
      </ul>
    </div>
  );
}

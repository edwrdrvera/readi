import { useEffect, useState } from "react";
import { coverUrl, type BookSummary } from "@/lib/api";
import { coverSpineColors, type SpineColors } from "@/lib/coverPalette";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { BookMenuItems, contextKit } from "./BookMenu";
import { bookMeta, loadMenuLocations, percentLabel, useFocusedRow } from "./BookCard";

// Paired spine/ink colors from the shelf design; legible on light, dark, and sepia pages alike.
const SPINES = [
  ["#efe6d2", "#3b2f22"],
  ["#1f3a4d", "#f2ede1"],
  ["#2b2b2e", "#e9e4d8"],
  ["#1d2a44", "#e8d6a2"],
  ["#6a5a86", "#f4f0fa"],
  ["#c9573a", "#fff4ec"],
  ["#1f3b2c", "#e7efe5"],
  ["#3e1416", "#f0dcd5"],
  ["#3a2a22", "#f1e7d6"],
  ["#2c4f7a", "#eef3fa"],
  ["#8a7864", "#fbf6ee"],
  ["#4c5340", "#eef0e6"],
  ["#a8624a", "#fff1ea"],
  ["#5f8f6e", "#f2f8f3"],
  ["#b88a8f", "#2a1a1c"],
  ["#56858a", "#f0f7f7"],
] as const;

const serif = "font-[ui-serif,'New_York',Georgia,serif]";

function ctaLabel(book: BookSummary) {
  if (book.reading_state === "finished") return "Read again";
  return book.reading_state === "reading" ? "Continue reading" : "Start reading";
}

function useSpineColors(book: BookSummary): SpineColors {
  const [bg, ink] = SPINES[book.id % SPINES.length];
  const [fromCover, setFromCover] = useState<SpineColors | null>(null);
  useEffect(() => {
    if (!book.has_cover) return setFromCover(null);
    let live = true;
    void coverSpineColors(book.id).then((c) => live && setFromCover(c));
    return () => {
      live = false;
    };
  }, [book.id, book.has_cover]);
  return fromCover ?? { bg, ink };
}

function Spine({ book, open, onPick }: { book: BookSummary; open: boolean; onPick: () => void }) {
  const { ref, focused } = useFocusedRow(book.id);
  const focusBook = useApp((s) => s.focusBook);
  const { bg, ink } = useSpineColors(book);
  const [coverFailed, setCoverFailed] = useState(false);
  const author = book.authors[0] ?? "Unknown author";
  const width = open ? 236 : 34 + ((book.title.length * 7 + book.id * 5) % 16);
  const height = open ? 340 : 280 + ((book.id * 37) % 26);
  return (
    <li ref={ref} data-book-id={book.id} data-focused={focused} className={cn("group flex shrink-0", open && "mx-3.5")}>
      <ContextMenu onOpenChange={loadMenuLocations(book.id)}>
        <ContextMenuTrigger asChild>
          <button
            onClick={onPick}
            onFocus={() => focused || focusBook(book.id)}
            aria-expanded={open}
            aria-label={`${book.title}, ${author}${book.available ? "" : ", missing"}`}
            style={{ width, height, background: bg, color: ink }}
            className={cn(
              "relative overflow-hidden rounded-[2px_3px_3px_2px] outline-none transition-[width,height,transform,box-shadow] duration-350 ease-[cubic-bezier(.2,.8,.2,1)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background group-data-[focused=true]:ring-2 group-data-[focused=true]:ring-ring group-data-[focused=true]:ring-offset-2 group-data-[focused=true]:ring-offset-background motion-reduce:transition-none",
              open
                ? "shadow-[0_18px_30px_-10px_rgb(0_0_0/.45)]"
                : "shadow-[inset_-3px_0_0_rgb(0_0_0/.14),inset_2px_0_0_rgb(255_255_255/.12)] hover:-translate-y-1.5 motion-reduce:hover:translate-y-0",
              !book.available && "opacity-50 grayscale",
            )}
          >
            {open && book.has_cover && !coverFailed ? (
              <>
                <img src={coverUrl(book.id)} alt="" className="absolute inset-0 size-full object-cover" onError={() => setCoverFailed(true)} />
                <span className="absolute inset-y-0 left-0 w-2.5 bg-[linear-gradient(90deg,rgb(0_0_0/.28),rgb(255_255_255/.08)_60%,transparent)]" />
              </>
            ) : open ? (
              <>
                <span className="absolute inset-0 flex flex-col justify-between px-[22px] pt-7 pb-6 text-left">
                  <span className="text-[11px] tracking-[.14em] uppercase opacity-75">{book.format}</span>
                  <span className="flex flex-col gap-2.5">
                    <span className="h-0.5 w-9 bg-current opacity-60" />
                    <span className={cn(serif, "line-clamp-5 text-[28px] leading-[1.1] font-semibold")}>{book.title}</span>
                    <span className="truncate text-[13px] opacity-80">{author}</span>
                  </span>
                </span>
                <span className="absolute inset-y-0 left-0 w-2.5 bg-[linear-gradient(90deg,rgb(0_0_0/.28),rgb(255_255_255/.08)_60%,transparent)]" />
              </>
            ) : (
              <>
                <span
                  className={cn(serif, "absolute top-3.5 left-1/2 max-h-[calc(100%-56px)] -translate-x-1/2 truncate text-sm font-semibold [writing-mode:vertical-rl]")}
                >
                  {book.title}
                </span>
                <span className={cn(serif, "absolute inset-x-0 bottom-3 text-center text-xs italic opacity-60")}>R</span>
              </>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <BookMenuItems book={book} kit={contextKit} />
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

export function LibraryShelf({ books }: { books: BookSummary[] }) {
  const openBook = useApp((s) => s.openBook);
  const [pickedId, setPickedId] = useState<number | null>(null);
  // Derived rather than reset in an effect: a picked book that is filtered out or removed simply stops being picked.
  const picked = books.find((b) => b.id === pickedId) ?? null;
  return (
    <div className="flex flex-col gap-8">
      <div className="overflow-x-auto px-2 pt-6 [scrollbar-width:thin]">
        <ul className="flex h-[360px] min-w-max list-none items-end gap-1 border-b-[6px] border-border px-3 shadow-[0_14px_18px_-12px_rgb(0_0_0/.25)]">
          {books.map((b) => (
            <Spine key={b.id} book={b} open={b.id === pickedId} onPick={() => setPickedId(b.id === pickedId ? null : b.id)} />
          ))}
        </ul>
      </div>
      <div className="h-28 max-w-[760px]">
        {picked ? (
          <section aria-label="Selected book" className="flex h-full items-center gap-6 rounded-lg border bg-popover px-6 py-5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="truncate text-lg font-semibold">{picked.title}</div>
              <div className="truncate text-sm text-muted-foreground">
                {picked.authors.join(", ") || "Unknown author"} · {picked.format.toUpperCase()}
              </div>
              <div className="mt-2 flex items-center gap-2.5">
                <span className="h-1 max-w-[280px] flex-1 overflow-hidden rounded-full bg-muted">
                  <span className="block h-1 rounded-full bg-primary" style={{ width: percentLabel(picked.percent) }} />
                </span>
                <span className="text-xs text-muted-foreground">
                  {picked.reading_state === "reading" ? `${percentLabel(picked.percent)} read` : bookMeta(picked)}
                </span>
              </div>
            </div>
            <Button variant="secondary" onClick={() => setPickedId(null)}>
              Put back
            </Button>
            <Button onClick={() => void openBook(picked.id)}>{ctaLabel(picked)}</Button>
          </section>
        ) : (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            Select a book to see its details
          </div>
        )}
      </div>
    </div>
  );
}

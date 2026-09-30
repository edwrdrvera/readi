import { useEffect, useMemo } from "react";
import type { BookDetail, TocItem } from "@/lib/api";
import { useApp } from "@/lib/store";
import { activeTocItem, flattenToc, outlineToc, type TocEntry } from "@/lib/toc";
import { activeReader } from "@/reader/handle";
import { cn } from "@/lib/utils";

export function ContentsTab({ detail }: { detail: BookDetail }) {
  const open = useApp((s) => s.sidebar.open);
  const position = useApp((s) => s.position);
  const pdfPage = useApp((s) => s.progress.pdfPage);
  const isPdf = detail.book.format === "pdf";
  const flat = useMemo(() => flattenToc(detail.toc), [detail.toc]);
  const outline = useMemo(() => outlineToc(detail.toc), [detail.toc]);
  const active = useMemo(() => activeTocItem(detail, flat, position, pdfPage), [detail, flat, position, pdfPage]);

  useEffect(() => {
    if (open) document.querySelector<HTMLElement>("[data-toc-active]")?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const jump = async (target: string) => {
    const reader = activeReader();
    if (reader?.bookId !== detail.book.id) return;
    await reader.goTo(isPdf ? Number(target) : target);
  };

  const row = (item: TocItem, depth: number, entry: TocEntry | undefined) => {
    const isActive = item === active;
    const matter = entry !== undefined && entry.section !== "body";
    return (
      <button
        data-toc-active={isActive || undefined}
        aria-current={isActive ? "location" : undefined}
        onClick={() => void jump(item.target)}
        className={cn(
          "flex w-full items-baseline gap-2 rounded-md pr-2.5 pl-2.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          matter ? "py-1.5 text-xs text-muted-foreground" : "py-[7px] text-[13px]",
          depth === 0 && item.children.length > 0 && "font-medium",
          isActive && "bg-accent text-accent-foreground hover:bg-accent",
        )}
      >
        {entry?.section === "body" && (
          <span aria-hidden className={cn("w-5 shrink-0 text-right text-xs tabular-nums", !isActive && "text-muted-foreground")}>
            {entry.number}
          </span>
        )}
        <span className="flex-1">{entry?.number ? <><span className="sr-only">{item.label.slice(0, item.label.length - entry.title.length)}</span>{entry.title}</> : item.label}</span>
        {isPdf && (
          <span className="text-[11px] text-muted-foreground tabular-nums" aria-label={`physical page ${Number(item.target) + 1}`}>
            {Number(item.target) + 1}
          </span>
        )}
      </button>
    );
  };

  const render = (items: TocItem[], depth: number) => (
    <ul
      role={depth === 0 ? "tree" : "group"}
      aria-label={depth === 0 ? "Contents" : undefined}
      className={cn("m-0 list-none p-0", depth > 0 && "ml-[22px] border-l pl-1.5")}
    >
      {items.map((item, i) => {
        const entry = depth === 0 ? outline.get(item) : undefined;
        const prev = depth === 0 && i > 0 ? outline.get(items[i - 1]) : undefined;
        return (
          <li
            key={`${item.target}-${i}`}
            role="treeitem"
            aria-selected={item === active}
            aria-expanded={item.children.length ? true : undefined}
            className={cn(prev && entry && prev.section !== entry.section && "mt-3")}
          >
            {row(item, depth, entry)}
            {item.children.length > 0 && render(item.children, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <nav className="px-2.5 pt-1 pb-4">
      {flat.length === 0 ? <p className="p-2.5 text-xs text-muted-foreground">Contents appear once this book has been indexed.</p> : render(detail.toc, 0)}
    </nav>
  );
}

import { useEffect, useMemo, useState } from "react";
import type { BookDetail, TocItem } from "@/lib/api";
import { closeSidebar } from "@/lib/commands";
import { useApp } from "@/lib/store";
import { activeReader } from "@/reader/handle";
import { cn } from "@/lib/utils";

const flatten = (items: TocItem[]): TocItem[] => items.flatMap((i) => [i, ...flatten(i.children)]);

/** The PDF reader exposes its page only through location(), so poll it while shown. */
function usePdfPage(enabled: boolean) {
  const [page, setPage] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const read = () => {
      const l = activeReader()?.location();
      setPage(l?.format === "pdf" ? l.page_index : null);
    };
    read();
    const t = setInterval(read, 400);
    return () => clearInterval(t);
  }, [enabled]);
  return page;
}

export function ContentsTab({ detail }: { detail: BookDetail }) {
  const open = useApp((s) => s.sidebar.open);
  const position = useApp((s) => s.position);
  const isPdf = detail.book.format === "pdf";
  const flat = useMemo(() => flatten(detail.toc), [detail.toc]);
  const pdfPage = usePdfPage(open && isPdf);

  const active = useMemo(() => {
    if (isPdf) {
      if (pdfPage === null) return null;
      return flat.filter((t) => Number(t.target) <= pdfPage).at(-1) ?? null;
    }
    return (
      (position.tocHref && flat.find((t) => t.target === position.tocHref)) ||
      flat.find((t) => t.target === String(position.sectionIndex)) ||
      null
    );
  }, [isPdf, pdfPage, flat, position]);

  useEffect(() => {
    if (open) document.querySelector<HTMLElement>("[data-toc-active]")?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const jump = async (target: string) => {
    const reader = activeReader();
    if (reader?.bookId !== detail.book.id) return;
    await reader.goTo(isPdf ? Number(target) : target);
    if (!useApp.getState().sidebar.pinned) closeSidebar();
  };

  const render = (items: TocItem[], depth: number) => (
    <ul role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? "Contents" : undefined} className="m-0 list-none p-0">
      {items.map((item, i) => {
        const isActive = item === active;
        return (
          <li key={`${item.target}-${i}`} role="treeitem" aria-selected={isActive} aria-expanded={item.children.length ? true : undefined}>
            <button
              data-toc-active={isActive || undefined}
              aria-current={isActive ? "location" : undefined}
              onClick={() => void jump(item.target)}
              className={cn(
                "flex w-full items-baseline gap-2 rounded-md py-1.5 pr-2 text-left text-sm hover:bg-muted",
                isActive && "bg-accent font-medium text-accent-foreground",
              )}
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              <span className="flex-1">{item.label}</span>
              {isPdf && (
                <span className="text-xs text-muted-foreground tabular-nums" aria-label={`physical page ${Number(item.target) + 1}`}>
                  {Number(item.target) + 1}
                </span>
              )}
            </button>
            {item.children.length > 0 && render(item.children, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <nav className="p-2">
      {flat.length === 0 ? <p className="p-2 text-sm text-muted-foreground">Contents appear once this book has been indexed.</p> : render(detail.toc, 0)}
    </nav>
  );
}

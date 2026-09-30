import { useEffect, useMemo } from "react";
import type { BookDetail, TocItem } from "@/lib/api";
import { closeSidebar } from "@/lib/commands";
import { useApp } from "@/lib/store";
import { activeTocItem, flattenToc } from "@/lib/toc";
import { activeReader } from "@/reader/handle";
import { cn } from "@/lib/utils";

export function ContentsTab({ detail }: { detail: BookDetail }) {
  const open = useApp((s) => s.sidebar.open);
  const position = useApp((s) => s.position);
  const pdfPage = useApp((s) => s.progress.pdfPage);
  const isPdf = detail.book.format === "pdf";
  const flat = useMemo(() => flattenToc(detail.toc), [detail.toc]);
  const active = useMemo(() => activeTocItem(detail, flat, position, pdfPage), [detail, flat, position, pdfPage]);

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
                "flex w-full items-baseline gap-2 rounded-md py-[7px] pr-2.5 text-left text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                isActive && "bg-accent text-accent-foreground hover:bg-accent",
              )}
              style={{ paddingLeft: 10 + depth * 14 }}
            >
              <span className="flex-1">{item.label}</span>
              {isPdf && (
                <span className="text-[11px] text-muted-foreground tabular-nums" aria-label={`physical page ${Number(item.target) + 1}`}>
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
    <nav className="px-2.5 pt-1 pb-4">
      {flat.length === 0 ? <p className="p-2.5 text-xs text-muted-foreground">Contents appear once this book has been indexed.</p> : render(detail.toc, 0)}
    </nav>
  );
}

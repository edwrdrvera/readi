import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { BookDetail } from "@/lib/api";
import type { Prefs } from "@/lib/prefs";
import { useApp } from "@/lib/store";
import { activeReader } from "@/reader/handle";
import { useSectionLabel } from "./ReaderChrome";

function PageArrow({ side }: { side: "left" | "right" }) {
  return (
    <button
      aria-label={side === "left" ? "Previous page" : "Next page"}
      tabIndex={-1}
      className="flex w-14 shrink-0 items-center justify-center text-muted-foreground outline-none hover:text-foreground [&_svg]:size-[18px]"
      onClick={() => void (side === "left" ? activeReader()?.goLeft() : activeReader()?.goRight())}
    >
      {side === "left" ? <ChevronLeft /> : <ChevronRight />}
    </button>
  );
}

function ReaderFooter({ detail }: { detail: BookDetail }) {
  const { percent, pdfPageLabel } = useApp((s) => s.progress);
  const section = useSectionLabel(detail);
  const label = detail.book.format === "pdf" ? (pdfPageLabel ? `Page ${pdfPageLabel}` : "") : (section ?? "");
  const pct = `${Math.round((percent ?? 0) * 100)}%`;
  return (
    <footer className="flex h-9 shrink-0 items-center gap-3.5 px-7 text-[11px] text-muted-foreground">
      <span className="max-w-[40%] truncate tabular-nums" aria-live="polite">
        {label}
      </span>
      <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-[3px] bg-primary" style={{ width: pct }} />
      </span>
      <span className="tabular-nums">{pct}</span>
    </footer>
  );
}

export function ReaderPage({ detail, prefs, children }: { detail: BookDetail; prefs: Prefs; children: ReactNode }) {
  const paged = prefs.reading_mode === "horizontal";
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {paged && <PageArrow side="left" />}
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        {paged && <PageArrow side="right" />}
      </div>
      <ReaderFooter detail={detail} />
    </div>
  );
}

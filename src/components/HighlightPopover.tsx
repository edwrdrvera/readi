import { useEffect } from "react";
import { NotebookPen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HIGHLIGHT_COLORS, type HighlightColor } from "@/lib/api";
import { readerFor } from "@/lib/jumps";
import { useApp } from "@/lib/store";

export const SWATCH: Record<HighlightColor, string> = {
  yellow: "#f5d547",
  green: "#7fcf7a",
  blue: "#7fb2f0",
  pink: "#f09ac4",
};

const POPOVER_H = 40;

/** Once the open book's reader registers: draw highlights, follow its selection, and open clicked highlights. */
export function useReaderAnnotations(bookId: number) {
  useEffect(() => {
    let off = () => {};
    let live = true;
    void readerFor(bookId).then((reader) => {
      if (!live || !reader) return;
      void useApp.getState().redrawHighlights();
      off = reader.onSelection((s) => useApp.getState().setSelection(s));
    });
    const click = (e: Event) => {
      const id = (e as CustomEvent<{ id: number }>).detail?.id;
      if (typeof id === "number" && useApp.getState().annotations.some((a) => a.id === id)) useApp.getState().setEditing(id);
    };
    window.addEventListener("readi:annotation-click", click);
    return () => {
      live = false;
      off();
      window.removeEventListener("readi:annotation-click", click);
      useApp.getState().setSelection(null);
    };
  }, [bookId]);
}

export function HighlightPopover() {
  const selection = useApp((s) => s.selection);
  const addHighlight = useApp((s) => s.addHighlight);
  const setEditing = useApp((s) => s.setEditing);
  if (!selection) return null;
  const { rect } = selection;
  const above = rect.y > POPOVER_H + 56;
  const top = above ? rect.y - POPOVER_H - 6 : rect.y + rect.height + 6;
  const left = Math.min(Math.max(8, rect.x + rect.width / 2 - 110), window.innerWidth - 228);

  return (
    <div
      role="toolbar"
      aria-label="Highlight selection"
      data-testid="highlight-popover"
      className="fixed z-40 flex items-center gap-1 rounded-lg border bg-popover p-1 shadow-lg"
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c}
          data-testid={`highlight-color-${c}`}
          aria-label={`Highlight ${c}`}
          className="size-6 rounded-full border border-black/10 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ background: SWATCH[c] }}
          onClick={() => void addHighlight(c)}
        />
      ))}
      <Button
        variant="ghost"
        size="sm"
        data-testid="highlight-add-note"
        onClick={async () => {
          const a = await addHighlight("yellow");
          if (a) setEditing(a.id);
        }}
      >
        <NotebookPen /> Add note
      </Button>
    </div>
  );
}

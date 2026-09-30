import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HIGHLIGHT_COLORS, type Annotation } from "@/lib/api";
import { positionLabel } from "@/lib/annotations";
import { flushNotes, noteSaver, releaseNote, type NoteStatus } from "@/lib/notes";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { SWATCH } from "./HighlightPopover";

/** The Annotations tab entry being edited: quote, colour, note, delete. */
export function AnnotationCard({ annotation }: { annotation: Annotation }) {
  const { id } = annotation;
  const setEditing = useApp((s) => s.setEditing);
  const updateAnnotation = useApp((s) => s.updateAnnotation);
  const schedule = useApp((s) => s.schedule);
  const [saver] = useState(() => noteSaver(id, annotation.note ?? "", (note) => updateAnnotation(id, { note })));
  const [text, setText] = useState(saver.text);
  const [status, setStatus] = useState<NoteStatus>(saver.status);
  const field = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    field.current?.focus();
    const offStatus = saver.subscribe(setStatus);
    const flush = () => void flushNotes();
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", flush);
    const unlisten = getCurrentWindow().onCloseRequested(() => flushNotes());
    return () => {
      offStatus();
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", flush);
      void unlisten.then((u) => u());
      void releaseNote(id);
      const from = opener.current instanceof HTMLElement && opener.current !== document.body ? opener.current : null;
      requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>(`[data-testid="annotation-item"][data-id="${id}"] button`);
        (from?.isConnected ? from : (row ?? document.querySelector<HTMLElement>("[data-reading-region]")))?.focus();
      });
    };
  }, [id, saver]);

  const [colorError, setColorError] = useState<string | null>(null);
  const isHighlight = annotation.kind === "highlight";

  return (
    <li
      aria-label={isHighlight ? "Edit highlight" : "Edit bookmark"}
      data-testid="annotation-editor"
      data-id={id}
      className="note-card flex flex-col gap-2.5 rounded-lg border bg-popover p-3 text-sm shadow-[0_1px_2px_rgba(0,0,0,.08)]"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        setEditing(null);
      }}
    >
      <div className="flex items-start gap-2">
        <p className="line-clamp-4 flex-1 text-[13px] leading-snug">
          {annotation.quote || positionLabel(annotation)}
        </p>
        <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1" aria-label="Close editor" onClick={() => setEditing(null)}>
          <X />
        </Button>
      </div>
      {isHighlight && (
        <div role="radiogroup" aria-label="Highlight color" className="flex gap-1.5">
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={annotation.color === c}
              aria-label={c}
              data-testid={`editor-color-${c}`}
              className={cn("size-6 rounded-full border border-black/10 outline-none focus-visible:ring-2 focus-visible:ring-ring", annotation.color === c && "ring-2 ring-foreground/60")}
              style={{ background: SWATCH[c] }}
              onClick={() =>
                void updateAnnotation(id, { color: c }).then(
                  () => setColorError(null),
                  (e) => setColorError(String(e)),
                )
              }
            />
          ))}
        </div>
      )}
      {colorError && (
        <p role="alert" className="text-xs text-destructive">
          Could not change the color: {colorError}
        </p>
      )}
      <textarea
        ref={field}
        data-testid="note-editor"
        aria-label="Note"
        placeholder="Add a note"
        rows={4}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          saver.update(e.target.value);
        }}
        onBlur={() => void saver.flush()}
        className="w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-2">
        <span data-testid="note-status" data-state={status.kind} role="status" className={cn("flex-1 text-xs", status.kind === "error" ? "text-destructive" : "text-muted-foreground")}>
          {status.kind === "saving" && "Saving…"}
          {status.kind === "saved" && "Saved"}
          {status.kind === "error" && (
            <>
              Note not saved.{" "}
              <Button variant="link" size="sm" className="h-auto p-0 text-xs" data-testid="note-retry" onClick={() => void saver.flush()}>
                Retry
              </Button>
            </>
          )}
        </span>
        <Button variant="ghost" size="sm" aria-label={isHighlight ? "Delete highlight" : "Delete bookmark"} onClick={() => schedule({ kind: "delete-annotation", annotationId: id })}>
          <Trash2 /> Delete
        </Button>
      </div>
    </li>
  );
}

import { useEffect } from "react";
import { useApp } from "@/lib/store";

/** The one Undo bar, bottom centre, for the action waiting in store.pending. */
export function UndoBar() {
  const pending = useApp((s) => s.pending);
  const { undo, holdPending } = useApp.getState();

  useEffect(() => {
    const sync = () => holdPending("hidden", document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [holdPending]);

  useEffect(() => {
    if (!pending) holdPending("hover", false);
  }, [pending, holdPending]);

  if (!pending) return null;
  return (
    <div
      role="status"
      data-testid="undo-bar"
      data-kind={pending.action.kind}
      onMouseEnter={() => holdPending("hover", true)}
      onMouseLeave={() => holdPending("hover", false)}
      className="undo-bar fixed bottom-4 left-1/2 z-50 flex h-11 max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-center gap-4 rounded-lg bg-foreground pr-2 pl-4 text-[13px] text-background shadow-[0_8px_24px_-6px_color-mix(in_oklab,var(--foreground)_35%,transparent)]"
    >
      <span className="min-w-0 truncate">{pending.message}</span>
      <button type="button" className="h-8 shrink-0 rounded-md px-3 font-medium text-[color-mix(in_oklab,var(--primary)_55%,var(--background))] hover:bg-background/10" onClick={undo}>
        Undo
      </button>
    </div>
  );
}

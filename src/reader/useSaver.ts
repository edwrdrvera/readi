import { useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ProgressSaver } from "../lib/progress";
import { useApp } from "../lib/store";

/** One saver per open book, flushed on blur, hide, unmount, and window close. */
export function useSaver(bookId: number) {
  const setSaveStatus = useApp((s) => s.setSaveStatus);
  const setProgress = useApp((s) => s.setProgress);
  const saver = useMemo(
    () => new ProgressSaver(bookId, setSaveStatus, (loc, percent) => setProgress({ percent, pdfPage: loc.format === "pdf" ? loc.page_index : null })),
    [bookId, setSaveStatus, setProgress],
  );
  useEffect(() => {
    const flush = () => void saver.flush();
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", flush);
    const unlisten = getCurrentWindow().onCloseRequested(() => saver.flush());
    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", flush);
      void unlisten.then((u) => u());
      void saver.flush();
    };
  }, [saver]);
  return saver;
}

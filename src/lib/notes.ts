export type NoteStatus = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

export const NOTE_IDLE_MS = 600;

/**
 * Saves a note after a typing pause. The draft is only reported saved once the
 * backend accepted that exact text; a failure keeps it for Retry.
 */
export class NoteSaver {
  private draft: string;
  private saved: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> = Promise.resolve();
  private listeners = new Set<(s: NoteStatus) => void>();
  status: NoteStatus = { kind: "idle" };

  constructor(
    initial: string,
    private save: (note: string | null) => Promise<void>,
  ) {
    this.draft = this.saved = initial;
  }

  get text() {
    return this.draft;
  }

  get dirty() {
    return this.draft !== this.saved;
  }

  subscribe(cb: (s: NoteStatus) => void) {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private set(s: NoteStatus) {
    this.status = s;
    this.listeners.forEach((l) => l(s));
  }

  update(text: string) {
    this.draft = text;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), NOTE_IDLE_MS);
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.inflight = this.inflight.then(async () => {
      const text = this.draft;
      if (text === this.saved) return;
      this.set({ kind: "saving" });
      try {
        await this.save(text.trim() === "" ? null : text);
        this.saved = text;
        this.set(this.draft === text ? { kind: "saved" } : { kind: "saving" });
      } catch (e) {
        this.set({ kind: "error", message: String(e) });
      }
    });
    return this.inflight;
  }
}

/** Open or unsaved notes by annotation id; an unsaved draft outlives its editor. */
const savers = new Map<number, NoteSaver>();

export function noteSaver(id: number, initial: string, save: (note: string | null) => Promise<void>): NoteSaver {
  let s = savers.get(id);
  if (!s) savers.set(id, (s = new NoteSaver(initial, save)));
  return s;
}

/** The editor closed: forget the saver once nothing is left to save. */
export async function releaseNote(id: number) {
  const s = savers.get(id);
  if (!s) return;
  await s.flush();
  if (!s.dirty) savers.delete(id);
}

export const dropNote = (id: number) => void savers.delete(id);

/** Flushes every open or unsaved note, for leaving the book or the window. */
export const flushNotes = () => Promise.all([...savers.values()].map((s) => s.flush())).then(() => {});

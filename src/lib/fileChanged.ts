type Listener = (bookId: number) => void;

const listeners = new Set<Listener>();

/** The book:// protocol answers 409 when a watched file changed since it was opened. */
export const HTTP_FILE_CHANGED = 409;

export function reportFileChanged(bookId: number) {
  listeners.forEach((l) => l(bookId));
}

export function onFileChanged(l: Listener) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

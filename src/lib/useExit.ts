import { useEffect, useState } from "react";

/** Keeps the last non-null value on screen for `ms` after it goes null, so an exit transition can run. */
export function useExit<T>(value: T | null, ms: number): { shown: T | null; leaving: boolean } {
  const [last, setLast] = useState(value);
  if (value !== null && value !== last) setLast(value);
  useEffect(() => {
    if (value !== null) return;
    const t = setTimeout(() => setLast(null), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return { shown: value ?? last, leaving: value === null && last !== null };
}

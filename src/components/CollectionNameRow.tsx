import { useEffect, useRef, useState } from "react";
import { Tag } from "lucide-react";
import { useApp } from "@/lib/store";

/** Checks a collection name against the manual collections, ignoring `selfId`. */
export function nameError(name: string, names: { id: number; name: string }[], selfId: number | null): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Enter a name";
  const taken = names.some((c) => c.id !== selfId && c.name.trim().toLowerCase() === trimmed.toLowerCase());
  return taken ? `A collection named “${trimmed}” already exists` : null;
}

/**
 * The sidebar row as an input: Return and blur save, Esc cancels. A blur that
 * would only fail on an empty new name cancels instead, so the row never traps focus.
 */
export function CollectionNameRow({ collectionId, initial, onSave }: { collectionId: number | null; initial: string; onSave(name: string): Promise<string | null> }) {
  const collections = useApp((s) => s.collections);
  const setEditor = useApp((s) => s.setCollectionEditor);
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // A closing menu may move focus after this row mounts; blurs before the row has taken focus don't count.
  const settled = useRef(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      input.current?.focus();
      settled.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, []);
  const manual = collections.filter((c) => c.kind === "manual");

  const save = async (fromBlur: boolean) => {
    if (saving.current) return;
    if (fromBlur && (name.trim() === "" || name.trim() === initial)) return setEditor(null);
    if (name.trim() === initial && initial !== "") return setEditor(null);
    const invalid = nameError(name, manual, collectionId);
    if (invalid) return setError(invalid);
    saving.current = true;
    const failed = await onSave(name.trim());
    saving.current = false;
    if (failed) setError(failed);
    else setEditor(null);
  };

  return (
    <li className="flex flex-col gap-1 py-px">
      <div className="flex h-[30px] items-center gap-2.5 rounded-md bg-background px-2.5 ring-2 ring-ring [&_svg]:size-4 [&_svg]:shrink-0">
        <Tag />
        <input
          ref={input}
          autoFocus
          aria-label="Collection name"
          aria-invalid={error !== null}
          aria-describedby={error ? "collection-name-error" : undefined}
          placeholder="Collection name"
          value={name}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save(false);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditor(null);
            }
          }}
          onBlur={() => settled.current && void save(true)}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
        />
      </div>
      {error && (
        <p id="collection-name-error" role="alert" className="px-2.5 text-[11px] text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

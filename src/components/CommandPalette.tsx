import { useMemo } from "react";
import { paletteItems, runFromPalette, takePaletteOpener } from "@/lib/commands";
import { useApp } from "@/lib/store";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";

const KEY_GLYPHS: Record<string, string> = { "\\": "\\", "[": "[", "=": "+", "-": "−" };

function shortcutText(c: ReturnType<typeof paletteItems>[number]) {
  const s = c.shortcuts.find((x) => x.meta);
  if (!s) return null;
  return `${s.shift ? "⇧" : ""}⌘${KEY_GLYPHS[s.key] ?? s.key.toUpperCase()}`;
}

/** A searchable view over the command registry. */
export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);
  // Re-derive when anything a contextual command depends on changes.
  const screen = useApp((s) => s.screen);
  const books = useApp((s) => s.books);
  const collections = useApp((s) => s.collections);
  const view = useApp((s) => s.uiSettings.library);
  const items = useMemo(() => (open ? paletteItems() : []), [open, screen, books, collections, view]);
  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        takePaletteOpener()?.focus();
      }}
    >
      <CommandInput placeholder="Type a command…" />
      <CommandList>
        <CommandEmpty>No matching commands.</CommandEmpty>
        <CommandGroup>
          {items.map((c) => (
            <CommandItem key={c.id} value={c.id} keywords={[c.label]} data-command-id={c.id} onSelect={() => runFromPalette(c)}>
              {c.label}
              {shortcutText(c) && <CommandShortcut>{shortcutText(c)}</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

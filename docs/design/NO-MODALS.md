# No modal popups brief

The user does not want modal popups. Source of truth: the canvas "Readi without modals" (boards summarized below; the motion spec is at the end). Every surface stays inside the window's own layout. Floating non-blocking menus (context menus, "..." dropdowns, the highlight colour popover at a selection, Select lists) stay.

Remove every use of `Dialog`, `Sheet`, `AlertDialog`, and `CommandDialog`. When done, `grep -rn "ui/dialog\|ui/sheet\|ui/alert-dialog\|CommandDialog" src` returns nothing outside `src/components/ui/`, and delete the now-unused `ui/*` primitives.

## 1. Settings is a page (`SettingsSheet.tsx` → `SettingsPage.tsx`)

- `Screen` gains `{ name: "settings" }` (model it in the existing `Screen` union in `src/lib/store.ts`, not a boolean). `openSettings()` switches to it and remembers the previous screen; Back / Esc / ⌘, again returns to it. From the reader, leaving settings returns to the same book and position.
- Layout: the library sidebar gets a Settings row pinned to its bottom (active = accent). The main pane is a 52px top bar titled "Settings", then a 160px section list (Reading, Watched folders, Excluded books; anchor links) beside a 560px column of rows: label left, control right, hairline between rows. Reuse `PrefsForm`, `AlwaysShowControlsSetting`, `WatchedFoldersSettings`, `ExcludedBooksSettings`.
- The reader's gear button opens this page.

## 2. Book info docks right (`BookInfoSheet.tsx` → `BookInfoPanel.tsx`)

- A 300px right panel inside the Library layout (left border, 52px header "Info" + close button), next to the grid, not over it. The selected card keeps its focus ring. Same content as today plus Open / Show in Finder buttons. Esc closes it and focuses the card.

## 3. Search and commands inline (`LibrarySearch.tsx`, `CommandPalette.tsx`)

- The top-bar search button becomes a real input in place. Focusing it (click, ⌘K, ⌘F in the library) swaps the library body for results: an "Actions" group (the command palette's commands, filtered by the same query, with shortcuts right-aligned) then the passage results LibrarySearch shows today. Arrow keys move, Return runs, Esc clears and restores the grid. One component; delete the palette's dialog.
- In the reader, ⌘K focuses the same field placed in the reader toolbar's centre (replacing the title while focused) with actions only; book search stays the sidebar Search tab.

## 4. Undo replaces confirmation (`Confirmations.tsx` → `UndoBar.tsx`)

- Rename `Confirmation` to `PendingAction` (same union). `setConfirmation` becomes `schedule(action)`: the item is hidden immediately (books/collections/folders filtered by pending ids in selectors), an undo bar shows "Removed "Title" from the library" / "Deleted the managed copy of "Title"" / "Deleted "Name"" / "Removed folder "path"" with an Undo button, and the real API call runs when the bar expires (6 s), when another action is scheduled (commit the older one first), or on window close (`onCloseRequested` flushes before closing). Undo cancels without any backend call. Timer pauses while hovered and while the document is hidden.
- Crash during the window means the action never ran. That is the safe direction; say so in one comment.
- Bar: bottom-centre of the window, 44px, `bg-foreground text-background`, radius 8px, tinted shadow, Undo in `primary` colour for the dark surface. One at a time. `role="status"`.

## 5. Collections rename and create in place (`CollectionEditor.tsx`)

- Rename: the sidebar row becomes an input (2px ring), Return saves, Esc cancels, blur saves. Create (+ button, and "New collection with selection" from book menus): a new input row appears at the end of the list, focused. Empty or duplicate name shows the error text under the row in `destructive`, row stays open.

## 6. Notes edit in the sidebar (`AnnotationEditor.tsx`)

- Editing an annotation opens the Annotations tab of the reader sidebar (opening the sidebar if closed) and turns that entry into an editable card: quote, four colour swatches, note textarea autosaving through the existing notes flush path, Delete (goes through the undo bar as a new `PendingAction` kind `delete-annotation` if deletion exists today), "Saved" status text.

## 7. Copy and motion

- Reader toolbar: no em-dash between title and section; section label follows with a 10px gap in muted colour. Grep the UI for `—` and `–` in visible strings and remove them.
- Add to `src/styles.css`: `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`.
- Pressable controls (`ui/button` and plain buttons in the new surfaces): `transition: transform 160ms var(--ease-out)`, `:active { transform: scale(0.97) }`.
- Info panel and note card enter 220ms (translateX(24px) / scale(0.97) + opacity, via `@starting-style`), exit 150ms. Undo bar enters from its own height 260ms, exits 180ms.
- No animation for: search results, the Settings screen swap, inline rename, sidebar tabs.
- Hover tints only under `@media (hover: hover) and (pointer: fine)`.
- The existing `prefers-reduced-motion` block in `styles.css` zeroes all durations. Change it to keep opacity/colour transitions and drop transform movement.

## Constraints

- Keep keyboard commands working and update `src/lib/commands.ts` for the new targets. Keep every selector the selftests use, or update the selftests in the same commit and list each change. Grep `src/selftest*.ts` and `scripts/packaged-check*.mjs` for `dialog`, `sheet`, `role="dialog"`, confirmation button labels before starting; those tests will need the new flow (e.g. confirm → wait for the undo bar to expire or call a flush).
- Vitest unit tests for the pending-action scheduler: undo cancels, expiry commits exactly once, scheduling a second commits the first, flush commits all.
- Green before done: `pnpm tsc --noEmit`, `pnpm test`, `cargo test`, `pnpm build`.

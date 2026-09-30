import type { ComponentType, ReactNode } from "react";
import type { BookSummary } from "@/lib/api";
import { useApp } from "@/lib/store";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";

interface MenuKit {
  Item: ComponentType<{ onSelect?(e: Event): void; variant?: "destructive"; children: ReactNode }>;
  CheckboxItem: ComponentType<{ checked: boolean; onCheckedChange(v: boolean): void; onSelect?(e: Event): void; children: ReactNode }>;
  Separator: ComponentType;
  Sub: ComponentType<{ children: ReactNode }>;
  SubTrigger: ComponentType<{ children: ReactNode }>;
  SubContent: ComponentType<{ children: ReactNode }>;
}

export const dropdownKit: MenuKit = {
  Item: DropdownMenuItem,
  CheckboxItem: DropdownMenuCheckboxItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

export const contextKit: MenuKit = {
  Item: ContextMenuItem,
  CheckboxItem: ContextMenuCheckboxItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

/** The book actions, shared by the More button and the right-click menu. */
export function BookMenuItems({ book, kit }: { book: BookSummary; kit: MenuKit }) {
  const { Item, CheckboxItem, Separator, Sub, SubTrigger, SubContent } = kit;
  const collections = useApp((s) => s.collections);
  const locations = useApp((s) => s.locations[book.id]);
  const s = useApp.getState();
  const manual = collections.filter((c) => c.kind === "manual");
  const canDeleteCopy = !!locations && locations.length > 1 && locations.some((l) => l.kind === "managed");
  return (
    <>
      <Item onSelect={() => void s.openBook(book.id)}>Open</Item>
      {book.reading_state === "finished" ? (
        <Item onSelect={() => void s.setReadingState(book.id, "unread")}>Mark as Unread</Item>
      ) : (
        <Item onSelect={() => void s.setReadingState(book.id, "finished")}>Mark as Finished</Item>
      )}
      <Sub>
        <SubTrigger>Add to Collection</SubTrigger>
        <SubContent>
          {manual.map((c) => (
            <CheckboxItem
              key={c.id}
              checked={book.collection_ids.includes(c.id)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(member) => void s.setMembership(c.id, [book.id], member)}
            >
              {c.name}
            </CheckboxItem>
          ))}
          {manual.length > 0 && <Separator />}
          <Item onSelect={() => s.setCollectionEditor({ mode: "create", addBookIds: [book.id] })}>New Collection…</Item>
        </SubContent>
      </Sub>
      <Item onSelect={() => s.showBookInfo(book.id)}>Book Info…</Item>
      <Separator />
      {canDeleteCopy && (
        <Item variant="destructive" onSelect={() => s.schedule({ kind: "delete-copy", bookId: book.id })}>
          Delete Managed Copy
        </Item>
      )}
      <Item variant="destructive" onSelect={() => s.schedule({ kind: "remove-book", bookId: book.id })}>
        Remove from Library
      </Item>
    </>
  );
}

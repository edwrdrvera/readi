import type { ReactNode } from "react";
import type { Location } from "@/lib/api";
import { useApp, type Confirmation } from "@/lib/store";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface Copy {
  title: string;
  body: ReactNode;
  action: string;
}

const dirname = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

function removeBookBody(locations: Location[] | undefined, folderPath: (l: Location) => string) {
  const watched = locations?.filter((l) => l.kind === "watched") ?? [];
  const managed = locations?.some((l) => l.kind === "managed") ?? false;
  return (
    <>
      <p>Reading progress, settings, and collection membership for this book are deleted.</p>
      {watched.map((l) => (
        <p key={l.id}>
          The original in {folderPath(l)} is not deleted, and Readi won't re-add it on the next scan. You can restore it in Settings &gt; Excluded Books.
        </p>
      ))}
      {managed && <p>Readi's copy of the file is deleted.</p>}
    </>
  );
}

function useCopy(c: Confirmation | null): Copy | null {
  const books = useApp((s) => s.books);
  const collections = useApp((s) => s.collections);
  const folders = useApp((s) => s.folders);
  const locations = useApp((s) => s.locations);
  if (!c) return null;
  const folderPath = (l: Location) => folders.find((f) => f.id === l.watched_folder_id)?.path ?? dirname(l.path);
  switch (c.kind) {
    case "remove-book": {
      const title = books.find((b) => b.id === c.bookId)?.title ?? "this book";
      return { title: `Remove “${title}” from the Library?`, body: removeBookBody(locations[c.bookId], folderPath), action: "Remove from Library" };
    }
    case "delete-copy": {
      const title = books.find((b) => b.id === c.bookId)?.title ?? "this book";
      return {
        title: `Delete Readi’s copy of “${title}”?`,
        body: <p>Readi deletes the file it keeps in its library folder. The book stays in the Library and opens from its other location. Progress and settings are kept.</p>,
        action: "Delete Managed Copy",
      };
    }
    case "delete-collection": {
      const name = collections.find((x) => x.id === c.collectionId)?.name ?? "this collection";
      return { title: `Delete the collection “${name}”?`, body: <p>The books in it stay in the Library.</p>, action: "Delete Collection" };
    }
    case "remove-folder": {
      const path = folders.find((f) => f.id === c.folderId)?.path ?? "this folder";
      return {
        title: "Stop watching this folder?",
        body: (
          <>
            <p>Readi stops watching {path}. Files in it are not touched.</p>
            <p>Books found only there stay in the Library as Missing, with their progress kept.</p>
          </>
        ),
        action: "Remove Folder",
      };
    }
  }
}

/** Every destructive confirmation in the app, driven by store.confirmation. */
export function Confirmations() {
  const confirmation = useApp((s) => s.confirmation);
  const setConfirmation = useApp((s) => s.setConfirmation);
  const confirm = useApp((s) => s.confirm);
  const copy = useCopy(confirmation);
  return (
    <AlertDialog open={copy !== null} onOpenChange={(o) => !o && setConfirmation(null)}>
      {copy && (
        <AlertDialogContent data-confirmation={confirmation?.kind}>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2">{copy.body}</div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirm()}>
              {copy.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}

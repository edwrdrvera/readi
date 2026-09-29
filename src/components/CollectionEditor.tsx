import { useEffect, useState } from "react";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function CollectionEditor() {
  const editor = useApp((s) => s.collectionEditor);
  const collections = useApp((s) => s.collections);
  const setEditor = useApp((s) => s.setCollectionEditor);
  const create = useApp((s) => s.createCollection);
  const rename = useApp((s) => s.renameCollection);
  const current = editor?.mode === "rename" ? collections.find((c) => c.id === editor.collectionId) : undefined;
  const [name, setName] = useState("");

  useEffect(() => setName(current?.name ?? ""), [editor, current?.name]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!editor || !trimmed) return;
    setEditor(null);
    void (editor.mode === "create" ? create(trimmed, editor.addBookIds) : rename(editor.collectionId, trimmed));
  };

  return (
    <Dialog open={editor !== null} onOpenChange={(o) => !o && setEditor(null)}>
      <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{editor?.mode === "rename" ? "Rename Collection" : "New Collection"}</DialogTitle>
          </DialogHeader>
          <Input autoFocus aria-label="Collection name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {editor?.mode === "rename" ? "Rename" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

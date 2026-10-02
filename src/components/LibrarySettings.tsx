import { open } from "@tauri-apps/plugin-dialog";
import type { LibraryLayout, WatchedFolder } from "@/lib/api";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const ACCESS: Record<WatchedFolder["access_state"], string> = {
  ok: "Available",
  unavailable: "Folder unavailable",
  permission_denied: "Permission denied",
};

const scanned = (t: number | null) => (t === null ? "Not scanned yet" : `Scanned ${new Date(t).toLocaleString()}`);

export function WatchedFoldersSettings() {
  const folders = useApp((s) => s.folders);
  const { addFolder, schedule, setFolderCollection, rescan } = useApp.getState();
  const add = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") await addFolder(picked);
  };
  return (
    <section className="flex flex-col gap-3 pt-7" id="settings-folders" aria-labelledby="watched-folders">
      <div className="flex items-center justify-between">
        <h2 id="watched-folders" className="text-[11px] font-semibold tracking-[.02em] text-muted-foreground">
          Watched folders
        </h2>
        <div className="flex gap-1">
          {folders.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => void rescan()}>
              Rescan
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void add()}>
            Add Folder…
          </Button>
        </div>
      </div>
      {folders.length === 0 ? (
        <p className="text-xs text-muted-foreground">Books in a watched folder appear in the Library and stay where they are.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {folders.map((f) => (
            <li key={f.id} className="flex flex-col gap-1.5 rounded-md border p-2.5 text-xs" data-access={f.access_state}>
              <code className="break-all">{f.path}</code>
              <span className={f.access_state === "ok" ? "text-muted-foreground" : "text-destructive"}>
                {ACCESS[f.access_state]} · {scanned(f.last_scan_at)}
              </span>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2">
                  <Switch checked={f.show_collection} onCheckedChange={(v) => void setFolderCollection(f.id, v)} />
                  Show as collection
                </label>
                <Button variant="ghost" size="sm" className="h-7 text-destructive" onClick={() => schedule({ kind: "remove-folder", folderId: f.id })}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ExcludedBooksSettings() {
  const exclusions = useApp((s) => s.exclusions);
  const restore = useApp((s) => s.restoreExclusion);
  return (
    <section className="flex flex-col gap-3 pt-7" id="settings-excluded" aria-labelledby="excluded-books">
      <h2 id="excluded-books" className="text-[11px] font-semibold tracking-[.02em] text-muted-foreground">
        Excluded books
      </h2>
      {exclusions.length === 0 ? (
        <p className="text-xs text-muted-foreground">Books you removed from the Library that are still in a watched folder appear here. Restore one to add it again on the next scan.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {exclusions.map((e) => (
            <li key={`${e.folder_path}:${e.sha256}`} className="flex items-center gap-2 text-xs">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{e.title}</span>
                <span className="truncate text-muted-foreground">{e.folder_path}</span>
              </div>
              <Button variant="outline" size="sm" className="h-7" onClick={() => void restore(e)}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AlwaysShowControlsSetting() {
  const on = useApp((s) => s.uiSettings.always_show_controls);
  const setUiSettings = useApp((s) => s.setUiSettings);
  return (
    <label className="flex min-h-12 items-center justify-between gap-4 border-b py-2 text-[13px]">
      Always show controls
      <Switch checked={on} onCheckedChange={(v) => void setUiSettings({ always_show_controls: v })} />
    </label>
  );
}

export function LibraryLayoutSetting() {
  const layout = useApp((s) => s.uiSettings.library_layout);
  const setUiSettings = useApp((s) => s.setUiSettings);
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 border-b py-2 text-[13px]">
      <span id="library-layout">Layout</span>
      <ToggleGroup
        type="single"
        value={layout}
        onValueChange={(v) => v && void setUiSettings({ library_layout: v as LibraryLayout })}
        aria-labelledby="library-layout"
        className="w-40"
      >
        <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
        <ToggleGroupItem value="shelf">Shelf</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

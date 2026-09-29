import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { useApp } from "@/lib/store";
import { PrefsForm } from "./PrefsForm";
import { AlwaysShowControlsSetting, ExcludedBooksSettings, WatchedFoldersSettings } from "./LibrarySettings";

let opener: HTMLElement | null = null;
export function openSettings() {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  useApp.getState().setSettingsOpen(true);
}

/** Global reading defaults. Books with their own settings keep them. */
export function SettingsSheet() {
  const open = useApp((s) => s.settingsOpen);
  const setOpen = useApp((s) => s.setSettingsOpen);
  const defaults = useApp((s) => s.defaults);
  const setDefault = useApp((s) => s.setDefault);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        className="overflow-y-auto"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          (opener?.isConnected ? opener : document.querySelector<HTMLElement>("[data-reading-region]"))?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>Defaults for every book. Changes made while reading a book apply to that book only.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">
          <h3 className="text-sm font-semibold">Reading</h3>
          <PrefsForm values={defaults} groups={["layout"]} onChange={(k, v) => void setDefault(k, v)} />
          <AlwaysShowControlsSetting />
          <Separator />
          <h3 className="text-sm font-semibold">EPUB text</h3>
          <PrefsForm values={defaults} groups={["text"]} onChange={(k, v) => void setDefault(k, v)} />
          <Separator />
          <h3 className="text-sm font-semibold">PDF</h3>
          <PrefsForm values={defaults} groups={["pdf"]} onChange={(k, v) => void setDefault(k, v)} />
          <Separator />
          <WatchedFoldersSettings />
          <Separator />
          <ExcludedBooksSettings />
        </div>
      </SheetContent>
    </Sheet>
  );
}

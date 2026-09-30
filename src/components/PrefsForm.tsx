import type { ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FONT_SIZE, LINE_HEIGHTS, nearestLineSpacing, type LineSpacing, type PrefKey, type Prefs } from "@/lib/prefs";

export type PrefGroup = "layout" | "text" | "pdf";

interface Props {
  values: Prefs;
  groups: PrefGroup[];
  onChange<K extends PrefKey>(key: K, value: Prefs[K]): void;
  /** Keys that differ from the defaults for this book. */
  overridden?: Partial<Record<PrefKey, boolean>>;
  onClear?(key: PrefKey): void;
  /** Label left, control right, hairline between rows: the Settings page's layout. */
  inline?: boolean;
}

function Row({ label, prefKey, overridden, onClear, inline, children }: { label: string; prefKey: PrefKey; overridden?: boolean; onClear?(k: PrefKey): void; inline?: boolean; children: ReactNode }) {
  const id = `pref-${prefKey}`;
  if (inline)
    return (
      <div className="flex min-h-12 items-center justify-between gap-4 border-b py-2" role="group" aria-labelledby={id}>
        <span id={id} className="text-[13px]">
          {label}
        </span>
        {children}
      </div>
    );
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-labelledby={id}>
      <div className="flex items-center justify-between text-xs">
        <span id={id} className="font-medium text-muted-foreground">
          {label}
          {overridden && <span className="ml-1.5 rounded bg-accent px-1 py-px text-[10px] text-accent-foreground">This book</span>}
        </span>
        {overridden && onClear && (
          <button className="text-primary hover:underline" onClick={() => onClear(prefKey)} aria-label={`Use default ${label.toLowerCase()}`}>
            Use default
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function Choice<T extends string>({ value, options, onChange, label }: { value: string; options: [T, string][]; onChange(v: T): void; label: string }) {
  return (
    <ToggleGroup type="single" value={value} aria-label={label} onValueChange={(v) => v && onChange(v as T)}>
      {options.map(([v, text]) => (
        <ToggleGroupItem key={v} value={v}>
          {text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function PrefsForm({ values, groups, onChange, overridden = {}, onClear, inline }: Props) {
  const row = (key: PrefKey, label: string, children: ReactNode) => (
    <Row key={key} label={label} prefKey={key} overridden={overridden[key]} onClear={onClear} inline={inline}>
      {children}
    </Row>
  );
  return (
    <div className={inline ? "flex flex-col" : "flex flex-col gap-4"}>
      {groups.includes("layout") && (
        <>
          {row("reading_mode", "Reading mode", <Choice label="Reading mode" value={values.reading_mode} options={[["vertical", "Vertical"], ["horizontal", "Horizontal"]]} onChange={(v) => onChange("reading_mode", v)} />)}
          {row("spread", "Pages", <Choice label="Pages" value={values.spread} options={[["single", "Single"], ["double", "Two-up"]]} onChange={(v) => onChange("spread", v)} />)}
          {row("theme", "Theme", <Choice label="Theme" value={values.theme} options={[["system", "System"], ["light", "Light"], ["dark", "Dark"], ["sepia", "Sepia"]]} onChange={(v) => onChange("theme", v)} />)}
        </>
      )}
      {groups.includes("text") && (
        <>
          {row("font_family", "Font", <Choice label="Font" value={values.font_family} options={[["publisher", "Publisher"], ["serif", "Serif"], ["sans", "Sans"]]} onChange={(v) => onChange("font_family", v)} />)}
          {row(
            "font_size",
            "Text size",
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon-sm" aria-label="Smaller text" disabled={values.font_size <= FONT_SIZE.min} onClick={() => onChange("font_size", values.font_size - FONT_SIZE.step)}>
                <Minus />
              </Button>
              <span className="flex-1 text-center text-sm tabular-nums" aria-live="polite">{values.font_size} px</span>
              <Button variant="outline" size="icon-sm" aria-label="Larger text" disabled={values.font_size >= FONT_SIZE.max} onClick={() => onChange("font_size", values.font_size + FONT_SIZE.step)}>
                <Plus />
              </Button>
            </div>,
          )}
          {row("line_height", "Line spacing", <Choice label="Line spacing" value={nearestLineSpacing(values.line_height)} options={[["tight", "Tight"], ["normal", "Normal"], ["loose", "Loose"]]} onChange={(v) => onChange("line_height", LINE_HEIGHTS[v as LineSpacing])} />)}
          {row("page_width", "Page width", <Choice label="Page width" value={values.page_width} options={[["narrow", "Narrow"], ["medium", "Medium"], ["wide", "Wide"]]} onChange={(v) => onChange("page_width", v)} />)}
          {row("text_align", "Justify text", <Choice label="Justify text" value={values.text_align} options={[["left", "Off"], ["justify", "On"]]} onChange={(v) => onChange("text_align", v)} />)}
        </>
      )}
      {groups.includes("pdf") && (
        <>
          {row(
            "pdf_zoom",
            typeof values.pdf_zoom === "number" ? `PDF zoom (${Math.round(values.pdf_zoom * 100)}%)` : "PDF zoom",
            <Choice label="PDF zoom" value={typeof values.pdf_zoom === "number" ? "" : values.pdf_zoom} options={[["fit-width", "Fit width"], ["fit-page", "Fit page"]]} onChange={(v) => onChange("pdf_zoom", v)} />,
          )}
          {row("pdf_effect", "PDF page effect", <Choice label="PDF page effect" value={values.pdf_effect} options={[["none", "None"], ["sepia", "Sepia"], ["invert", "Dark"]]} onChange={(v) => onChange("pdf_effect", v)} />)}
        </>
      )}
    </div>
  );
}

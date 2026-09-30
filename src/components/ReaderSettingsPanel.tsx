import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { BookDetail } from "@/lib/api";
import {
  FONT_SIZE,
  LINE_HEIGHTS,
  nearestLineSpacing,
  stepFontSize,
  THEME_COLORS,
  type LineSpacing,
  type PrefKey,
  type Prefs,
  type ThemePref,
} from "@/lib/prefs";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

function Section({ prefKey, label, aside, children }: { prefKey: PrefKey; label: string; aside?: ReactNode; children: ReactNode }) {
  const overridden = useApp((s) => prefKey in s.overrides);
  const setOverride = useApp((s) => s.setOverride);
  const id = `pref-${prefKey}`;
  return (
    <div className="flex flex-col gap-2.5" role="group" aria-labelledby={id}>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span id={id}>
          {label}
          {overridden && <span className="ml-1.5 rounded bg-accent px-1 py-px text-[10px] text-accent-foreground">This book</span>}
        </span>
        <span className="flex items-center gap-2">
          {overridden && (
            <button className="text-primary hover:underline" onClick={() => void setOverride(prefKey, null)} aria-label={`Use default ${label.toLowerCase()}`}>
              Use default
            </button>
          )}
          {aside}
        </span>
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange, fontOf }: { label: string; value: T; options: [T, string][]; onChange(v: T): void; fontOf?(v: T): string | undefined }) {
  return (
    <ToggleGroup type="single" aria-label={label} value={value} onValueChange={(v) => v && onChange(v as T)}>
      {options.map(([v, text]) => (
        <ToggleGroupItem key={v} value={v} style={fontOf ? { fontFamily: fontOf(v) } : undefined}>
          {text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

const SWATCHES: [ThemePref, string][] = [
  ["light", "Light"],
  ["sepia", "Sepia"],
  ["dark", "Dark"],
  ["system", "Auto"],
];

function swatchBackground(pref: ThemePref) {
  if (pref !== "system") return THEME_COLORS[pref].bg;
  return `linear-gradient(135deg, ${THEME_COLORS.light.bg} 50%, ${THEME_COLORS.dark.bg} 50%)`;
}

const FAMILY_PREVIEW = { serif: "ui-serif, 'New York', Georgia, serif", sans: "-apple-system, system-ui, sans-serif", publisher: undefined };

export function ReaderSettingsPanel({ detail, prefs }: { detail: BookDetail; prefs: Prefs }) {
  const overrides = useApp((s) => s.overrides);
  const setOverride = useApp((s) => s.setOverride);
  const resetOverrides = useApp((s) => s.resetOverrides);
  const setAaOpen = useApp((s) => s.setAaOpen);
  const set = <K extends PrefKey>(k: K, v: Prefs[K]) => void setOverride(k, v);
  const isPdf = detail.book.format === "pdf";
  const sizeFraction = (prefs.font_size - FONT_SIZE.min) / (FONT_SIZE.max - FONT_SIZE.min);

  const appearance = (
    <Section prefKey="theme" label="Appearance">
      <div role="radiogroup" aria-label="Appearance" className="grid grid-cols-4 gap-2">
        {SWATCHES.map(([v, text]) => (
          <button key={v} role="radio" aria-checked={prefs.theme === v} onClick={() => set("theme", v)} className="flex flex-col items-center gap-1.5 text-[11px] outline-none">
            <span
              className={cn("flex h-11 w-full items-center justify-center rounded-lg font-serif text-base font-medium", prefs.theme === v ? "ring-2 ring-primary" : "ring-1 ring-border")}
              style={{ background: swatchBackground(v), color: v === "system" ? undefined : THEME_COLORS[v].fg }}
            >
              {v === "system" ? <span className="rounded bg-background/80 px-1 text-foreground">Aa</span> : "Aa"}
            </span>
            {text}
          </button>
        ))}
      </div>
    </Section>
  );

  const layout = (
    <>
      <Section prefKey="reading_mode" label="Scroll direction">
        <div role="radiogroup" aria-label="Scroll direction" className="flex flex-col gap-1.5">
          {(
            [
              ["horizontal", "Paged", "Turn pages left and right"],
              ["vertical", "Scroll", "Continuous, top to bottom"],
            ] as const
          ).map(([v, text, hint]) => {
            const on = prefs.reading_mode === v;
            return (
              <button
                key={v}
                role="radio"
                aria-checked={on}
                onClick={() => set("reading_mode", v)}
                className={cn("flex items-center gap-2.5 rounded-lg border bg-popover px-2.5 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring", on && "border-primary")}
              >
                <span className={cn("size-3.5 shrink-0 rounded-full", on ? "border-4 border-primary" : "border-[1.5px] border-border")} />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{text}</span>
                  <span className="text-[11px] text-muted-foreground">{hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Section>
      <Section prefKey="spread" label="Pages">
        <Segmented label="Pages" value={prefs.spread} options={[["single", "Single"], ["double", "Two-up"]]} onChange={(v) => set("spread", v)} />
      </Section>
    </>
  );

  return (
    <aside
      aria-label="Reading settings"
      className="flex w-[272px] shrink-0 flex-col gap-[22px] overflow-y-auto border-l bg-background px-[18px] pt-[18px] pb-6 text-[13px]"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        setAaOpen(false);
        document.querySelector<HTMLElement>("[data-reading-region]")?.focus();
      }}
    >
      <h2 className="text-[13px] font-semibold">Reading settings</h2>
      {isPdf ? (
        <>
          {layout}
          {appearance}
          <Section prefKey="pdf_zoom" label="PDF zoom" aside={typeof prefs.pdf_zoom === "number" ? `${Math.round(prefs.pdf_zoom * 100)}%` : undefined}>
            <Segmented
              label="PDF zoom"
              value={typeof prefs.pdf_zoom === "number" ? ("" as "fit-width") : prefs.pdf_zoom}
              options={[["fit-width", "Fit width"], ["fit-page", "Fit page"]]}
              onChange={(v) => set("pdf_zoom", v)}
            />
          </Section>
          <Section prefKey="pdf_effect" label="PDF page effect">
            <Segmented label="PDF page effect" value={prefs.pdf_effect} options={[["none", "None"], ["sepia", "Sepia"], ["invert", "Dark"]]} onChange={(v) => set("pdf_effect", v)} />
          </Section>
        </>
      ) : (
        <>
          {appearance}
          <Section prefKey="font_family" label="Font">
            <Segmented
              label="Font"
              value={prefs.font_family}
              options={[["serif", "Serif"], ["sans", "Sans"], ["publisher", "Original"]]}
              onChange={(v) => set("font_family", v)}
              fontOf={(v) => FAMILY_PREVIEW[v]}
            />
          </Section>
          <Section prefKey="font_size" label="Text size" aside={<span className="tabular-nums" aria-live="polite">{prefs.font_size} px</span>}>
            <div className="flex items-center gap-2">
              <Button variant="outline" className="h-8 w-11 bg-popover font-serif text-[13px]" aria-label="Smaller text" disabled={prefs.font_size <= FONT_SIZE.min} onClick={() => set("font_size", stepFontSize(prefs.font_size, -1))}>
                A
              </Button>
              <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-[3px] bg-primary" style={{ width: `${Math.round(sizeFraction * 100)}%` }} />
              </span>
              <Button variant="outline" className="h-8 w-11 bg-popover font-serif text-[19px]" aria-label="Larger text" disabled={prefs.font_size >= FONT_SIZE.max} onClick={() => set("font_size", stepFontSize(prefs.font_size, 1))}>
                A
              </Button>
            </div>
          </Section>
          <Section prefKey="line_height" label="Line spacing">
            <Segmented
              label="Line spacing"
              value={nearestLineSpacing(prefs.line_height)}
              options={[["tight", "Tight"], ["normal", "Normal"], ["loose", "Loose"]]}
              onChange={(v: LineSpacing) => set("line_height", LINE_HEIGHTS[v])}
            />
          </Section>
          <Section prefKey="page_width" label="Page width">
            <Segmented label="Page width" value={prefs.page_width} options={[["narrow", "Narrow"], ["medium", "Medium"], ["wide", "Wide"]]} onChange={(v) => set("page_width", v)} />
          </Section>
          {layout}
          <Section prefKey="text_align" label="Justify text" aside={<Switch aria-label="Justify text" checked={prefs.text_align === "justify"} onCheckedChange={(on) => set("text_align", on ? "justify" : "left")} />}>
            {null}
          </Section>
        </>
      )}
      <div className="mt-auto flex flex-col gap-2 pt-2">
        <Button variant="outline" size="sm" disabled={Object.keys(overrides).length === 0} onClick={() => void resetOverrides()}>
          Reset to defaults
        </Button>
        <p className="text-[11px] text-muted-foreground">Marked settings apply to this book only.</p>
      </div>
    </aside>
  );
}

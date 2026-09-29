/**
 * Versioned mapping between a segment's indexed text and the units it was
 * extracted from: the text nodes of an EPUB section body, or the PDF.js text
 * items of a page. Rust turns a search hit's text offsets into unit points
 * through this mapping, and the reader turns unit points into a DOM range.
 *
 * The indexed text is the units' text joined by separators, with every
 * whitespace character replaced by a space. The replacement keeps lengths, so
 * an offset inside a unit is the same in the raw and indexed text. Offsets are
 * UTF-16 code units. Extraction and resolution must enumerate units with the
 * same function, which is why both live here.
 */
export const TEXT_MAP_VERSION = 1;

export interface TextMapping {
  v: number;
  /** One entry per non-empty unit, in text order: [start offset in the segment text, unit index, unit length]. */
  units: Array<[number, number, number]>;
}

export interface SegmentUnit {
  text: string;
  /** Written before this unit when text precedes it. */
  sep: "" | " " | "\n";
}

export const normalizeUnit = (s: string) => s.replace(/\s/g, " ");

/** Unit indexes count empty units too, so they match the enumeration at resolve time. */
export function buildSegment(units: SegmentUnit[]): { text: string; mapping: TextMapping } {
  let text = "";
  const out: TextMapping["units"] = [];
  units.forEach((u, index) => {
    if (!u.text) return;
    if (text) text += u.sep;
    out.push([text.length, index, u.text.length]);
    text += normalizeUnit(u.text);
  });
  return { text, mapping: { v: TEXT_MAP_VERSION, units: out } };
}

const BLOCK = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE",
  "TD", "TH", "TR", "UL", "BR",
].map((t) => t.toLowerCase()));

function blockOf(node: Node): Node | null {
  for (let n = node.parentNode; n; n = n.parentNode) {
    if (n.nodeType === 1 && BLOCK.has((n as Element).localName)) return n;
  }
  return null;
}

/** Every text node under the section body, in document order. Units for EPUB extraction and resolution. */
export function epubTextNodes(doc: Document): Text[] {
  const body = doc.body;
  if (!body) return [];
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

export function epubUnits(nodes: Text[]): SegmentUnit[] {
  let prevBlock: Node | null | undefined;
  return nodes.map((n) => {
    const block = blockOf(n);
    const sep = prevBlock !== undefined && block !== prevBlock ? "\n" : "";
    if (n.data) prevBlock = block;
    return { text: n.data, sep };
  });
}

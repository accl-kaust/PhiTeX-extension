// A page's draw list v2 (core-partex's pdfdraw: the PDF pdfTeX wrote, read
// back) drawn as SVG: a `<text>` per run with every glyph at TeX's x, in
// Latin Modern (bundled OpenType, the GUST Font License), and a `<path>` per
// painted path (TikZ). Redrawn by parts: each element is keyed by its own
// markup, and an update keeps the elements that did not change, so a
// keystroke replaces the line it changed, not the page.

export interface Draws2 {
  v: 2;
  w: number;
  h: number;
  f: string[];
  /** [font, size, y, "x x ...", text] */
  t: [number, number, number, string, string][];
  /** [d, fill, stroke, width] */
  p: [string, string | null, string | null, number][];
  r: unknown[];
}

const NS = "http://www.w3.org/2000/svg";

/** CSS families by pdfdraw's font keys (a missing glyph falls back to the math font). */
const FAMILY: Record<string, string> = {
  roman: "PhxLMRoman, PhxLMMath, serif",
  bold: "PhxLMBold, PhxLMMath, serif",
  italic: "PhxLMItalic, PhxLMMath, serif",
  bolditalic: "PhxLMBoldItalic, PhxLMMath, serif",
  mono: "PhxLMMono, monospace",
  math: "PhxLMMath, PhxLMRoman, serif",
};

const FILES: [string, string][] = [
  ["PhxLMRoman", "lmroman10-regular.otf"],
  ["PhxLMBold", "lmroman10-bold.otf"],
  ["PhxLMItalic", "lmroman10-italic.otf"],
  ["PhxLMBoldItalic", "lmroman10-bolditalic.otf"],
  ["PhxLMMono", "lmmono10-regular.otf"],
  ["PhxLMMath", "latinmodern-math.otf"],
];

let fonts: Promise<void> | undefined;
/** The fonts, once: as FontFaces from their bytes (a stylesheet's @font-face is not seen in a shadow root, and Overleaf's CSP governs URLs). */
export const loadFonts = () =>
  (fonts ??= Promise.all(
    FILES.map(async ([family, file]) => {
      const r = await fetch(chrome.runtime.getURL("fonts/" + file));
      const f = new FontFace(family, await r.arrayBuffer());
      document.fonts.add(await f.load());
    }),
  ).then(() => undefined));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page's elements as markup, one string each (the keys of the update). */
export function elements(d: Draws2): string[] {
  const out: string[] = [];
  for (const [d_, fill, stroke, w] of d.p)
    out.push(`<path d="${d_}" fill="${fill ?? "none"}" stroke="${stroke ?? "none"}" stroke-width="${w}"/>`);
  for (const [f, size, y, xs, text] of d.t)
    out.push(`<text x="${xs}" y="${y}" font-size="${size}" font-family="${esc(FAMILY[d.f[f]] ?? FAMILY.roman)}">${esc(text)}</text>`);
  return out;
}

type Keyed = Element & { __k?: string };

/**
 * Draw `d` into `el` at `w`×`h` CSS pixels: the svg kept if there is one,
 * its elements updated by key (reused when unchanged, new ones parsed in one
 * go, the gone ones dropped).
 */
export function patch(el: HTMLElement, d: Draws2, w: number, h: number): void {
  void loadFonts();
  let svg = el.firstElementChild as SVGSVGElement | null;
  if (!svg || svg.dataset.v !== "2") {
    el.innerHTML = `<svg class="page" xmlns="${NS}" data-v="2" preserveAspectRatio="none" xml:space="preserve"><rect class="paper"/><g class="c"></g></svg>`;
    svg = el.firstElementChild as SVGSVGElement;
  }
  svg.setAttribute("viewBox", `0 0 ${d.w} ${d.h}`);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  const paper = svg.querySelector("rect.paper")!;
  paper.setAttribute("width", String(d.w));
  paper.setAttribute("height", String(d.h));
  const g = svg.querySelector("g.c")!;
  const keys = elements(d);
  const old = new Map<string, Keyed[]>();
  for (const c of Array.from(g.children) as Keyed[]) {
    const k = c.__k ?? "";
    const l = old.get(k);
    if (l) l.push(c);
    else old.set(k, [c]);
  }
  const fresh: string[] = [];
  const slots: (Keyed | number)[] = keys.map((k) => old.get(k)?.pop() ?? (fresh.push(k), fresh.length - 1));
  if (!fresh.length && slots.length === g.children.length && slots.every((s, i) => s === g.children[i])) return;
  const made: Keyed[] = [];
  if (fresh.length) {
    const tmp = document.createElementNS(NS, "g");
    tmp.innerHTML = fresh.join("");
    made.push(...(Array.from(tmp.children) as Keyed[]));
    made.forEach((m, i) => (m.__k = fresh[i]));
  }
  g.replaceChildren(...slots.map((s) => (typeof s === "number" ? made[s] : s)));
}

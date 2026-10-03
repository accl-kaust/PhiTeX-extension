// A page's draw list v2 (core-partex's pdfdraw: the PDF pdfTeX wrote, read
// back) drawn as SVG: the glyphs from the PDF's own embedded fonts (their
// outlines, `<defs>` once a page, a `<use>` each, as pdf.js draws them), the
// text over them invisible (for selecting and finding), and a `<path>` per
// painted path (TikZ). A font with no outlines (not embedded) is drawn as
// text in Latin Modern (bundled OpenType, the GUST Font License). Redrawn by parts: each element is keyed by its own
// markup, and an update keeps the elements that did not change, so a
// keystroke replaces the line it changed, not the page.

export interface Draws2 {
  v: 2;
  w: number;
  h: number;
  f: string[];
  /** [font, size, y, "x x ...", text, 1 if its glyphs are drawn from outlines];
   * or [-1, size, y, "x x ...", "", outline font, codes]: the glyphs. */
  t: (([number, number, number, string, string] | [number, number, number, string, string, 1]) | [-1, number, number, string, "", number, number[]])[];
  /** The outline fonts' names (ids), by the glyph runs' font. */
  F?: string[];
  /** Outlines by "font:code": SVG path data in 1/1000 em, y up. */
  g?: Record<string, string>;
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
  // (glyph ids: the font's name and the code, the same on every page)
  const gid = (fr: number, c: number) => `g${d.F?.[fr] ?? fr}_${c}`;
  if (d.g && Object.keys(d.g).length)
    out.push(
      `<defs>${Object.entries(d.g)
        .map(([k, p]) => {
          const [fr, c] = k.split(":");
          return `<path id="${gid(+fr, +c)}" d="${p}"/>`;
        })
        .join("")}</defs>`,
    );
  for (const r of d.t) {
    if (r[0] === -1) {
      const [, size, y, xs, , fr, codes] = r as [-1, number, number, string, "", number, number[]];
      const k = size / 1000;
      const x = xs.split(" ");
      out.push(`<g transform="translate(0 ${y}) scale(${k} ${-k})">${codes.map((c, i) => `<use href="#${gid(fr, c)}" x="${(+x[i] / k).toFixed(1)}"/>`).join("")}</g>`);
      continue;
    }
    const [f, size, y, xs, text, outlined] = r as [number, number, number, string, string, 1?];
    out.push(`<text x="${xs}" y="${y}" font-size="${size}" font-family="${esc(FAMILY[d.f[f]] ?? FAMILY.roman)}"${outlined ? ' fill-opacity="0"' : ""}>${esc(text)}</text>`);
  }
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

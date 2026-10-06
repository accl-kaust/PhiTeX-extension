// Shelf's index (schema 3) and the rule a name resolves to a file by, as
// kpathsea does it, per engine. Used by the worker (the core's fetches
// mid-build) and the offscreen document (prefetch), so both pick the same
// file.
//
// The index has every file by its texmf path (`tex/latex/fontspec/fontspec.sty`,
// `fonts/opentype/public/lm/lmroman10-regular.otf`), a row
// `path<TAB>pack<TAB>deps…`: its pack, then for each engine release.json's
// `deps` names, the packs its loading reads (comma-separated). release.json's
// `search` gives, for each engine and kpathsea format (tex, tfm, vf, type1,
// enc, map, opentype, truetype, bst, ist, …), the ordered path prefixes
// (TeX Live's texmf.cnf: TEXINPUTS.xelatex, …).
//
// The rule (Shelf's build.py states the same):
// - a name with a "/" is a path: TeX Live's absolute prefix
//   (/usr/share/texmf-dist/) dropped, the rest looked up as is;
// - else its basename's paths: the first prefix of the engine's list for
//   the format that holds any wins (a prefix holds a path under it, at any
//   depth), and within one prefix the lexicographically smallest path;
//   none under any prefix: not found (kpathsea would not find it either);
// - a format the release has no list for (or an engine it doesn't name):
//   the smallest path of all with that basename.

/** TeX Live's tree, as XeTeX's font index and the XDV name files. */
export const TL = "/usr/share/texmf-dist/";

export interface Search {
  [engine: string]: { [format: string]: string[] };
}

/** release.json, schema 3: what the resolver reads of it. */
export interface ReleaseMeta {
  release?: string;
  schema?: number;
  deps?: string[];
  search?: Search;
}

/** Shelf's engine names, by the extension's. */
export function shelfEngine(e: string | undefined): string {
  return e === "xelatex" || e === "xetex" ? "xetex" : e === "lualatex" || e === "luatex" ? "luatex" : "pdftex";
}

export class Index {
  /** path → [pack, deps by engine (release.json's `deps` order)]. */
  readonly rows = new Map<string, { pack: string; deps: string[][] }>();
  /** basename → its paths, sorted. */
  private readonly byBase = new Map<string, string[]>();
  readonly search: Search;
  readonly engines: string[];

  constructor(tsv: string, meta: ReleaseMeta) {
    this.search = meta.search ?? {};
    this.engines = meta.deps ?? [];
    for (const l of tsv.split("\n")) {
      const [path, pack, ...deps] = l.split("\t");
      if (!path || !pack) continue;
      this.rows.set(path, { pack, deps: deps.map((d) => (d ? d.split(",") : [])) });
      const base = path.slice(path.lastIndexOf("/") + 1);
      const list = this.byBase.get(base);
      if (list) list.push(path);
      else this.byBase.set(base, [path]);
    }
    for (const list of this.byBase.values()) list.sort();
  }

  /** `name`'s path for `engine` (Shelf's name: pdftex, xetex) and kpathsea format `format`, or null. */
  resolve(name: string, format: string, engine: string): string | null {
    if (name.includes("/")) {
      const p = name.startsWith(TL) ? name.slice(TL.length) : name.replace(/^\.\//, "");
      return this.rows.has(p) ? p : null;
    }
    const paths = this.byBase.get(name);
    if (!paths) return null;
    const prefixes = this.search[engine]?.[format];
    if (!prefixes) return paths[0];
    for (const pre of prefixes) {
      const hit = paths.find((p) => p.startsWith(pre.endsWith("/") ? pre : pre + "/"));
      if (hit) return hit;
    }
    return null;
  }

  /** The packs to fetch for `path` with `engine`: its own, then what its loading reads. */
  packs(path: string, engine: string): string[] {
    const r = this.rows.get(path);
    if (!r) return [];
    const k = this.engines.indexOf(engine);
    return [r.pack, ...(k >= 0 ? (r.deps[k] ?? []) : [])];
  }
}

/** The kpathsea format of a file by its name's extension (the offscreen's prefetch: no FileKind there). */
export function formatOf(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return ({ tfm: "tfm", vf: "vf", pfb: "type1", pfa: "type1", enc: "enc", map: "map", otf: "opentype", ttf: "truetype", ttc: "truetype", bst: "bst", csf: "bst", bib: "bib", ist: "ist", tec: "misc" } as Record<string, string>)[ext] ?? "tex";
}

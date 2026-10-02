// Packages: the files a build reads that the project doesn't have
// (`\usepackage{amsmath}`'s amsmath.sty, a class, a .def), found elsewhere
// and handed to the core as files. The core reports them (status JSON's
// `missing`); the session asks a PackageSource and `set_file`s what it
// finds. The source is the offscreen document's (shelf.ts: the extension's
// texmf/, IndexedDB, then Shelf), asked over the core's port: a content
// script's fetch would be Overleaf's origin (CORS, its CSP). Only what a
// build reads is fetched. (A .sty is TeX PhiTeX runs, not the extension's
// JavaScript: the Web Store's remote-code rule is about the latter.)

/** Where packages come from. */
export interface PackageSource {
  /** Shown to the user: "TeX Live 2025", ... */
  readonly label: string;
  /** `name`'s text (as the core asked for it: "amsmath.sty"), or null: not there. */
  resolve(name: string): Promise<string | null>;
}

/** No packages (PhiTeX runs no LaTeX yet). */
export const noPackages: PackageSource = { label: "none", resolve: async () => null };

/** What the session tells the view: packages being downloaded, and the ones not found. */
export interface PackageState {
  /** Being fetched now (empty: none). */
  loading: string[];
  /** Asked for, found nowhere. */
  unavailable: string[];
  source: string;
}

/** A name a TeX distribution might have (not an .aux, a .bbl, a .toc: the build's own). A .tex the project lacks is asked for too: shelf.ts sends Shelf only names it lists. */
export function isPackageFile(name: string): boolean {
  return /\.(sty|cls|clo|def|cfg|fd|ldf|ltx|tex|dfu)$/i.test(name) && !name.includes("/");
}

/** `inner`, each name fetched once (in flight or done), however often it is asked for. */
export function cached(inner: PackageSource): PackageSource {
  const seen = new Map<string, Promise<string | null>>();
  return {
    label: inner.label,
    resolve(name) {
      let p = seen.get(name);
      if (!p) seen.set(name, (p = inner.resolve(name).catch(() => null)));
      return p;
    },
  };
}

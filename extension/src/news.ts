// What's new: the release notes users see once after an update. They ship
// with the extension (never fetched: nothing leaves the browser). Add an
// entry, newest first, when bumping manifest.base.json's version: a user
// sees every entry newer than the version they last saw, so a skipped
// update's notes still show. For a message without an update, Shelf's
// release.json `notice` (a banner on every page, shelf.PhiTeX.org/release.py).

export interface News {
  version: string;
  date: string;
  title: string;
  items: string[];
  /** A button beside "Got it" (e.g. a donation page), opened in a new tab. */
  link?: { label: string; href: string };
}

/** A "Support PhiTeX" button on every What's new (null: none), e.g. { label: "♥ Support PhiTeX", href: "https://…" }. */
export const SUPPORT: { label: string; href: string } | null = null;

export const NEWS: News[] = [
  {
    version: "0.5.1",
    date: "2026-10-08",
    title: "Edits in files inside folders show again",
    items: [
      "Editing a file inside a folder (sections/intro.tex, …) updates the ⚡ preview again; before, the edit was built but the page never changed.",
      "Clicking a folder in the file tree no longer stops the open file's edits from reaching the preview.",
      "Jumping from the preview to a file in a closed folder opens the folder first.",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-10-08",
    title: "Faster start, packages kept in your browser",
    items: [
      "After install, the TeX Live packages and fonts most arXiv papers use (about 60 MB) download in the background, so opening a project rarely waits on downloads.",
      "Packages already downloaded are reused straight from your browser on every start, without downloading them again.",
      "The package cache has a size limit (300 MB by default; 100 MB or 1 GB in the toolbar popup). Past it, the least recently used packages are removed first. The background download can be turned off there too.",
      "Startup does less work: the package index loads about four times faster, and the typesetter starts its steps in parallel.",
      "This update clears the old package cache once: packages download again the first time they're needed.",
    ],
  },
  {
    version: "0.4.1",
    date: "2026-10-07",
    title: "Firefox: projects with figures open again",
    items: [
      "In Firefox, a project with figures or other binary files no longer stops at \"Unpacking the project\".",
      "If a project can't be opened, the panel now says why instead of waiting.",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-10-07",
    title: "XeLaTeX, figures, and a faster, clearer preview",
    items: [
      "Projects using <b>fontspec</b>, <b>unicode-math</b> or <b>polyglossia</b> now typeset with real XeLaTeX, in your browser: TeX Live's OpenType fonts by name or your own uploaded ones, Arabic, Hebrew, Chinese (xeCJK, ctex).",
      "<b>Figures</b> in the instant preview: PNG, JPEG, PDF figures and matplotlib plots, trimmed and clipped.",
      "<b>minted</b> code listings with Pygments' colours, and coloured text (<code>\\textcolor</code>).",
      "A half-typed command no longer turns references into <b>??</b>: the last good pages stay until it is fixed.",
      "Pages drawn as <b>Vector</b> (instant, selectable) or with <b>PDF.js</b>; a highlight that follows your cursor, chosen in the tour.",
      "Opening a project shows what it is doing, step by step; an idle tab no longer uses any CPU.",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-09-30",
    title: "⚡ Instant arrives",
    items: [
      "A live PhiTeX preview in Overleaf's PDF pane: switch between <b>PDF</b> and <b>⚡ Instant</b> (Alt+Shift+P).",
      "The page repaints as you type, usually in a few milliseconds, entirely in your browser.",
      "Diagnostics with jump-to-line, selectable text, and PhiTeX's PDF from the download menu.",
    ],
  },
];

/** -1, 0, 1 as `a` is older, the same, newer than `b` (dotted numbers). */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The entries newer than `seen` (all of them for an unknown `seen`), up to `current`. */
export function unseen(seen: string | undefined, current: string, news = NEWS): News[] {
  return news.filter((n) => compareVersions(n.version, current) <= 0 && (!seen || compareVersions(n.version, seen) > 0));
}

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
    version: "0.3.0",
    date: "2026-10-06",
    title: "XeLaTeX",
    items: [
      "Projects using <b>fontspec</b>, <b>unicode-math</b> or <b>polyglossia</b> now typeset with real XeLaTeX, in your browser.",
      "Fonts by name (TeX Gyre, Latin Modern Math, and the rest of TeX Live's OpenType fonts) or uploaded to your project.",
    ],
  },
  {
    version: "0.2.1",
    date: "2026-10-05",
    title: "minted, colour, and steadier references",
    items: [
      "<b>minted</b> code listings with Pygments' colours, run locally (the first one loads Python, a few seconds).",
      "Coloured text (<code>\\textcolor</code>) shows in colour.",
      "A half-typed command no longer turns references into <b>??</b>: the last good pages stay until it is fixed.",
      "Faster startup and incremental page updates; smooth PDF scrolling and an optional highlight that follows your cursor.",
      "Package lists update without an extension update.",
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

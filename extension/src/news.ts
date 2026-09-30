// What's new: the release notes users see once after an update. They ship
// with the extension (never fetched: nothing leaves the browser). Add an
// entry, newest first, when bumping manifest.base.json's version.

export interface News {
  version: string;
  date: string;
  title: string;
  items: string[];
}

export const NEWS: News[] = [
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

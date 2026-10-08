// A project's past versions, from Overleaf's history (the same endpoints its
// History view reads, same origin, the user's own session): the labels and
// the updates, and any version's files, as a ZIP Overleaf makes. The source
// of the diff's version pickers (phitex-diff: a past version against the
// editor's text, or two past ones). Nothing leaves the browser but these
// requests to Overleaf itself.

import { readZip } from "./common/zip.ts";

/** One version a picker lists: a label (named by its author) or an update (a burst of edits). */
export interface Version {
  /** Overleaf's version number: the project as it was after it. */
  v: number;
  /** "Submitted v1", or the update's files: "main.tex, intro.tex". */
  title: string;
  /** ms since the epoch. */
  at: number;
  who: string[];
  label: boolean;
}

interface Update {
  fromV: number;
  toV: number;
  meta: { users?: { first_name?: string; last_name?: string; email?: string }[]; end_ts: number };
  labels?: { comment: string; version: number }[];
  pathnames?: string[];
  project_ops?: unknown[];
}

interface Label {
  id: string;
  comment: string;
  version: number;
  created_at: string;
  user_display_name?: string;
}

const name = (u: { first_name?: string; last_name?: string; email?: string }) => [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || "someone";

/**
 * The labels, then the last `count` updates (newest first), from the project
 * `base` (`/project/<id>`). `before`: older ones, from the previous page's
 * last `at` (Overleaf pages its history by time).
 */
export async function versions(base: string, fetcher: typeof fetch, count = 40, before?: number): Promise<{ versions: Version[]; more?: number }> {
  const get = async <T>(u: string) => {
    const r = await fetcher(u, { credentials: "include" });
    if (!r.ok) throw new Error(`history: ${r.status} for ${u.replace(base, "")}`);
    return (await r.json()) as T;
  };
  const [ups, labels] = await Promise.all([
    get<{ updates: Update[]; nextBeforeTimestamp?: number }>(`${base}/updates?min_count=${count}${before ? `&before=${before}` : ""}`),
    before ? Promise.resolve([] as Label[]) : get<Label[]>(`${base}/labels`).catch(() => [] as Label[]),
  ]);
  const out: Version[] = labels
    .map((l) => ({ v: l.version, title: l.comment, at: Date.parse(l.created_at), who: l.user_display_name ? [l.user_display_name] : [], label: true }))
    .sort((a, b) => b.at - a.at);
  for (const u of ups.updates) {
    const files = u.pathnames ?? [];
    out.push({
      v: u.toV,
      title: files.length ? files.slice(0, 3).join(", ") + (files.length > 3 ? ` +${files.length - 3}` : "") : "files added, moved or deleted",
      at: u.meta.end_ts,
      who: (u.meta.users ?? []).map(name),
      label: false,
    });
  }
  return { versions: out, more: ups.nextBeforeTimestamp };
}

/** The project's files as they were at version `v`: text by path, and the binary ones apart. */
export async function filesAt(base: string, v: number, fetcher: typeof fetch): Promise<{ files: Record<string, string>; binaries: Record<string, Uint8Array> }> {
  const r = await fetcher(`${base}/version/${v}/zip`, { credentials: "include" });
  if (!r.ok) throw new Error(`history: version ${v}: ${r.status}`);
  const { files, binaries } = await readZip(await r.arrayBuffer());
  return { files, binaries };
}

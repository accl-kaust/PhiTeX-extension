// VS Code's text changes as the session takes them (common/src/edits.ts's
// Edit: UTF-16 offsets, each against the text just before it). Pure: no
// vscode import, so tests run it on a mock document.
//
// A TextDocumentChangeEvent's contentChanges are applied in the order given,
// as VS Code's extension host applies them to its own copy of the document
// (ExtHostDocumentData.onEvents): the editor reports a multi-cursor edit
// last change first, each `rangeOffset` in the text before the event, which
// is also where it is once the later ones are in. Offsets and lengths are
// UTF-16 code units, as the session's are; it makes the bytes.

import type { Edit } from "../../common/src/vendor/viewer/edits.ts";

/** What a change says (TextDocumentContentChangeEvent, less its Range). */
export interface Change {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/** `changes` as the session's sequential edits. */
export function toEdits(changes: readonly Change[]): Edit[] {
  return changes.map((c) => ({ from: c.rangeOffset, to: c.rangeOffset + c.rangeLength, text: c.text }));
}

/** A project file's path as the session names it: relative to the project's folder, with "/" (null: outside it). */
export function relPath(folder: string, file: string): string | null {
  const f = folder.replace(/\\/g, "/").replace(/\/$/, "");
  const p = file.replace(/\\/g, "/");
  return p.startsWith(f + "/") ? p.slice(f.length + 1) : null;
}

/** The main file among the project's: a \documentclass in one (the editor's first, if it has one), else none. */
export function findMain(files: Record<string, string>, active?: string): string | null {
  const has = (n: string) => /\.tex$/i.test(n) && /(^|\n)[^%\n]*\\documentclass/.test(files[n] ?? "");
  if (active && has(active)) return active;
  const all = Object.keys(files).filter(has);
  // (nearest the root first, then by name: a thesis' main.tex over its chapters' own test documents)
  return all.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0] ?? null;
}

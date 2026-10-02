// Diagnostics: what the preview can tell about the source and the build,
// as records (the shape a JSON mode, `--json`, would print). Source checks
// are heuristics on plain TeX's syntax: PhiTeX itself keeps going through
// incomplete input (an open group runs to the end), so these say *why* the
// preview looks as it does, at the line to look at. Pure: no DOM.

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  /** Stable, for filtering and a JSON mode: "unclosed-brace", "latex", ... */
  code: string;
  message: string;
  file?: string;
  /** 1-based. */
  line?: number;
}

/** What the core's status reports (session.ts's scan). */
export interface BuildFacts {
  pages: number;
  pending?: number;
  undefinedNames?: string[];
  /** Packages the build read that neither the project nor the package source has. */
  unavailable?: string[];
  /** Where packages come from ("TeX Live 2025"); undefined: nowhere yet. */
  packageSource?: string;
}

function lineAt(text: string, i: number): number {
  let n = 1;
  for (let k = 0; k < i; k++) if (text.charCodeAt(k) === 10) n++;
  return n;
}

/** Positions of `{`/`}` and `$` outside comments and escapes, and the unmatched ones. */
function scan(text: string): { openBraces: number[]; strayBraces: number[]; openDollars: number[] } {
  const open: number[] = [];
  const stray: number[] = [];
  const dollars: number[] = [];
  let paraDollars: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++; // (\{ \} \$ \% \\: escaped)
      continue;
    }
    if (c === "%") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "{") open.push(i);
    else if (c === "}") {
      if (open.length) open.pop();
      else stray.push(i);
    } else if (c === "$") {
      if (text[i + 1] === "$") i++; // (display math: as one)
      paraDollars.push(i);
    } else if (c === "\n" && /^[ \t]*\n/.test(text.slice(i + 1, i + 40))) {
      // (a blank line ends a paragraph, and TeX's math with it)
      if (paraDollars.length % 2) dollars.push(paraDollars.at(-1)!);
      paraDollars = [];
    }
  }
  if (paraDollars.length % 2) dollars.push(paraDollars.at(-1)!);
  return { openBraces: open, strayBraces: stray, openDollars: dollars };
}

const LATEX = /\\(documentclass|usepackage|begin\{[A-Za-z*]+\}|end\{[A-Za-z*]+\}|section|subsection|maketitle|cite|ref|label|emph|textbf|textit)\b/g;

/** Diagnostics of the project's `files` (main `main`) and of its build. */
export function diagnose(files: Record<string, string>, main: string | null, build?: BuildFacts): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (!/\.(tex|sty|def)$/i.test(file)) continue;
    const s = scan(text);
    if (s.openBraces.length) {
      const at = s.openBraces[0];
      out.push({
        severity: "warning",
        code: "unclosed-brace",
        message: `{ never closed${s.openBraces.length > 1 ? ` (${s.openBraces.length} open)` : ""}: the group runs to the end of the file`,
        file,
        line: lineAt(text, at),
      });
    }
    for (const at of s.strayBraces.slice(0, 3))
      out.push({ severity: "warning", code: "stray-brace", message: "} with no { to close", file, line: lineAt(text, at) });
    for (const at of s.openDollars.slice(0, 3))
      out.push({ severity: "warning", code: "unclosed-math", message: "$ never closed in this paragraph", file, line: lineAt(text, at) });
    // (\def\x with no { on its line: the body is whatever comes next)
    for (const m of text.matchAll(/(^|[^\\])\\[gex]?def\s*\\([A-Za-z@]+)([^{\n%]*)$/gm))
      out.push({ severity: "warning", code: "def-no-body", message: `\\${m[2]} is defined with no { body } on its line`, file, line: lineAt(text, m.index! + m[1].length) });
    const ifs = [...text.matchAll(/\\if[a-z]*\b/g)];
    const fis = (text.match(/\\fi\b/g) ?? []).length;
    // (only where no macro could be closing them: files without \def)
    if (ifs.length > fis && !/\\[gex]?def/.test(text))
      out.push({ severity: "info", code: "unclosed-if", message: `${ifs.length - fis} \\if… without \\fi`, file, line: lineAt(text, ifs.at(-1)!.index!) });
    for (const m of text.matchAll(/\\input\s*\{?([^\s}\\%]+)/g)) {
      const n = m[1];
      if (!(n in files) && !(`${n}.tex` in files) && !/\.(aux|bbl|ind|toc)$/.test(n) && !n.startsWith("\\"))
        out.push({ severity: "warning", code: "missing-file", message: `\\input ${n}: no such file in the project`, file, line: lineAt(text, m.index!) });
    }
    const latex = [...new Set(text.match(LATEX) ?? [])];
    if (latex.length) {
      const first = text.search(LATEX);
      out.push({
        severity: "error",
        code: "latex",
        message: `LaTeX is not supported yet (dropped): ${latex.slice(0, 5).join(" ")}${latex.length > 5 ? " …" : ""}`,
        file,
        line: lineAt(text, first),
      });
    }
    let nonAscii = 0;
    let firstNon = -1;
    for (let i = 0; i < text.length; i++)
      if (text.charCodeAt(i) > 0x7f) {
        nonAscii++;
        if (firstNon < 0) firstNon = i;
      }
    if (nonAscii)
      out.push({ severity: "info", code: "non-ascii", message: `${nonAscii} non-ASCII characters: PhiTeX's fonts may not typeset them`, file, line: lineAt(text, firstNon) });
  }
  if (main && files[main] !== undefined && !/\\(bye|end|enddocument)\b/.test(files[main]))
    out.push({ severity: "info", code: "no-end", message: "no \\bye: the last page ships at the end of the file anyway", file: main });
  if (build) {
    if (build.pending)
      out.push({ severity: "warning", code: "pending", message: `${build.pending} part${build.pending === 1 ? "" : "s"} not read: out of fuel (a loop?) or unsupported` });
    if (build.undefinedNames?.length) out.push({ severity: "warning", code: "undefined", message: `undefined: ${build.undefinedNames.join(" ")}` });
    if (build.unavailable?.length) {
      const names = build.unavailable.slice(0, 6).join(" ") + (build.unavailable.length > 6 ? " …" : "");
      out.push({
        severity: "warning",
        code: "package-unavailable",
        message: build.packageSource
          ? `not in the project, not found in ${build.packageSource}: ${names}`
          : `packages are not downloaded yet (PhiTeX runs no LaTeX): ${names}`,
      });
    }
    if (build.pages === 0) out.push({ severity: "warning", code: "no-pages", message: "no page shipped yet" });
  }
  const rank = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// A live preview session, independent of the editor and of where the core
// runs: the project's texts, the edits batched once a frame and sent in
// order, page-first painting, the latencies, and the debug check.
//
// An editor is an EditorHost (Overleaf: the page hook + the ZIP; VS Code:
// its workspace API), the core is reached through a CoreTransport (a chrome
// port to the offscreen worker; a Node worker; a sidecar), and the preview
// is drawn by a PreviewSink (the shadow-DOM panel; a webview).

import { Batch, type Edit } from "./edits.ts";
import { diagnose, type Diagnostic } from "./diagnostics.ts";

/** An editor. Edits are sequential (each against the text just before it), in UTF-16. */
export interface EditorHost {
  /** Every text file of the project, by path. */
  loadProject(): Promise<Record<string, string>>;
  /** The main file among them, if the host knows it (else guessed). */
  mainFile?(files: Record<string, string>): string | null;
  onOpen(cb: (file: string, text: string) => void): void;
  onChanges(cb: (file: string, edits: Edit[]) => void): void;
  /** Called once the session is ready for onOpen (the host may re-announce the open file). */
  ready?(): void;
}

/** The core's requests (worker.ts's `Req`, less the routing fields). */
export type CoreReq =
  | { op: "open"; main: string; files: Record<string, string>; fuel: number }
  | { op: "edit"; file: string; start: number; end: number; text: string; page: number; dpi: number }
  | { op: "set_file"; file: string; text: string }
  | { op: "png"; page: number; dpi: number }
  | { op: "pdf" }
  | { op: "status" }
  | { op: "check"; file?: string; expect?: string };

/** A page as PhiTeX draws it, in PDF points from the top left (core's draws_json). */
export interface Draws {
  w: number;
  h: number;
  /** Font names (Times-Roman, ...), indexed by `t`'s font. */
  f: string[];
  /** Words: x, y (baseline), size, font, text. */
  t: [number, number, number, number, string][];
  /** Rules: x, y (top), width, height. */
  r: [number, number, number, number][];
}

/** A page to show: its draw list (vector), or a PNG. */
export type PageImage = { draws: Draws } | { png: Uint8Array };

export interface CoreRes {
  ok: boolean;
  json?: any;
  png?: Uint8Array;
  draws?: Draws;
  pdf?: Uint8Array;
  error?: string;
}

export interface CoreTransport {
  request(req: CoreReq): Promise<CoreRes>;
  /** Called when the core is lost (the session reopens). */
  onLost?(cb: () => void): void;
}

export interface Status {
  pages: number;
  /** What the source and the build tell, worst first (diagnostics.ts). */
  diagnostics?: Diagnostic[];
  /** Values pending (unsupported, or out of fuel); undefined: not known yet. */
  pending?: number;
  main: string | null;
  file: string | null;
}

export interface PreviewSink {
  page(img: PageImage | null, k: number, n: number): void;
  status(s: Status): void;
  /** A one-line summary, and (optionally) the details behind it. */
  latency(summary: string, details?: string): void;
  /** A build is in flight. */
  busy?(on: boolean): void;
  /** A repaint is on screen, `ms` after the keystroke that made it. */
  painted?(ms: number): void;
  error(e: string): void;
  check?(r: { ok: boolean; ms: number; mismatch?: string }): void;
  mains?(names: string[], main: string | null): void;
}

export interface Options {
  fuel: number;
  /** Pages as draw lists (vector: real text, a few KB) or PNGs (PhiTeX's: a grey box a glyph). */
  format: "vector" | "png";
  dpi: number;
  checkEveryMs: number;
  /** Schedules a flush (default: next animation frame, or 100 ms if frames stop). */
  schedule?: (f: () => void) => void;
  now?: () => number;
}

// (fuel is per chunk: 10^5 steps is far more than plain documents need, and
// a runaway recursion costs ~70 ms a keystroke, not 700)
const defaults: Options = { fuel: 100_000, format: "vector", dpi: 96, checkEveryMs: 5000 };

const image = (r: CoreRes): PageImage | null => (r.draws ? { draws: r.draws } : r.png?.length ? { png: r.png } : null);

export function guessMain(files: Record<string, string>): string | null {
  const names = Object.keys(files).filter((n) => /\.tex$/i.test(n));
  const score = (n: string) => {
    const t = files[n];
    let s = 0;
    if (/(^|\n)[^%\n]*\\(bye|end\{document\})/.test(t)) s += 4;
    if (/(^|\n)\s*\\documentclass/.test(t)) s += 2;
    if (/^main\.tex$/i.test(n)) s += 1;
    if (!n.includes("/")) s += 1;
    return s;
  };
  return names.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** `text` replacing `old`, as the one edit of their differing middle (null: same). */
export function diff(old: string, text: string): Edit | null {
  if (old === text) return null;
  let a = 0;
  while (a < old.length && a < text.length && old[a] === text[a]) a++;
  let z = 0;
  while (z < old.length - a && z < text.length - a && old[old.length - 1 - z] === text[text.length - 1 - z]) z++;
  // (never split a surrogate pair)
  if (a > 0 && /[\udc00-\udfff]/.test(old[a] ?? "")) a--;
  if (z > 0 && /[\udc00-\udfff]/.test(old[old.length - z] ?? "")) z--;
  return { from: a, to: old.length - z, text: text.slice(a, text.length - z) };
}

export class PreviewSession {
  private o: Options;
  /** Each file's text as sent to the core (queued edits: in `batches`). */
  private files: Record<string, string> = {};
  private batches = new Map<string, Batch>();
  main: string | null = null;
  open: string | null = null;
  page = 0;
  pages = 0;
  private opened = false;
  debug = false;
  /** When each file's queued edits began (the oldest keystroke not sent). */
  private since = new Map<string, number>();
  private scheduled = false;
  /** Sends are chained: the core gets the edits in the order they were made. */
  private chain: Promise<void> = Promise.resolve();
  private host: EditorHost;
  private core: CoreTransport;
  private sink: PreviewSink;

  constructor(host: EditorHost, core: CoreTransport, sink: PreviewSink, opts: Partial<Options> = {}) {
    this.host = host;
    this.core = core;
    this.sink = sink;
    this.o = { ...defaults, ...opts };
    host.onOpen((f, t) => {
      this.open = f;
      this.sync(f, t);
      this.status();
    });
    host.onChanges((f, es) => this.queue(f, es));
    core.onLost?.(() => {
      this.opened = false;
      this.sink.error("core lost; reopening");
      this.reopen();
    });
  }

  private dpi(): number {
    return this.o.format === "vector" ? 0 : this.o.dpi;
  }

  setFormat(f: Options["format"]): Promise<void> {
    this.o.format = f;
    return this.showPage();
  }

  private now(): number {
    return (this.o.now ?? (() => performance.now()))();
  }

  async start(): Promise<void> {
    const files = await this.host.loadProject();
    // (a file the editor already announced keeps the editor's text)
    for (const [f, t] of Object.entries(files)) if (!(f in this.files)) this.files[f] = t;
    this.main = this.host.mainFile?.(this.files) ?? guessMain(this.files);
    this.sink.mains?.(Object.keys(this.files).filter((f) => f.endsWith(".tex")), this.main);
    await this.reopen();
    this.host.ready?.();
    if (this.o.checkEveryMs > 0) setInterval(() => this.debug && this.check(), this.o.checkEveryMs);
  }

  /** Files changed outside the editor (e.g. a project reloaded): each diffed in. */
  refresh(files: Record<string, string>): void {
    for (const [f, t] of Object.entries(files)) if (f !== this.open) this.sync(f, t);
  }

  setMain(m: string): Promise<void> {
    this.main = m;
    return this.reopen();
  }

  /** A fresh core session from the texts with every queued edit in. */
  async reopen(): Promise<void> {
    if (!this.main) return this.sink.error("no main .tex file found");
    for (const [f, b] of this.batches) this.files[f] = b.text;
    this.batches.clear();
    const t = this.now();
    const r = await this.core.request({ op: "open", main: this.main, files: this.files, fuel: this.o.fuel });
    if (!r.ok) return this.sink.error(r.json?.error ?? r.error ?? "open failed");
    this.opened = true;
    this.pages = r.json.pages;
    this.status(r.json.pending, r.json.undefined_names);
    this.sink.latency(`opened in ${r.json.build_ms.toFixed(1)} ms (round trip ${(this.now() - t).toFixed(1)} ms)`);
    await this.showPage();
  }

  private lastWarned = 0;
  private diags: Diagnostic[] = [];
  private undefinedNames: string[] = [];

  /** The last status scan's pending count (edits keep it until the next scan). */
  private pending?: number;

  private status(pending?: number, undefinedNames?: string[]): void {
    this.pending = pending;
    // (the source scan is O(project): at most once a second)
    if (undefinedNames) this.undefinedNames = undefinedNames;
    if (this.now() - this.lastWarned > 250 || undefinedNames) {
      const texts: Record<string, string> = {};
      for (const f of Object.keys(this.files)) texts[f] = this.text(f)!;
      this.diags = diagnose(texts, this.main, { pages: this.pages, pending, undefinedNames: this.undefinedNames });
      this.lastWarned = this.now();
    }
    this.sink.status({ pages: this.pages, pending, main: this.main, file: this.open, diagnostics: this.diags });
  }

  setPage(p: number): Promise<void> {
    this.page = Math.max(0, Math.min(p, Math.max(this.pages - 1, 0)));
    return this.showPage();
  }

  async showPage(): Promise<void> {
    if (!this.opened) return;
    const r = await this.core.request({ op: "png", page: this.page, dpi: this.dpi() });
    this.sink.page(image(r), this.page, this.pages);
  }

  async pdf(): Promise<Uint8Array | undefined> {
    this.flush();
    await this.chain;
    const t = this.now();
    const r = await this.core.request({ op: "pdf" });
    this.sink.latency(`PDF made in ${(this.now() - t).toFixed(1)} ms`);
    return r.pdf;
  }

  /** `file` is now `text`: only the differing middle is sent. */
  sync(file: string, text: string): void {
    const old = this.batches.get(file)?.text ?? this.files[file];
    if (old === undefined) {
      this.files[file] = text;
      if (this.opened) this.chain = this.chain.then(() => this.core.request({ op: "set_file", file, text }).then(() => undefined));
      return;
    }
    const e = diff(old, text);
    if (e) this.queue(file, [e]);
  }

  queue(file: string, edits: Edit[]): void {
    if (!edits.length) return;
    let b = this.batches.get(file);
    if (!b) this.batches.set(file, (b = new Batch(this.files[file] ?? "")));
    if (!(file in this.files)) this.files[file] = "";
    if (!b.size) this.since.set(file, this.now());
    for (const e of edits) b.push(e);
    this.keystrokes += edits.length;
    if (!this.scheduled) {
      this.scheduled = true;
      const f = () => this.flush();
      if (this.o.schedule) this.o.schedule(f);
      else {
        // (rAF: once a frame; a hidden tab gets no frames, so a timer too)
        requestAnimationFrame(f);
        setTimeout(f, 100);
      }
    }
  }

  /** A send loop is running (it takes what is queued when each build ends). */
  private busy = false;
  /** Edits the host gave, and builds they took (the batching's effect). */
  keystrokes = 0;
  builds = 0;

  /**
   * Send the queued edits, in order; the last of a round painted first
   * (edit_view). Backpressure: at most one round in flight. What is typed
   * meanwhile merges into the batches, and goes as one edit when the core
   * is free: a fast core builds every keystroke, a slow one the last N
   * together, never a state already stale.
   */
  flush(): Promise<void> {
    this.scheduled = false;
    if (!this.opened || this.busy) return this.chain;
    this.busy = true;
    this.sink.busy?.(true);
    this.chain = this.chain.then(async () => {
      try {
        for (;;) {
          const round = [...this.batches].filter(([, b]) => b.size);
          if (!round.length) break;
          for (const [file, b] of round) if (!(await this.send(file, b))) return;
        }
        this.statusSoon();
      } finally {
        this.busy = false;
        this.sink.busy?.(false);
      }
    });
    return this.chain;
  }

  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The pending/undefined scan flattens the whole program (3 ms at 180 KB,
   * ten times an edit): once the edits have settled, at most every 300 ms.
   */
  private statusSoon(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(async () => {
      this.statusTimer = null;
      if (this.busy || !this.opened) return this.statusSoon();
      const r = await this.core.request({ op: "status" });
      if (r.ok && r.json) {
        this.pages = r.json.pages;
        this.status(r.json.pending, r.json.undefined_names);
      }
    }, 300);
  }

  private async send(file: string, b: Batch): Promise<boolean> {
    const t0 = this.since.get(file) ?? this.now();
    const tSend = this.now();
    const edits = b.take();
    this.files[file] = b.text;
    for (const [i, e] of edits.entries()) {
      const last = i === edits.length - 1;
      this.builds++;
      const r = await this.core.request({ op: "edit", file, ...e, page: last ? this.page : -1, dpi: this.dpi() });
      if (!r.ok) {
        this.sink.error(r.json?.error ?? r.error ?? "edit failed");
        if (r.error?.includes("trapped")) await this.reopen();
        return false;
      }
      if (!last) continue;
      const tBack = this.now();
      const j = r.json;
      this.pages = j.pages;
      this.status(this.pending);
      const img = image(r);
      if (img) this.sink.page(img, this.page, this.pages);
      else await this.showPage();
      const e2e = this.now() - t0;
      this.sink.painted?.(e2e);
      this.sink.latency(
        `${e2e.toFixed(0)} ms keystroke→page · core ${j.paint_ms.toFixed(1)} ms · ${this.keystrokes} edits → ${this.builds} builds`,
        [
          `first paint      ${j.paint_ms.toFixed(2)} ms (in the core: edit_view, the page painted)`,
          `fixed point      ${j.total_ms.toFixed(2)} ms (every page, the .aux/.bbl loops)${j.wrong ? " · first paint was superseded" : ""}`,
          `keystroke→page   ${e2e.toFixed(1)} ms = queued ${(tSend - t0).toFixed(1)} + round trip ${(tBack - tSend).toFixed(1)} + paint ${(this.now() - tBack).toFixed(1)}`,
          `rebuilt          ${j.stats.rebuilt} of ${j.stats.rebuilt + j.stats.reused} chunks, ${j.stats.passes} pass${j.stats.passes === 1 ? "" : "es"}`,
          r.draws ? `page             vector, ${r.draws.t.length} words` : j.png_bytes ? `page             PNG ${(j.png_bytes / 1024).toFixed(0)} KB (${j.png_compress_ms.toFixed(1)} ms to compress)` : "",
          `batching         ${this.keystrokes} edits → ${this.builds} builds (one in flight; the rest merged)`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    return true;
  }

  /** PhiTeX's invariant: the incremental state = a fresh build of the same text. */
  async check(): Promise<CoreRes["json"]> {
    if (!this.opened) return;
    await this.flush();
    const file = this.open ?? this.main!;
    const r = await this.core.request({ op: "check", file, expect: this.files[file] });
    this.sink.check?.(r.json);
    return r.json;
  }

  /** The texts the session has sent (tests). */
  text(file: string): string | undefined {
    return this.batches.get(file)?.text ?? this.files[file];
  }
}

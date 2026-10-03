// A live preview session, independent of the editor and of where the core
// runs: the project's texts, the edits batched once a frame and sent in
// order, page-first painting, the latencies, and the debug check.
//
// An editor is an EditorHost (Overleaf: the page hook + the ZIP; VS Code:
// its workspace API), the core is reached through a CoreTransport (a chrome
// port to the offscreen worker; a Node worker; a sidecar), and the preview
// is drawn by a PreviewSink (the shadow-DOM panel; a webview).

import { Batch, type Edit } from "./edits.ts";
import { diagnose, type Diagnostic, type TexError } from "./diagnostics.ts";
import { DELIVERED, isPackageFile, referenced, noPackages, type PackageSource, type PackageState } from "./packages.ts";

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
  | { op: "log" }
  | { op: "pages" }
  | { op: "check"; file?: string; expect?: string }
  /** (answered by the offscreen document, shelf.ts: not the core) */
  | { op: "package"; name: string };

/** A page as PhiTeX draws it, in PDF points from the top left (core's draws_json). */
export interface Draws {
  w: number;
  h: number;
  /** Font names (Times-Roman, ...), indexed by `t`'s font. */
  f: string[];
  /** Words: x, y (baseline), size, font, text, and the width PhiTeX laid it out with. */
  t: [number, number, number, number, string, number?][];
  /** Rules: x, y (top), width, height. */
  r: [number, number, number, number][];
}

/** A page to show: its draw list (vector), or a PNG. */
/** A page: its draw list, or a PNG (PDF mode: rendered by pdf.js, `w`/`h` its size in PDF points). */
export type PageImage = { draws: Draws } | { png: Uint8Array; w?: number; h?: number } | { canvas: HTMLCanvasElement; w: number; h: number };

export interface CoreRes {
  ok: boolean;
  json?: any;
  png?: Uint8Array;
  draws?: Draws;
  pdf?: Uint8Array;
  /** (`package`: the file's text, null: none; and where from) */
  text?: string | null;
  from?: string;
  /** (a page drawn from the PDF, in the tab: its canvas and size in PDF points) */
  canvas?: HTMLCanvasElement;
  size?: [number, number];
  /** (`package`: a binary file, handed to the core by the offscreen document) */
  delivered?: boolean;
  error?: string;
}

/** A request, for the trace: its op and fields, texts by their length. */
function traceReq(r: CoreReq): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "op" || k === "id") continue;
    o[k] = typeof v === "string" && v.length > 40 ? `${v.length} chars` : v && typeof v === "object" ? `${Object.keys(v).length} keys` : v;
  }
  return o;
}
/** A reply, for the trace: what the core said, briefly. */
function traceRes(r: CoreRes): Record<string, unknown> {
  const j = (r.json ?? {}) as Record<string, any>;
  return {
    ok: r.ok,
    ...(r.error ? { error: r.error } : {}),
    ...(typeof j.how === "string" ? { how: j.how.split("\n")[0].slice(0, 140) } : {}),
    ...(j.pages !== undefined ? { pages: Array.isArray(j.pages) ? j.pages.length : j.pages } : {}),
    ...(j.history !== undefined ? { history: j.history } : {}),
    ...(Array.isArray(j.missing) && j.missing.length ? { missing: j.missing.length } : {}),
    ...(j.error ? { texError: typeof j.error === "string" ? j.error : j.error.message } : {}),
    ...(j.build_ms !== undefined ? { build_ms: Math.round(j.build_ms) } : {}),
    ...(r.pdf ? { pdf: r.pdf.length } : {}),
  };
}

export type CoreEvent = { event: "fetching"; pack: string; name: string };

export interface CoreTransport {
  request(req: CoreReq): Promise<CoreRes>;
  /** Called when the core is lost (the session reopens). */
  onLost?(cb: () => void): void;
  /** What the core says unasked: a Shelf pack it is fetching mid-build. */
  onEvent?(cb: (e: CoreEvent) => void): void;
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
  /** Page `k` of `n` drawn (`hash`: its box's, if known). */
  page(img: PageImage | null, k: number, n: number, hash?: string | null): void;
  /** The pages there are, by their boxes' hashes (a continuous view draws the changed ones it shows). */
  layout?(hashes: string[]): void;
  status(s: Status): void;
  /** A one-line summary, and (optionally) the details behind it. */
  latency(summary: string, details?: string): void;
  /** Packages being downloaded (not the project's files: say so), and those not found. */
  packages?(p: PackageState): void;
  /** A build is running (true) or none is (false): the view says so if it takes a while. */
  busy?(on: boolean): void;
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
  /** Where files the project doesn't have come from (packages.ts; default: nowhere). */
  packages?: PackageSource;
  /** Schedules a flush (default: the next task). */
  schedule?: (f: () => void) => void;
  now?: () => number;
}

// (fuel is per chunk: 10^5 steps is far more than plain documents need, and
// a runaway recursion costs ~70 ms a keystroke, not 700)
const defaults: Options = { fuel: 100_000, format: "vector", dpi: 96, checkEveryMs: 5000 };

const image = (r: CoreRes): PageImage | null =>
  r.draws
    ? { draws: r.draws }
    : r.canvas && r.size
      ? { canvas: r.canvas, w: r.size[0], h: r.size[1] }
      : r.png?.length
        ? { png: r.png, w: r.size?.[0], h: r.size?.[1] }
        : null;

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

  /**
   * What happened, in order (dev: scripts/mock-run.mjs reads it): each core
   * request and its reply, package fetches, layouts. A ring of the last 3000,
   * times in ms since the session began; never document text, only sizes.
   */
  readonly trace: { t: number; k: string; d?: unknown }[] = [];
  /** The core fetches what it lacks from Shelf itself (its open reply says so). */
  private coreFetches = false;
  /** Shelf packs the core fetched in the build under way (shown as loading until it ends). */
  private inBuild: string[] = [];
  private tellPackages(): void {
    this.sink.packages?.({ ...this.pkg, loading: [...this.pkg.loading], unavailable: [...this.pkg.unavailable], done: [...(this.pkg.done ?? [])], failed: [...(this.pkg.failed ?? [])] });
  }
  /** The core fetches a pack mid-build (the job goes on with it): the view says which. */
  private onFetching(e: CoreEvent): void {
    this.tr("package: core fetches", e);
    this.pkg.source = this.source.label;
    // (one at a time, in order: the one before it has arrived)
    const prev = this.inBuild.at(-1);
    if (prev) this.pkg.loading = this.pkg.loading.filter((n) => n !== prev);
    if (prev) this.pkg.done = [...(this.pkg.done ?? []), prev];
    this.inBuild.push(e.pack);
    this.pkg.loading = [...this.pkg.loading, e.pack];
    this.tellPackages();
  }

  /** Core requests sent and not answered yet; of them, ones that may build. */
  inflight = 0;
  private building = 0;
  private t0 = 0;
  tr(k: string, d?: unknown): void {
    this.t0 ||= this.now();
    this.trace.push({ t: Math.round(this.now() - this.t0), k, d });
    if (this.trace.length > 3000) this.trace.shift();
  }

  constructor(host: EditorHost, core: CoreTransport, sink: PreviewSink, opts: Partial<Options> = {}) {
    this.host = host;
    // (a trap in the core, a panic, restarts its instance: every session it
    // held is gone, "no such handle". Reopened here, a few times at most,
    // since a panic a build always hits would loop)
    core.onEvent?.((e) => this.onFetching(e));
    this.core = {
      request: async (r) => {
        const t0 = this.now();
        this.tr(`→ ${r.op}`, traceReq(r));
        this.inflight++;
        // (the ops that may build: the view shows a build that takes a while)
        const builds = r.op === "edit" || r.op === "status" || r.op === "open";
        if (builds && this.building++ === 0) this.sink.busy?.(true);
        const res = await core.request(r).finally(() => {
          this.inflight--;
          if (builds && --this.building === 0) this.sink.busy?.(false);
          // (the build that fetched them is done: the packs are in)
          if (builds && this.inBuild.length) {
            this.pkg.done = [...(this.pkg.done ?? []), ...this.inBuild.filter((n) => this.pkg.loading.includes(n))];
            this.pkg.loading = this.pkg.loading.filter((n) => !this.inBuild.includes(n));
            this.inBuild = [];
            this.tellPackages();
          }
        });
        this.tr(`← ${r.op}`, { ms: Math.round(this.now() - t0), ...traceRes(res) });
        const lost = res.json?.error === "no such handle" || /^core trapped/.test(res.error ?? "");
        if (lost && this.opened && r.op !== "open") {
          this.opened = false;
          const t = this.now();
          this.traps = this.traps.filter((x) => t - x < 60_000).concat(t);
          const why = res.error ?? "the core restarted";
          if (this.traps.length <= 3) {
            this.sink.error(`${why}; reopening`);
            this.chain = this.chain.then(() => this.reopen());
          } else this.sink.error(`${why}, again: the preview stops here (reload the page to retry)`);
        }
        return res;
      },
      onLost: core.onLost?.bind(core),
    };
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
    // (every page again, in the new format)
    if (this.sink.layout) {
      this.hashes = [];
      return this.layout();
    }
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

  /**
   * Clean recompile: the project's files as Overleaf has them now, packages
   * that failed or were not found asked for again, and a fresh core session
   * (discovery, first paint, then the incremental program), nothing kept from
   * the last job but the packages already fetched.
   */
  async clean(files: Record<string, string>): Promise<void> {
    for (const [f, t] of Object.entries(files)) if (f !== this.open) this.files[f] = t;
    for (const n of [...this.pkg.unavailable, ...(this.pkg.failed ?? []).map((f) => f.name)]) this.asked.delete(n);
    this.pkg.unavailable = [];
    this.pkg.failed = [];
    this.texError = undefined;
    this.hashes = [];
    return this.reopen();
  }

  /** A fresh core session from the texts with every queued edit in. */
  async reopen(): Promise<void> {
    if (!this.main) return this.sink.error("no main .tex file found");
    for (const [f, b] of this.batches) this.files[f] = b.text;
    this.batches.clear();
    const t = this.now();
    // (what the project's files load, by a scan, fetched before the first
    // build: a cold build costs the format's load, ~0.7 s in wasm, and stops
    // at the first file it lacks)
    // (pdftex.map: every PDF-mode build reads it first)
    await this.prefetch(["pdftex.map", ...Object.values(this.files).flatMap(referenced)]);
    const r = await this.core.request({ op: "open", main: this.main, files: { ...this.pkgFiles, ...this.files }, fuel: this.o.fuel });
    if (!r.ok) return this.sink.error((typeof r.json?.error === "string" ? r.json.error : undefined) ?? r.error ?? "open failed");
    this.opened = true;
    const latex = r.json.engine === "partex";
    // (diagnosed before this was known: say it again with it)
    if (latex !== this.latex) this.lastWarned = 0;
    this.latex = latex;
    this.coreFetches = !!r.json.fetches;
    this.setPages(r.json.pages);
    this.noteError(r.json);
    this.status(r.json.pending, r.json.undefined_names);
    this.fetchPackages(r.json.missing);
    this.sink.latency(`opened in ${r.json.build_ms.toFixed(1)} ms (round trip ${(this.now() - t).toFixed(1)} ms)`);
    await (this.sink.layout ? this.layout() : this.showPage());
    // (the first build is in: nothing is building for the packages now)
    this.pkg.building = false;
    this.tellPackages();
    this.statusSoon();
  }

  private lastWarned = 0;
  /** When the core trapped, in the last minute. */
  private traps: number[] = [];
  /** The core runs LaTeX (the open reply's `engine`; until it says, as partex's, the default build). */
  private latex = true;
  private diags: Diagnostic[] = [];
  /** The last build's first TeX error (the core's status), if it had one. */
  private texError?: TexError;
  private noteError(j: { history?: number; error?: unknown }): void {
    if (j.history === undefined) return;
    this.texError = j.error && typeof j.error === "object" ? (j.error as TexError) : undefined;
  }
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
      this.diags = diagnose(texts, this.main, {
        pages: this.pages,
        pending,
        undefinedNames: this.undefinedNames,
        unavailable: this.pkg.unavailable,
        packageSource: this.source === noPackages ? undefined : this.source.label,
        latex: this.latex,
        texError: this.texError,
        packageErrors: this.pkg.failed,
      });
      this.lastWarned = this.now();
    }
    this.sink.status({ pages: this.pages, pending, main: this.main, file: this.open, diagnostics: this.diags });
  }

  /** Packages the core was given (kept apart from the project's files: never diagnosed, never a main). */
  private pkgFiles: Record<string, string> = {};
  /** Every package name asked for once: not asked again. */
  private asked = new Set<string>();
  private pkg: PackageState = { loading: [], unavailable: [], source: "none", done: [], building: false };
  private get source(): PackageSource {
    return this.o.packages ?? noPackages;
  }

  /**
   * The core read `missing` and found nothing: each package among them
   * fetched (once), then set as a file (a rebuild each: the core never
   * looks for a missing file again). What they read in turn shows up in
   * the next status, and is fetched then.
   */
  private fetchPackages(missing?: string[], guessed: string[] = []): void {
    // (a core that fetches from Shelf itself, mid-build, looked everywhere:
    // what it still lacks is nowhere; said, not fetched again)
    if (this.coreFetches) {
      const none = (missing ?? []).filter((n) => isPackageFile(n) && !this.pkg.unavailable.includes(n));
      if (none.length) (this.pkg.unavailable.push(...none), this.tellPackages());
      return;
    }
    const wanted = new Set(missing ?? []);
    missing = [...wanted, ...guessed];
    const want = [...new Set(missing ?? [])].filter((n) => isPackageFile(n) && !(n in this.files) && !this.asked.has(n));
    if (!want.length) return;
    for (const n of want) this.asked.add(n);
    const src = this.source;
    this.pkg.source = src.label;
    const tell = () =>
      this.sink.packages?.({ ...this.pkg, loading: [...this.pkg.loading], unavailable: [...this.pkg.unavailable], done: [...(this.pkg.done ?? [])], failed: [...(this.pkg.failed ?? [])] });
    if (src === noPackages) {
      this.pkg.unavailable.push(...want);
      tell();
      return this.status(this.pending, this.undefinedNames);
    }
    this.pkg.loading.push(...want);
    tell();
    // (each package fetched is scanned for the ones it loads, and those are
    // fetched too, before the next build: the build stops at the first file
    // it lacks, so learning them one build at a time costs a build each)
    const got: (readonly [string, string | null])[] = [];
    this.tr("packages: want", want);
    const fetchOne = async (n: string): Promise<void> => {
      const t = await src.resolve(n).catch((e) => this.failed(n, e));
      this.tr(t === null ? "package: none" : "package: got", n);
      got.push([n, t]);
      this.pkg.loading = this.pkg.loading.filter((m) => m !== n);
      if (t !== null) {
        this.pkg.done!.push(n);
        this.pkg.failed = this.pkg.failed?.filter((f) => f.name !== n);
      }
      const more = t === null || t === DELIVERED ? [] : referenced(t).filter((m) => isPackageFile(m) && !(m in this.files) && !this.asked.has(m));
      for (const m of more) this.asked.add(m);
      this.pkg.loading.push(...more);
      tell();
      await Promise.all(more.map(fetchOne));
    };
    void Promise.all(want.map(fetchOne)).then(() => {
      for (const [n, t] of got) {
        if (t === null) {
          // (a name the scan guessed and the build never asked for is not "unavailable")
          if (wanted.has(n) && !this.pkg.failed?.some((f) => f.name === n)) this.pkg.unavailable.push(n);
          continue;
        }
        // (a binary file: the source gave it to the core, and gives it again on a reopen)
        if (t === DELIVERED) continue;
        this.pkgFiles[n] = t;
        if (this.opened) this.chain = this.chain.then(() => this.core.request({ op: "set_file", file: n, text: t }).then(() => undefined));
      }
      const any = got.some(([, t]) => t !== null);
      this.pkg.building = any;
      tell();
      this.status(this.pending, this.undefinedNames);
      if (any)
        this.chain = this.chain
          .then(() => this.layout())
          .then(() => {
            this.pkg.building = false;
            tell();
            this.statusSoon();
          });
    });
  }

  /** After the core's discovery pass: what it asked for is here (or nowhere), so the first paint may build. Once per open. */
  /** A fetch that failed: kept with why (shown), and askable again. */
  private failed(n: string, e: unknown): null {
    this.asked.delete(n);
    const error = e instanceof Error ? e.message : String(e);
    this.pkg.failed = [...(this.pkg.failed ?? []).filter((f) => f.name !== n), { name: n, error }];
    return null;
  }

  /** Fetch `names` (and what they load, by the scan) into pkgFiles, before a session opens. */
  private async prefetch(names: string[]): Promise<void> {
    const src = this.source;
    const want = [...new Set(names)].filter((n) => isPackageFile(n) && !(n in this.files) && !this.asked.has(n));
    if (src === noPackages || !want.length) return;
    this.pkg.source = src.label;
    const tell = () =>
      this.sink.packages?.({ ...this.pkg, loading: [...this.pkg.loading], unavailable: [...this.pkg.unavailable], done: [...(this.pkg.done ?? [])], failed: [...(this.pkg.failed ?? [])] });
    for (const n of want) this.asked.add(n);
    this.pkg.loading.push(...want);
    tell();
    const one = async (n: string): Promise<void> => {
      const t = await src.resolve(n).catch((e) => this.failed(n, e));
      this.pkg.loading = this.pkg.loading.filter((m) => m !== n);
      if (t !== null) this.pkg.done!.push(n);
      if (t !== null && t !== DELIVERED) this.pkgFiles[n] = t;
      const more = t === null || t === DELIVERED ? [] : referenced(t).filter((m) => isPackageFile(m) && !(m in this.files) && !this.asked.has(m));
      for (const m of more) this.asked.add(m);
      this.pkg.loading.push(...more);
      tell();
      await Promise.all(more.map(one));
    };
    const t0 = this.now();
    this.tr("prefetch: start", want.length);
    await Promise.all(want.map(one));
    this.tr("prefetch: done", { files: this.pkg.done?.length ?? 0, ms: Math.round(this.now() - t0) });
    this.pkg.building = true;
    tell();
  }

  /** The page count of the last build; the page in view kept inside it
   * (a build with no page, an error, keeps the page: it comes back). */
  private setPages(n: number): void {
    this.pages = n;
    if (n > 0 && this.page >= n) this.page = n - 1;
  }

  /** The page in view (the one an edit paints first). */
  setPage(p: number): Promise<void> {
    this.page = Math.max(0, Math.min(p, Math.max(this.pages - 1, 0)));
    return this.sink.layout ? Promise.resolve() : this.showPage();
  }

  /** The pages' hashes, as the core has them now. */
  private hashes: string[] = [];

  /** Tell the view which pages there are (by hash). */
  private async layout(): Promise<void> {
    if (!this.sink.layout) return;
    const r = await this.core.request({ op: "pages" });
    if (!r.ok || !r.json?.pages) return;
    this.hashes = r.json.pages;
    this.tr("layout", { pages: this.hashes.length });
    this.setPages(this.hashes.length);
    // (no page shipped: the view keeps what it shows, dimmed; see the sink)
    if (this.hashes.length) this.sink.layout(this.hashes);
  }

  /** Everything again, for a view that just joined (a detached PDF tab). */
  async resync(): Promise<void> {
    if (!this.opened) return;
    this.sink.mains?.(Object.keys(this.files).filter((f) => f.endsWith(".tex")), this.main);
    this.status(this.pending);
    await (this.sink.layout ? this.layout() : this.showPage());
  }

  /** Page `k`, for a view that wants it. */
  async fetch(k: number): Promise<void> {
    if (!this.opened) return;
    const r = await this.core.request({ op: "png", page: k, dpi: this.dpi() });
    const img = image(r);
    if (img) this.sink.page(img, k, this.pages, this.hashes[k] ?? null);
  }

  async showPage(): Promise<void> {
    if (!this.opened) return;
    if (this.sink.layout) return this.layout();
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
      // (the next task, not the next frame: a window without frames, an
      // unfocused or covered one, waited for a 100 ms fallback; edits that
      // come while a build runs are merged by the send loop anyway)
      else setTimeout(f, 0);
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
  /** Paused (the extension turned off): edits keep merging in their batches, sent on resume. */
  private paused = false;

  pause(on: boolean): void {
    this.paused = on;
    if (!on) void this.flush();
  }

  flush(): Promise<void> {
    this.scheduled = false;
    if (!this.opened || this.busy || this.paused) return this.chain;
    this.busy = true;
    this.sink.busy?.(true);
    this.chain = this.chain.then(async () => {
      try {
        for (;;) {
          const round = [...this.batches].filter(([, b]) => b.size);
          if (!round.length) break;
          for (const [file, b] of round) if (!(await this.send(file, b))) return;
        }
        // (then the other pages: the view draws those it shows that changed)
        await this.layout();
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
        this.setPages(r.json.pages);
        this.noteError(r.json);
        this.status(r.json.pending, r.json.undefined_names);
        this.fetchPackages(r.json.missing);
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
        this.sink.error((typeof r.json?.error === "string" ? r.json.error : undefined) ?? r.error ?? "edit failed");
        if (r.error?.includes("trapped")) await this.reopen();
        return false;
      }
      if (!last) continue;
      const tBack = this.now();
      const j = r.json;
      this.setPages(j.pages);
      this.noteError(j);
      this.status(this.pending);
      const img = image(r);
      if (img) this.sink.page(img, this.page, this.pages, j.painted_hash ?? null);
      else if (!this.sink.layout) await this.showPage();
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

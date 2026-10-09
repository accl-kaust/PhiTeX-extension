// The core's host: owns the core's workers and serves its clients (an
// Overleaf tab, through the offscreen document's port; a VS Code preview, in
// the extension host): each client's requests go to its worker, the packages
// it asks for are resolved here (shelf.ts), its binary files kept and given
// again after each open, the draw worker fed the PDF each build links, its
// compares diffed (diff.ts), and Shelf's release told. Bytes stay bytes here: a transport that carries JSON
// (a chrome port) encodes them itself.

import type { Req, Res } from "./worker.ts";
import { index, resolve } from "./shelf.ts";
import { refresh, type Release } from "./release.ts";
import { type DiffReply, type DiffReq, loadDiff } from "./vendor/viewer/diff.ts";
import { platform } from "./platform.ts";

/** A worker: the browser's, or worker_threads' as the host adapts it. */
export interface CoreWorker {
  postMessage(m: unknown, transfer: ArrayBuffer[]): void;
  postMessage(m: unknown): void;
  /** (called with the message as `e.data`) */
  onmessage: ((e: any) => void) | null;
}

export interface CoreHostOptions {
  /** A new worker running the core (worker.ts); "draw": the one that only draws pages. */
  spawn(name?: "draw"): CoreWorker;
  /** The two-worker start (see below), where the machine allows it. */
  two: boolean;
}

/** A client's end: its messages in (`{id, op, …}`, and `binary` with `bytes`), `close` when it goes. */
export interface CoreClient {
  message(m: any): void;
  close(): void;
}

export class CoreHost {
  /** Shelf's release as last read (release.ts): each client is told on connecting. */
  private release: Release | undefined;
  private worker: CoreWorker;
  /**
   * The two-worker start: at an open, `worker` (A) makes the plain first
   * paint and serves edits as plain rebuilds, while `ssa` (B) builds the SSA
   * program from the start; edits go to A and, queued, to B (edits only, B
   * builds them after its open). When B is ready the client's session
   * switches to it (a `switched` event: its pages, sync and status from B;
   * pages drawn again only where they differ) and A's session closes. One
   * worker, as before, on a machine with fewer than 4 cores or 4 GB. Shelf
   * packs: both fetch through the same cache (the browser's HTTP cache lets
   * one request for a URL fetch while the others wait for it).
   */
  private two: boolean;
  private ssa: CoreWorker | undefined;
  /** Per client in the two-worker start: B not ready yet ("plain") or ready ("ssa"), and its open's number (a newer open drops an older B's). */
  private dual = new Map<string, { phase: "plain" | "ssa"; open: number }>();
  /**
   * The draw worker: a second core instance that only draws pages, from the
   * PDF the build worker links. Pages draw while a build (or readying the
   * next one) runs; the page read first, then the rest ahead of time.
   */
  private drawer: CoreWorker;
  /** The clients whose drawer has their current PDF: their pages are asked there. */
  private drawn = new Set<string>();
  private replies = new Map<number, (r: Res) => void>();
  private nextId = 1;
  /** Every client's end: the worker's progress (a Shelf pack fetched mid-build) goes to each. */
  private clients = new Set<(m: any) => void>();
  /** Each client's `say`, by its name: what is for it alone (a streamed build's events). */
  private saying = new Map<string, (m: any) => void>();
  private spawn: CoreHostOptions["spawn"];
  /** diff.wasm, loaded at the first compare. */
  private diffRun: Promise<(r: DiffReq) => DiffReply> | undefined;
  private refreshing: ReturnType<typeof setInterval>;

  constructor(o: CoreHostOptions) {
    this.spawn = o.spawn;
    this.two = o.two;
    const told = (r: Release | undefined) => {
      this.release = r;
      for (const p of this.clients) p({ event: "release", release: r });
    };
    // (at most once a day; a newer index is used by the next worker)
    void refresh().then(told, () => undefined);
    this.refreshing = setInterval(() => void refresh().then(told, () => undefined), 3600 * 1000);
    // (Shelf's index read now, half a second of parsing, while the client
    // still reads its project: ready by the first package asked)
    void index().catch(() => undefined);
    this.worker = o.spawn();
    this.worker.onmessage = (e) => this.fromWorker(e.data);
    this.drawer = o.spawn("draw");
    this.drawer.onmessage = (e: { data: Res }) => {
      this.replies.get(e.data.id)?.(e.data);
      this.replies.delete(e.data.id);
    };
  }

  private fromWorker(d: Res & { fetching?: string; name?: string; failed?: boolean; drawPdf?: boolean; client?: string; pdf?: Uint8Array; preparing?: boolean; settled?: boolean; event?: string }): void {
    // (a streamed build's pages, progress and end: its client's only)
    if (d.event && d.client) {
      this.saying.get(d.client)?.(d);
      return;
    }
    if (d.fetching) {
      for (const p of this.clients) p({ event: "fetching", pack: d.fetching, name: d.name, failed: d.failed });
      return;
    }
    if (d.drawPdf && d.client && d.pdf) {
      this.drawer.postMessage({ id: this.nextId++, client: d.client, op: "drawpdf", pdf: d.pdf } as Req, [d.pdf.buffer as ArrayBuffer]);
      this.drawn.add(d.client);
      return;
    }
    if (d.settled) {
      for (const p of this.clients) p({ event: "settled" });
      return;
    }
    if (d.preparing !== undefined) {
      for (const p of this.clients) p({ event: "preparing", on: d.preparing });
      return;
    }
    this.replies.get(d.id)?.(d);
    this.replies.delete(d.id);
  }

  /** The worker a client's requests go to. */
  private route(client: string): CoreWorker {
    return this.dual.get(client)?.phase === "ssa" ? this.ssa! : this.worker;
  }

  /** A new client, `client` its unique name; what the host says to it goes to `post` (replies carry its own ids). */
  connect(client: string, post: (m: any) => void): CoreClient {
    const { worker, dual, drawn, replies } = this;
    // (a client gone: what it was told late is dropped)
    const say = (m: any) => {
      try {
        post(m);
      } catch {
        /* (the client went away) */
      }
    };
    this.clients.add(say);
    this.saying.set(client, say);
    if (this.release) say({ event: "release", release: this.release });
    // (binary files, font metrics: given to this client's core session here;
    // again after each open, a new session)
    const binaries = new Map<string, Uint8Array>();
    // (in the two-worker start's plain phase, to both)
    const post2 = (r: Req) => {
      this.route(client).postMessage(r);
      if (dual.get(client)?.phase === "plain") this.ssa!.postMessage({ ...r, id: this.nextId++ } as Req);
    };
    const give = (file: string, bytes: Uint8Array) => post2({ id: this.nextId++, client, op: "set_bytes", file, bytes } as Req);
    const message = (m: any) => {
      // (the project's binary files, figures: kept, given now and after each open)
      if (m.op === "binary") {
        binaries.set(m.file, m.bytes);
        give(m.file, m.bytes);
        say({ id: m.id, ok: true });
        return;
      }
      // (a compare: PhiTeX's latexdiff, diff.wasm, run here)
      if (m.op === "latexdiff") {
        (this.diffRun ??= platform().asset("dist/diff.wasm").then(async (r) => loadDiff(await r.arrayBuffer()))).then(
          (run) => say({ id: m.id, ok: true, json: run(m.req) }),
          (e) => say({ id: m.id, ok: false, error: `latexdiff: ${e}` }),
        );
        return;
      }
      // (packages: answered here, not by the worker)
      if (m.op === "package") {
        resolve(m.name, m.engine).then(
          (r) => {
            // (the rest of its packs: straight to the core, as bytes)
            for (const [f, b] of r?.extra ?? []) {
              binaries.set(f, b);
              give(f, b);
            }
            if (r?.inCore) {
              say({ id: m.id, ok: true, text: null, delivered: true, from: r.from });
              return;
            }
            if (r?.bytes) {
              binaries.set(m.name, r.bytes);
              give(m.name, r.bytes);
              say({ id: m.id, ok: true, text: null, delivered: true, from: r.from });
            } else say({ id: m.id, ok: true, text: r?.text ?? null, from: r?.from });
          },
          (e) => say({ id: m.id, ok: false, error: String(e) }),
        );
        return;
      }
      const id = this.nextId++;
      replies.set(id, (r) => say({ ...r, id: m.id }));
      // (a new session: its pages from the build worker until its PDF reaches the drawer)
      if (m.op === "open") drawn.delete(client);
      // (the draw worker draws draw lists; a page from the PDF, dpi -1, is the build worker's)
      if (m.op === "png" && m.dpi >= 0 && drawn.has(client)) return this.drawer.postMessage({ ...m, id, client } as Req);
      if (m.op === "open") {
        // (an open carries the binary files given so far, figures and fonts: the first build has them)
        const bins = Object.fromEntries(binaries);
        const was = dual.get(client);
        // (an open after B took over: B goes on alone, as one worker would)
        // (one worker opens alone: its plain first paint streamed, as A's)
        if (!this.two || m.workers === 1 || was?.phase === "ssa") return this.route(client).postMessage({ ...m, id, client, binaries: bins, stream: true } as Req);
        if (was) this.ssa!.postMessage({ id: this.nextId++, client, op: "close" } as Req);
        if (!this.ssa) {
          this.ssa = this.spawn();
          this.ssa.onmessage = (e) => this.fromWorker(e.data);
        }
        const open = this.nextId++;
        dual.set(client, { phase: "plain", open });
        // (A's plain build streamed: each page as it is shipped)
        worker.postMessage({ ...m, id, client, binaries: bins, start: 1, noMinted: true, stream: true } as Req);
        // (B: the SSA program at once; ready when its open answers)
        replies.set(open, (r) => {
          if (dual.get(client)?.open !== open) return;
          if (!r.ok) {
            // (B failed: A builds the program after all)
            dual.delete(client);
            worker.postMessage({ id: this.nextId++, client, op: "plain_only", on: false } as Req);
            return;
          }
          dual.set(client, { phase: "ssa", open });
          worker.postMessage({ id: this.nextId++, client, op: "close" } as Req);
          drawn.delete(client);
          say({ event: "switched" });
        });
        // (B builds behind A's pages: not streamed, its open answers when it is in)
        this.ssa.postMessage({ ...m, id: open, client, binaries: bins, start: 2 } as Req);
        return;
      }
      this.route(client).postMessage({ ...m, id, client } as Req);
      // (B queues what changes the project, as edits only: it builds them after its open)
      if (dual.get(client)?.phase === "plain") {
        if (m.op === "edit") this.ssa!.postMessage({ ...m, id: this.nextId++, client, page: -1 } as Req);
        else if (m.op === "set_file") this.ssa!.postMessage({ ...m, id: this.nextId++, client } as Req);
      }
    };
    const close = () => {
      this.clients.delete(say);
      this.saying.delete(client);
      worker.postMessage({ id: this.nextId++, client, op: "close" });
      this.ssa?.postMessage({ id: this.nextId++, client, op: "close" });
      dual.delete(client);
      this.drawer.postMessage({ id: this.nextId++, client, op: "close" });
      drawn.delete(client);
    };
    return { message, close };
  }

  /** Stop looking for Shelf's releases (the host goes; its workers are the spawner's to end). */
  stop(): void {
    clearInterval(this.refreshing);
  }
}

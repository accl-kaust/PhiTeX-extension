// The core's host (common/src/corehost.ts: its workers, the packages it
// resolves, the draw worker) in VS Code's extension host. Its workers are
// Node worker threads (worker.ts, bundled as dist/worker.js), each with a
// port for the Shelf packs it reads mid-build, answered here from the
// package cache (shelf.ts's packRaw: kept, else fetched from Shelf and kept,
// the cache under its cap) while the worker waits on a shared flag. A
// session talks to the host in process: no encoding, bytes stay bytes.

import { MessageChannel, Worker } from "node:worker_threads";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { CoreHost, type CoreClient, type CoreWorker } from "../../common/src/corehost.ts";
import { packRaw } from "../../common/src/shelf.ts";
import type { CoreEvent, CoreReq, CoreRes, CoreTransport } from "../../common/src/vendor/viewer/session.ts";
import type { WorkerData } from "./worker.ts";

/** The host and its workers, for the extension at `root`, its store in `store`. */
export function startCore(root: string, store: string, log: (s: string) => void): { host: CoreHost; stop(): void } {
  const threads: Worker[] = [];
  const spawn = (name?: "draw"): CoreWorker => {
    const { port1, port2 } = new MessageChannel();
    const flag = new SharedArrayBuffer(4);
    const i32 = new Int32Array(flag);
    const data: WorkerData = { root, store, name: name ?? "", port: port2, flag };
    const w = new Worker(join(root, "dist/worker.js"), { workerData: data, transferList: [port2], name: name ?? "core" });
    port1.on("message", (m: { n: number; pack: string }) => {
      void packRaw(m.pack)
        .then((p) => p.raw, (e) => (log(`pack ${m.pack}: ${e}`), null))
        .then((bytes) => {
          port1.postMessage({ n: m.n, bytes });
          Atomics.store(i32, 0, 1);
          Atomics.notify(i32, 0);
        });
    });
    port1.unref();
    const cw: CoreWorker = { postMessage: (m: unknown, transfer?: ArrayBuffer[]) => w.postMessage(m, transfer), onmessage: null };
    w.on("message", (d) => cw.onmessage?.({ data: d }));
    w.on("error", (e) => log(`core worker${name ? ` (${name})` : ""} stopped: ${e}`));
    threads.push(w);
    return cw;
  };
  // (the two-worker start where a browser would have it: 4 cores, 4 GB)
  const host = new CoreHost({ spawn, two: cpus().length >= 4 && totalmem() >= 4 * 2 ** 30 });
  return { host, stop: () => threads.forEach((t) => void t.terminate()) };
}

let clients = 0;

/** A session's transport to the host, in process. */
export class HostTransport implements CoreTransport {
  private c: CoreClient;
  private nextId = 1;
  private waiting = new Map<number, (r: CoreRes) => void>();
  private events: ((e: CoreEvent) => void)[] = [];

  constructor(host: CoreHost) {
    this.c = host.connect(`vscode${++clients}`, (m) => {
      if (m.event) return this.events.forEach((f) => f(m));
      this.waiting.get(m.id)?.(m);
      this.waiting.delete(m.id);
    });
  }

  request(req: CoreReq | { op: "binary"; file: string; bytes: Uint8Array }): Promise<CoreRes> {
    const id = this.nextId++;
    return new Promise((res) => {
      this.waiting.set(id, res);
      this.c.message({ id, ...req });
    });
  }

  onEvent(cb: (e: CoreEvent) => void): void {
    this.events.push(cb);
  }

  close(): void {
    this.c.close();
    for (const w of this.waiting.values()) w({ ok: false, error: "preview closed" });
    this.waiting.clear();
  }
}

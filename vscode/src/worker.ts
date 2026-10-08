// The core's worker (common/src/worker.ts) in a Node worker thread. The core
// reads what it lacks synchronously, mid-build: a file of the extension's
// from disk, a Shelf pack from the extension host (core.ts: kept in the
// package cache, else fetched and kept), this thread waiting on a shared
// flag meanwhile and taking the reply off its port (receiveMessageOnPort).

import { parentPort, receiveMessageOnPort, workerData, type MessagePort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setPlatform } from "../../common/src/platform.ts";
import { startWorker } from "../../common/src/worker.ts";
import { nodePlatform } from "./platform.ts";

export interface WorkerData {
  root: string;
  store: string;
  name: string;
  /** The pack requests' port, and the flag the host sets when it has answered. */
  port: MessagePort;
  flag: SharedArrayBuffer;
}

const d = workerData as WorkerData;
setPlatform(nodePlatform(d.root, d.store));
const flag = new Int32Array(d.flag);
let asked = 0;
/** (a pack slower than this is taken for failed: the build goes on without it) */
const PACK_WAIT_MS = 120_000;

function pack(id: string): Uint8Array | null {
  const n = ++asked;
  Atomics.store(flag, 0, 0);
  d.port.postMessage({ n, pack: id });
  const t0 = Date.now();
  for (;;) {
    // (the flag cleared before the port is read: an answer posted after the
    // read sets it again, so the wait returns at once)
    // (a late answer to an earlier ask is dropped)
    for (let m = receiveMessageOnPort(d.port); m; m = receiveMessageOnPort(d.port)) {
      const r = m.message as { n: number; bytes: Uint8Array | null };
      if (r.n === n) return r.bytes;
    }
    const left = PACK_WAIT_MS - (Date.now() - t0);
    if (left <= 0) return null;
    Atomics.wait(flag, 0, 0, left);
    Atomics.store(flag, 0, 0);
  }
}

startWorker({
  name: d.name,
  post: (m, transfer) => parentPort!.postMessage(m, transfer),
  listen: (f) => parentPort!.on("message", f),
  readSync(w) {
    if ("pack" in w) return pack(w.pack);
    try {
      const b = readFileSync(join(d.root, w.asset));
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch {
      return null;
    }
  },
});

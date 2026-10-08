// The core's worker (common/src/worker.ts) as the browser runs it: a module
// worker of the offscreen document (Firefox: of the background page), the
// core's synchronous reads by XMLHttpRequest (a worker may make them), so
// the browser's HTTP cache keeps Shelf's packs.

import "./platform.ts";
import { platform } from "./common/platform.ts";
import { packUrl } from "./common/release.ts";
import { startWorker, type Req } from "./common/worker.ts";

function getSync(url: string): Uint8Array | null {
  const x = new XMLHttpRequest();
  x.open("GET", url, false);
  x.responseType = "arraybuffer";
  try {
    x.send();
  } catch {
    return null;
  }
  return x.status === 200 ? new Uint8Array(x.response as ArrayBuffer) : null;
}

startWorker({
  name: (self as unknown as { name?: string }).name ?? "",
  post: (m, transfer) => (self as unknown as Worker).postMessage(m, transfer ?? []),
  listen: (f) => {
    self.onmessage = (ev: MessageEvent<Req>) => f(ev.data);
  },
  readSync: (w) => getSync("pack" in w ? packUrl(w.pack) : platform().assetUrl(w.asset)),
});

// Overleaf's "Open PDF in separate tab": the detached tab has no editor, so
// it mirrors the editor tab's session. The editor tab sends everything its
// sink is told (remote.ts's tee); the detached tab asks for the pages it
// scrolls to. One BroadcastChannel a project, between the two tabs' content
// scripts.

import type { PreviewSink } from "./common/vendor/viewer/session.ts";
import { apply, tee, type Told } from "./common/vendor/viewer/remote.ts";

export { tee };

/** Detached → editor. */
export type Ask = { t: "hello" } | { t: "need"; k: number } | { t: "page"; k: number } | { t: "goto"; file: string; line: number } | { t: "sync"; k: number; x: number; y: number } | { t: "bye" };

export const channel = (project: string) => new BroadcastChannel(`phitex:${project}`);

/** In the detached tab: the editor tab's sink calls, applied to ours. */
export function follow(ch: BroadcastChannel, sink: PreviewSink): void {
  ch.addEventListener("message", (e: MessageEvent<Told>) => {
    // (the editor tab (re)started after us: say hello again)
    if (e.data?.t === "up") return ch.postMessage({ t: "hello" } satisfies Ask);
    apply(sink, e.data);
  });
  ch.postMessage({ t: "hello" } satisfies Ask);
  addEventListener("pagehide", () => ch.postMessage({ t: "bye" } satisfies Ask));
}

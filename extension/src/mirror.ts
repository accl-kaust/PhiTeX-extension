// Overleaf's "Open PDF in separate tab": the detached tab has no editor, so
// it mirrors the editor tab's session. The editor tab sends everything its
// sink is told; the detached tab asks for the pages it scrolls to. One
// BroadcastChannel a project, between the two tabs' content scripts.

import type { PreviewSink } from "./session.ts";

/** Detached → editor. */
export type Ask = { t: "hello" } | { t: "need"; k: number } | { t: "page"; k: number } | { t: "goto"; file: string; line: number } | { t: "sync"; k: number; x: number; y: number } | { t: "bye" };
/** Editor → detached: a sink call. */
export type Told = { t: "sink"; m: keyof PreviewSink; a: unknown[] } | { t: "up" };

export const channel = (project: string) => new BroadcastChannel(`phitex:${project}`);

/** `sink`, with every call also sent to the detached tab (while one listens). */
export function tee(sink: PreviewSink, ch: BroadcastChannel, live: () => boolean): PreviewSink {
  return new Proxy(sink, {
    get(t, m: keyof PreviewSink) {
      const f = t[m] as ((...a: unknown[]) => void) | undefined;
      if (typeof f !== "function") return f;
      return (...a: unknown[]) => {
        if (live()) {
          try {
            ch.postMessage({ t: "sink", m, a } satisfies Told);
          } catch {
            /* (a value that doesn't clone: the editor tab still has it) */
          }
        }
        return f.apply(t, a);
      };
    },
  });
}

/** In the detached tab: the editor tab's sink calls, applied to ours. */
export function follow(ch: BroadcastChannel, sink: PreviewSink): void {
  ch.addEventListener("message", (e: MessageEvent<Told>) => {
    // (the editor tab (re)started after us: say hello again)
    if (e.data?.t === "up") return ch.postMessage({ t: "hello" } satisfies Ask);
    if (e.data?.t !== "sink") return;
    const f = sink[e.data.m] as ((...a: unknown[]) => void) | undefined;
    f?.apply(sink, e.data.a);
  });
  ch.postMessage({ t: "hello" } satisfies Ask);
  addEventListener("pagehide", () => ch.postMessage({ t: "bye" } satisfies Ask));
}

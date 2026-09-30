import { test } from "node:test";
import assert from "node:assert/strict";
import { PreviewSession, diff, type CoreReq, type CoreRes, type EditorHost } from "../extension/src/session.ts";
import { apply, type Edit } from "../extension/src/edits.ts";

const enc = new TextEncoder(), dec = new TextDecoder();

/** A core that applies byte edits to its files, and logs requests. */
function fakeCore() {
  const files: Record<string, Uint8Array> = {};
  const log: CoreReq[] = [];
  return {
    files,
    log,
    async request(r: CoreReq): Promise<CoreRes> {
      log.push(r);
      await new Promise((ok) => setTimeout(ok, Math.random() * 3)); // (replies take time)
      if (r.op === "open") {
        for (const [n, t] of Object.entries(r.files)) files[n] = enc.encode(t);
        return { ok: true, json: { pages: 1, pending: 0, build_ms: 1 } };
      }
      if (r.op === "edit") {
        const b = files[r.file], t = enc.encode(r.text);
        const n = new Uint8Array(b.length - (r.end - r.start) + t.length);
        n.set(b.subarray(0, r.start)); n.set(t, r.start); n.set(b.subarray(r.end), r.start + t.length);
        files[r.file] = n;
        return { ok: true, json: { pages: 1, pending: 0, paint_ms: 0, total_ms: 0, stats: { rebuilt: 1, reused: 0, passes: 1 } } };
      }
      if (r.op === "set_file") { files[r.file] = enc.encode(r.text); return { ok: true }; }
      return { ok: true };
    },
  };
}

function host(project: Record<string, string>) {
  let open!: (f: string, t: string) => void, change!: (f: string, e: Edit[]) => void;
  const h: EditorHost = { loadProject: async () => ({ ...project }), onOpen: (cb) => (open = cb), onChanges: (cb) => (change = cb) };
  return { h, open: (f: string, t: string) => open(f, t), change: (f: string, e: Edit[]) => change(f, e) };
}

const sink = { page() {}, status() {}, latency() {}, error(e: string) { throw new Error(e); } };

test("diff is one edit", () => {
  for (const [a, b] of [["Héllo 😀!", "Héllo 😃!"], ["abc", "abc"], ["", "x"], ["x😀", "x"]] as const) {
    const e = diff(a, b);
    assert.equal(e ? apply(a, e) : a, b);
  }
});

test("edits across files arrive in order, per flush, as bytes", async () => {
  const core = fakeCore();
  const ed = host({ "main.tex": "\\input part\n\\bye\n", "part.tex": "Pärt 😀.\n" });
  let tick: (() => void) | null = null;
  const s = new PreviewSession(ed.h, core, sink, { checkEveryMs: 0, schedule: (f) => (tick = f), now: () => 0 });
  await s.start();
  const texts = { "main.tex": "\\input part\n\\bye\n", "part.tex": "Pärt 😀.\n" } as Record<string, string>;
  let seed = 3;
  const r = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let round = 0; round < 200; round++) {
    for (let k = 0; k < 1 + Math.floor(r() * 5); k++) {
      const f = r() < 0.5 ? "main.tex" : "part.tex";
      const t = texts[f];
      let at = Math.floor(r() * (t.length + 1));
      if (/[\udc00-\udfff]/.test(t[at] ?? "")) at--;
      const e = { from: at, to: at, text: ["ä", "😀", "x", "\n"][Math.floor(r() * 4)] };
      texts[f] = apply(t, e);
      ed.change(f, [e]);
    }
    if (r() < 0.3) { const f = "part.tex"; ed.open(f, texts[f]); } // (an open with the same text: no edit)
    tick?.();
  }
  await s.flush();
  for (const f of Object.keys(texts)) assert.equal(dec.decode(core.files[f]), texts[f], f);
  // (batched: fewer requests than keystrokes)
  assert.ok(core.log.filter((q) => q.op === "edit").length < 600);
});

test("an open with the editor's newer text sends only the difference", async () => {
  const core = fakeCore();
  const ed = host({ "main.tex": "Hello world.\n\\bye\n" });
  let tick: (() => void) | null = null;
  const s = new PreviewSession(ed.h, core, sink, { checkEveryMs: 0, schedule: (f) => (tick = f) });
  await s.start();
  ed.open("main.tex", "Hello wörld.\n\\bye\n");
  tick!();
  await s.flush();
  const edits = core.log.filter((q) => q.op === "edit");
  assert.deepEqual(edits.map((q: any) => [q.start, q.end, q.text]), [[7, 8, "ö"]]);
});

test("a slow core: keystrokes typed during a build go as one edit", async () => {
  const core = fakeCore();
  const slow = { request: async (r: CoreReq) => { if (r.op === "edit") await new Promise((ok) => setTimeout(ok, 50)); return core.request(r); } };
  const ed = host({ "main.tex": "Hi \\bye\n" });
  const s = new PreviewSession(ed.h, slow, sink, { checkEveryMs: 0, schedule: (f) => setTimeout(f, 0) });
  await s.start();
  let text = "Hi \\bye\n";
  for (const ch of "typing forty characters, one at a time!") {
    const at = text.indexOf("\\bye");
    text = apply(text, { from: at, to: at, text: ch });
    ed.change("main.tex", [{ from: at, to: at, text: ch }]);
    await new Promise((ok) => setTimeout(ok, 5)); // (a keystroke every 5 ms, a build 50 ms)
  }
  await s.flush();
  assert.equal(dec.decode(core.files["main.tex"]), text);
  assert.ok(s.builds <= 6, `${s.builds} builds for ${s.keystrokes} keystrokes`);
});

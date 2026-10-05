// A local stand-in for Overleaf: the editor page (overleaf.html, a mock of
// its DOM, with CodeMirror 6 itself: mock/editor/, scripts/mock-editor.sh) at /project/mock, and
// the endpoints the extension reads: /entities, /doc/:id/download,
// /download/zip. Edits made in the mock are kept in memory (as a server).
//   node mock/server.mjs [port]
// MOCK_PROJECT: a folder (default mock/project; `latex` is mock/latex/) or an
// Overleaf source ZIP ("Download as source"), binaries (figures) included.
// Recompile runs the local pdflatex (twice) on a copy in /tmp/tex/mock,
// as Overleaf's compile: its PDF, log and download, to compare with PhiTeX's.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";

const dir = path.dirname(new URL(import.meta.url).pathname);
const port = +(process.argv[2] ?? 8123);
const docs = new Map(); // id → { path, text }
const files = new Map(); // path → Buffer (binary files: figures)
let n = 0;
const TEXT = /\.(tex|bib|cls|sty|bst|bbx|cbx|lbx|dbx|cfg|def|clo|fd|ltx|txt|md|ist|tikz|pgf|dtx|ins)$/i;
const add = (p, b) => {
  if (TEXT.test(p) && !b.includes(0)) docs.set(`d${String(++n).padStart(23, "0")}`, { path: p, text: b.toString("utf8") });
  else files.set(p, b);
};

/** An archive's entries: [path, bytes] (stored or deflated, as Overleaf's ZIP has). */
function unzip(b) {
  const out = [];
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  const count = b.readUInt16LE(e + 10);
  let c = b.readUInt32LE(e + 16);
  for (let k = 0; k < count; k++) {
    const method = b.readUInt16LE(c + 10), size = b.readUInt32LE(c + 20), nl = b.readUInt16LE(c + 28), xl = b.readUInt16LE(c + 30), cl = b.readUInt16LE(c + 32);
    const local = b.readUInt32LE(c + 42), name = b.subarray(c + 46, c + 46 + nl).toString("utf8");
    c += 46 + nl + xl + cl;
    if (name.endsWith("/")) continue;
    const at = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(at, at + size);
    out.push([name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw)]);
  }
  return out;
}

const proj = path.resolve(dir, process.env.MOCK_PROJECT ?? "project"); // (or an absolute path)
if (proj.endsWith(".zip")) for (const [p, b] of unzip(fs.readFileSync(proj))) add(p, b);
else {
  const walk = (d, rel = "") => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${f.name}` : f.name;
      if (f.isDirectory()) walk(path.join(d, f.name), r);
      else add(r, fs.readFileSync(path.join(d, f.name)));
    }
  };
  walk(proj);
}

function zip(entries) {
  // (stored and deflated entries, as Overleaf's has both)
  const parts = [], central = [];
  let off = 0;
  for (const [name, body] of entries) {
    const raw = Buffer.from(body), data = zlib.deflateRawSync(raw), nb = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(zlib.crc32(raw), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nb.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(zlib.crc32(raw), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nb, data); central.push(c, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}

/** Overleaf's compile, locally: the project as it is now, pdflatex, in /tmp/tex/mock. */
const OUT = "/tmp/tex/mock";
function compile() {
  return new Promise((res) => {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    const put = (p, b) => (fs.mkdirSync(path.dirname(path.join(OUT, p)), { recursive: true }), fs.writeFileSync(path.join(OUT, p), b));
    for (const d of docs.values()) put(d.path, d.text);
    for (const [p, b] of files) put(p, b);
    const main = [...docs.values()].find((d) => /\\documentclass/.test(d.text))?.path ?? "main.tex";
    const t = Date.now();
    // (pdflatex itself, twice for references: latexmk's own rc may send its output elsewhere)
    const run = (k) =>
      execFile("pdflatex", ["-interaction=nonstopmode", "-jobname=output", main], { cwd: OUT, timeout: 120_000 }, () =>
        k > 1 ? run(k - 1) : res({ ok: fs.existsSync(path.join(OUT, "output.pdf")), ms: Date.now() - t }),
      );
    run(2);
  });
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, type, body) => (res.writeHead(code, { "content-type": type }), res.end(body));
  let m;
  if (u.pathname === "/project/mock" || u.pathname === "/project/mock/")
    return send(200, "text/html; charset=utf-8", fs.readFileSync(path.join(dir, "overleaf.html")));
  // (the editor: CodeMirror 6 and Overleaf's grammar, scripts/mock-editor.sh)
  if (u.pathname === "/project/mock/editor.js") {
    const f = path.join(dir, "build/editor.js");
    if (!fs.existsSync(f)) return send(404, "text/plain", "mock/build/editor.js: run scripts/sandbox scripts/mock-editor.sh");
    return send(200, "text/javascript; charset=utf-8", fs.readFileSync(f));
  }
  if (u.pathname === "/project/mock/entities")
    return send(200, "application/json", JSON.stringify({ project_id: "mock", entities: [...docs.values()].map((d) => ({ path: "/" + d.path, type: "doc" })).concat([...files.keys()].map((p) => ({ path: "/" + p, type: "file" }))) }));
  if (u.pathname === "/project/mock/docs")
    return send(200, "application/json", JSON.stringify([...docs].map(([id, d]) => ({ id, ...d }))));
  if ((m = u.pathname.match(/^\/project\/mock\/doc\/(\w+)\/download$/)) && docs.has(m[1]))
    return send(200, "text/plain; charset=utf-8", docs.get(m[1]).text);
  if ((m = u.pathname.match(/^\/project\/mock\/doc\/(\w+)$/)) && req.method === "POST") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { const d = docs.get(m[1]); if (!d) return send(404, "text/plain", "no such doc"); d.text = b; send(204, "text/plain", ""); });
    return;
  }
  if (u.pathname === "/project/mock/download/zip")
    return send(200, "application/zip", zip([...[...docs.values()].map((d) => [d.path, d.text]), ...files]));
  if (u.pathname === "/project/mock/compile" && req.method === "POST")
    return void compile().then((c) => send(200, "application/json", JSON.stringify(c)));
  if (u.pathname === "/project/mock/output/output.pdf" && fs.existsSync(path.join(OUT, "output.pdf")))
    return send(200, "application/pdf", fs.readFileSync(path.join(OUT, "output.pdf")));
  if (u.pathname === "/project/mock/output/output.log" && fs.existsSync(path.join(OUT, "output.log")))
    return send(200, "text/plain; charset=utf-8", fs.readFileSync(path.join(OUT, "output.log")));
  send(404, "text/plain", "not found");
}).listen(port, () => console.log(`mock Overleaf on http://localhost:${port}/project/mock (${docs.size} docs, ${files.size} files)`));

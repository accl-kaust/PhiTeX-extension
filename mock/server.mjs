// A local stand-in for Overleaf: the editor page (overleaf.html, a mock of
// its DOM and of CodeMirror 6's EditorView surface) at /project/mock, and
// the endpoints the extension reads: /entities, /doc/:id/download,
// /download/zip. Edits made in the mock are kept in memory (as a server).
//   node mock/server.mjs [port]      (MOCK_PROJECT=latex: mock/latex/)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const dir = path.dirname(new URL(import.meta.url).pathname);
const port = +(process.argv[2] ?? 8123);
const docs = new Map(); // id → { path, text }
let n = 0;
// (MOCK_PROJECT=latex: mock/latex/, a LaTeX project, for the partex core)
const proj = path.resolve(dir, process.env.MOCK_PROJECT ?? "project"); // (or an absolute path)
for (const f of fs.readdirSync(proj))
  docs.set(`d${String(++n).padStart(23, "0")}`, { path: f, text: fs.readFileSync(path.join(proj, f), "utf8") });

function zip(entries) {
  // (stored and deflated entries, as Overleaf's has both)
  const parts = [], central = [];
  let off = 0;
  for (const [name, text] of entries) {
    const raw = Buffer.from(text), data = zlib.deflateRawSync(raw), nb = Buffer.from(name);
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

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, type, body) => (res.writeHead(code, { "content-type": type }), res.end(body));
  let m;
  if (u.pathname === "/project/mock" || u.pathname === "/project/mock/")
    return send(200, "text/html; charset=utf-8", fs.readFileSync(path.join(dir, "overleaf.html")));
  if (u.pathname === "/project/mock/entities")
    return send(200, "application/json", JSON.stringify({ project_id: "mock", entities: [...docs.values()].map((d) => ({ path: "/" + d.path, type: "doc" })).concat([{ path: "/figure.png", type: "file" }]) }));
  if (u.pathname === "/project/mock/docs")
    return send(200, "application/json", JSON.stringify([...docs].map(([id, d]) => ({ id, ...d }))));
  if ((m = u.pathname.match(/^\/project\/mock\/doc\/(\w+)\/download$/)) && docs.has(m[1]))
    return send(200, "text/plain; charset=utf-8", docs.get(m[1]).text);
  if ((m = u.pathname.match(/^\/project\/mock\/doc\/(\w+)$/)) && req.method === "POST") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { docs.get(m[1]).text = b; send(204, "text/plain", ""); });
    return;
  }
  if (u.pathname === "/project/mock/download/zip")
    return send(200, "application/zip", zip([...docs.values()].map((d) => [d.path, d.text])));
  send(404, "text/plain", "not found");
}).listen(port, () => console.log(`mock Overleaf on http://localhost:${port}/project/mock`));

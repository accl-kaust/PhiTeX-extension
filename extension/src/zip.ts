// A ZIP reader for Overleaf's project download: stored and deflated
// entries (DecompressionStream, native), text files only.

const TEXT = /\.(tex|ltx|sty|cls|def|cfg|clo|fd|bib|bbl|bst|ind|idx|ist|txt|aux|dtx|ins|mf|mp)$/i;

async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** The text files of a ZIP, by path; others are listed in `skipped`. */
export async function readZip(buf: ArrayBuffer): Promise<{ files: Record<string, string>; skipped: string[]; binaries: Record<string, Uint8Array> }> {
  const b = new Uint8Array(buf);
  const d = new DataView(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--)
    if (d.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a zip");
  const n = d.getUint16(eocd + 10, true);
  let p = d.getUint32(eocd + 16, true);
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  /** The other files (figures, fonts): their bytes. */
  const binaries: Record<string, Uint8Array> = {};
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (let k = 0; k < n; k++) {
    if (d.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory");
    const method = d.getUint16(p + 10, true);
    const csize = d.getUint32(p + 20, true);
    const nlen = d.getUint16(p + 28, true);
    const xlen = d.getUint16(p + 30, true);
    const clen = d.getUint16(p + 32, true);
    const local = d.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    if (method !== 0 && method !== 8) {
      skipped.push(name);
      continue;
    }
    const at = local + 30 + d.getUint16(local + 26, true) + d.getUint16(local + 28, true);
    const raw = b.subarray(at, at + csize);
    if (!TEXT.test(name)) {
      binaries[name] = method === 8 ? await inflate(raw) : raw.slice();
      continue;
    }
    try {
      files[name] = utf8.decode(method === 8 ? await inflate(raw) : raw);
    } catch {
      skipped.push(name);
    }
  }
  return { files, skipped, binaries };
}

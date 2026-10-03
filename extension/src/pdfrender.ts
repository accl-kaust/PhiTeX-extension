// PDF pages to PNG, in the offscreen document: pdf.js (Apache-2.0, bundled
// in dist/pdfjs/, no remote code), as Overleaf's own viewer draws them. The
// partex core writes the PDF pdfTeX writes (its fonts embedded, TikZ as PDF
// paths); a page is drawn here and goes to the tab as a PNG, the panel's
// image path.

// @ts-ignore (pdf.js's module, copied into dist/ by scripts/build.sh; typed loosely here)
import * as pdfjs from "./pdfjs/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdfjs/pdf.worker.min.mjs", import.meta.url).href;

/** Documents by the worker's key for their bytes: the last few. */
const docs = new Map<string, Promise<any>>();

/** Keep `pdf` (if given) under `key`; the document for `key`, or null if it is not here. */
function doc(key: string, pdf?: Uint8Array): Promise<any> | null {
  if (pdf) {
    docs.set(key, pdfjs.getDocument({ data: pdf, isEvalSupported: false, disableFontFace: false }).promise);
    while (docs.size > 4) {
      const [old, p] = docs.entries().next().value!;
      docs.delete(old);
      void p.then((d: any) => d.destroy()).catch(() => undefined);
    }
  }
  return docs.get(key) ?? null;
}

/** Page `page` (0-based) of the PDF under `key` as a PNG at `dpi` (0: 192, sharp at 200% zoom), and its size in PDF points. */
export async function render(key: string, page: number, dpi: number, pdf?: Uint8Array): Promise<{ png: Uint8Array; w: number; h: number } | null> {
  const d = doc(key, pdf);
  if (!d) return null;
  const pdfDoc = await d;
  if (page >= pdfDoc.numPages) return null;
  const p = await pdfDoc.getPage(page + 1);
  const scale = (dpi || 192) / 72;
  const vp = p.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  // (intent "print": pdf.js schedules a display render by requestAnimationFrame,
  // which never fires in the offscreen document, a page no one sees)
  await p.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: vp, intent: "print" }).promise;
  const blob: Blob = await new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error("toBlob"))), "image/png"));
  const base = p.getViewport({ scale: 1 });
  p.cleanup();
  return { png: new Uint8Array(await blob.arrayBuffer()), w: base.width, h: base.height };
}

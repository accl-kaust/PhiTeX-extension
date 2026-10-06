// PDF pages drawn in the tab, into a canvas: pdf.js (bundled, dist/pdfjs/),
// in this thread (its worker would be Overleaf's origin's, which may not
// load an extension script; a page of a preview is light enough). No PNG:
// encoding one cost ~1 s a page in the offscreen document, and the canvas is
// swapped in only once drawn, so a redraw never blanks the page.

let lib: Promise<any> | undefined;
const pdfjs = () =>
  (lib ??= (async () => {
    const base = chrome.runtime.getURL("dist/pdfjs/");
    // (pdf.js's worker code on this thread: its "fake worker", taken from here)
    (globalThis as any).pdfjsWorker = await import(base + "pdf.worker.min.mjs");
    const m = await import(base + "pdf.min.mjs");
    m.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";
    return m;
  })());

/** Documents by the worker's key for their bytes: the last two. */
const docs = new Map<string, Promise<any>>();

/**
 * Page `page` of the PDF under `key` (given as `pdf` when new) drawn at
 * `scale` device pixels per PDF point: the canvas, and over it pdf.js's text
 * layer (`.textLayer`, at one CSS pixel per PDF point: the viewer scales it
 * to the page), for selecting and finding.
 */
export async function drawPage(key: string, page: number, scale: number, pdf?: Uint8Array): Promise<{ canvas: HTMLElement; w: number; h: number } | null> {
  const m = await pdfjs();
  if (pdf) {
    docs.set(key, m.getDocument({ data: pdf, isEvalSupported: false }).promise);
    while (docs.size > 2) {
      const [old, p] = docs.entries().next().value!;
      docs.delete(old);
      void p.then((d: any) => d.destroy()).catch(() => undefined);
    }
  }
  const d = await docs.get(key);
  if (!d || page >= d.numPages) return null;
  const p = await d.getPage(page + 1);
  const vp = p.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await p.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
  const base = p.getViewport({ scale: 1 });
  const el = document.createElement("div");
  el.className = "pdfjs-page";
  canvas.style.width = canvas.style.height = "100%";
  const text = document.createElement("div");
  text.className = "textLayer";
  text.style.width = `${base.width}px`;
  text.style.height = `${base.height}px`;
  text.style.setProperty("--total-scale-factor", "1");
  el.append(canvas, text);
  try {
    await new m.TextLayer({ textContentSource: p.streamTextContent(), container: text, viewport: base }).render();
  } catch (e) {
    console.warn("[phitex] text layer", e);
  }
  return { canvas: el, w: base.width, h: base.height };
}

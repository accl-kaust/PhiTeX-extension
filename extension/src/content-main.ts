// Overleaf's wiring of a PreviewSession: the page hook (hook.ts, in the
// page's world) for the editor, the project ZIP for the files, a chrome
// port to the offscreen document's worker for the core, and the panel.

import type { Edit } from "./edits.ts";
import { PreviewSession, type CoreReq, type CoreRes, type CoreTransport, type EditorHost } from "./session.ts";
import { readZip } from "./zip.ts";
import { Panel, type PanelPrefs, type Prefs } from "./panel.ts";

/** The panel's preferences, in the extension's own storage (not the page's). */
const prefs: Prefs = {
  load: async () => ((await chrome.storage.local.get("panel")).panel as Partial<PanelPrefs>) ?? {},
  save: (p) => void chrome.storage.local.set({ panel: p }),
};

const project = () => location.pathname.replace(/\/$/, "");
/** Closed docs are fetched again this often (collaborators' edits), and diffed in. */
const FOLLOW_MS = 10_000;

/** Doc paths → ids, from the file tree (every doc the tree has rendered). */
function docIds(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const e of document.querySelectorAll<HTMLElement>('.file-tree-list [data-file-type="doc"][data-file-id]')) {
    const names: string[] = [];
    for (let li: Element | null = e.closest('[role="treeitem"]'); li; li = li.parentElement?.closest('[role="treeitem"]') ?? null)
      names.unshift(li.getAttribute("aria-label") ?? "");
    ids.set(names.join("/"), e.dataset.fileId!);
  }
  return ids;
}

/**
 * The project's text docs, each on its own: `/entities` for the paths, the
 * file tree for their ids, `/doc/:id/download` for the text (no binaries
 * ever fetched). A doc whose id the tree has not rendered (a folder never
 * opened) comes from the project ZIP, the one fallback.
 */
async function fetchDocs(panel: Panel, only?: (path: string) => boolean): Promise<Record<string, string>> {
  const t = performance.now();
  const r = await fetch(`${project()}/entities`, { credentials: "include" });
  if (!r.ok) throw new Error(`project listing failed: ${r.status}`);
  const { entities } = (await r.json()) as { entities: { path: string; type: string }[] };
  const docs = entities.filter((e) => e.type === "doc").map((e) => e.path.replace(/^\//, "")).filter((p) => !only || only(p));
  // (the tree renders after the page: wait for every doc's id, up to 10 s)
  let ids = docIds();
  for (let i = 0; i < 50 && docs.some((p) => !ids.has(p)); i++) {
    await new Promise((r) => setTimeout(r, 200));
    ids = docIds();
  }
  const files: Record<string, string> = {};
  const missing: string[] = [];
  await Promise.all(
    docs.map(async (p) => {
      const id = ids.get(p);
      if (!id) return missing.push(p);
      const d = await fetch(`${project()}/doc/${id}/download`, { credentials: "include" });
      if (d.ok) files[p] = await d.text();
      else missing.push(p);
    }),
  );
  if (missing.length) {
    const z = await fetch(`${project()}/download/zip`, { credentials: "include" });
    if (z.ok) {
      const { files: zipped } = await readZip(await z.arrayBuffer());
      for (const p of missing) if (p in zipped) files[p] = zipped[p];
    }
  }
  if (!only) {
    const binaries = entities.length - docs.length;
    panel.files(Object.keys(files), [], `${(performance.now() - t).toFixed(0)} ms` + (missing.length ? `; ${missing.length} via ZIP` : "") + (binaries ? `; ${binaries} binary files not fetched` : ""));
  }
  return files;
}

class OverleafHost implements EditorHost {
  private opens: ((f: string, t: string) => void)[] = [];
  private changes: ((f: string, e: Edit[]) => void)[] = [];
  private panel: Panel;
  constructor(panel: Panel) {
    this.panel = panel;
    window.addEventListener("message", (e) => {
      if (e.source !== window || e.data?.src !== "phitex-hook") return;
      const m = e.data;
      if (!m.file) return;
      if (m.type === "open") for (const cb of this.opens) cb(m.file, m.text);
      else if (m.type === "changes") {
        const es = m.edits.map(([from, to, text]: [number, number, string]) => ({ from, to, text }));
        for (const cb of this.changes) cb(m.file, es);
      }
    });
  }
  loadProject() {
    return fetchDocs(this.panel);
  }
  onOpen(cb: (f: string, t: string) => void) {
    this.opens.push(cb);
  }
  onChanges(cb: (f: string, e: Edit[]) => void) {
    this.changes.push(cb);
  }
  ready() {
    // (the hook announces the open file again: the editor's text, unsaved
    // edits and all, wins over the ZIP's)
    window.postMessage({ src: "phitex-content", type: "hello" }, location.origin);
  }
}

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A chrome port to the offscreen document (which relays to the worker). Bytes come base64. */
class ChromeTransport implements CoreTransport {
  private port!: chrome.runtime.Port;
  private nextId = 1;
  private waiting = new Map<number, (r: CoreRes) => void>();
  private lost: (() => void)[] = [];
  async connect(): Promise<void> {
    await chrome.runtime.sendMessage({ type: "ensure-offscreen" });
    this.port = chrome.runtime.connect({ name: "phitex" });
    this.port.onMessage.addListener((r: any) => {
      if (r.png) r.png = unb64(r.png);
      if (r.pdf) r.pdf = unb64(r.pdf);
      this.waiting.get(r.id)?.(r);
      this.waiting.delete(r.id);
    });
    this.port.onDisconnect.addListener(() => {
      for (const w of this.waiting.values()) w({ ok: false, error: "core disconnected" });
      this.waiting.clear();
      setTimeout(() => this.connect().then(() => this.lost.forEach((f) => f())), 500);
    });
  }
  request(req: CoreReq): Promise<CoreRes> {
    const id = this.nextId++;
    return new Promise((res) => {
      this.waiting.set(id, res);
      this.port.postMessage({ id, ...req });
    });
  }
  onLost(cb: () => void) {
    this.lost.push(cb);
  }
}

const ZOOMS: [string, string][] = [["fit", "Fit width"], ["0.75", "75%"], ["1", "100%"], ["1.5", "150%"], ["2", "200%"]];

/** Styles for what we add to Overleaf's own DOM (the switch, the toolbar controls, the tip). */
const DOCK_CSS = `
  /* Overleaf's viewer stays laid out, only unseen: pdf.js scrolls it (recompile, SyncTeX) and needs its offsetParent */
  .phitex-on .pdf-viewer { visibility: hidden !important; pointer-events: none !important; }
  /* in PhiTeX mode, Overleaf's viewer controls go, all but its invert-colors button (which works on ours too) */
  .phitex-on #toolbar-pdf-controls *:not(:has(.theme-toggle-btn)):not(.theme-toggle-btn):not(.theme-toggle-btn *) { display: none !important; }
  .phitex-on .toolbar-pdf-right { display: flex; align-items: center; justify-content: flex-end; min-width: 0; }
  /* its controls' wrapper keeps only the invert button: no room held for the hidden rest */
  .phitex-on #toolbar-pdf-controls, .phitex-on #toolbar-pdf-controls > * { flex: 0 0 auto !important; width: auto !important; }
  .phitex-on .toolbar-pdf-left { flex-shrink: 0; }
  #phitex-controls:not(.compact) .phitex-compact-only { display: none; }
  #phitex-controls.compact .pdfjs-toolbar-buttons, #phitex-controls.compact .pdfjs-page-number-input { display: none; }
  #phitex-switch { margin-left: 8px; display: inline-flex; align-items: center; position: relative; }
  #phitex-switch .toggle-switch { margin: 0; }
  #phitex-controls, #phitex-left { display: none !important; }
  .phitex-on #phitex-controls { display: flex !important; flex: 0 0 auto !important; width: auto !important; }
  .phitex-on #phitex-left { display: inline-flex !important; align-items: center; }
  /* in PhiTeX mode, Overleaf's own logs and download (its compiler's) give way to ours, in the same place */
  .phitex-on .toolbar-pdf-left > :not(.compile-button-group):not(#phitex-switch):not(#phitex-left) { display: none !important; }
  .phitex-badge:empty { display: none; }
  #phitex-dlgroup { position: relative; align-items: center; }
  #phitex-dlgroup .phitex-caret { width: 16px; min-width: 16px; margin-left: -4px; padding: 0; }
  #phitex-dlgroup .phitex-caret .material-symbols { font-size: 16px; }
  #phitex-dlmenu .dropdown-item { display: flex; justify-content: space-between; gap: 12px; }
  .phitex-toast { animation: phitex-tip-in .35s cubic-bezier(.2,1.2,.4,1); cursor: pointer; }
  .phitex-badge { position: absolute; top: -2px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 9999px;
    font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; color: #fff; background: var(--bg-info-01, #366cbf); }
  .phitex-badge.warning { background: var(--bg-warning-01, #8f5514); } .phitex-badge.error { background: var(--bg-danger-01, #b83a33); }
  #phitex-zoom-menu { min-width: 120px; }
  #phitex-tour { position: fixed; z-index: 1060; width: 320px; max-width: calc(100vw - 16px); overflow: visible;
    border: 1.5px solid var(--green-40, #53b57f); border-radius: 12px; box-shadow: 0 0 0 4px rgb(83 181 127 / 18%), 0 18px 48px rgb(0 0 0 / 45%);
    animation: phitex-tip-in .35s cubic-bezier(.2,1.3,.4,1); }
  #phitex-tour::before { content: ""; position: absolute; top: -8px; left: var(--arrow, 50%); width: 14px; height: 14px; transform: translateX(-50%) rotate(45deg);
    background: var(--green-50, #098842); border-left: 1.5px solid var(--green-40, #53b57f); border-top: 1.5px solid var(--green-40, #53b57f); }
  #phitex-tour .popover-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; color: #fff; border: 0;
    background: linear-gradient(135deg, var(--green-50, #098842), var(--green-60, #1e6b41)); padding: 10px 14px; }
  #phitex-tour .phitex-step { font-size: 11px; font-weight: 600; opacity: .8; white-space: nowrap; }
  #phitex-tour .phitex-tip-clip { overflow: hidden; border-radius: 11px; }
  #phitex-tour .phitex-tip-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 10px; }
  #phitex-tour [data-t="skip"] { margin-right: auto; padding-left: 0; color: var(--content-placeholder-dark, #8d96a5); text-decoration: none; }
  #phitex-tour kbd { font-size: 11px; padding: 1px 4px; }
  .phitex-dots { display: flex; gap: 5px; justify-content: center; margin-top: 10px; }
  .phitex-dots span { width: 6px; height: 6px; border-radius: 50%; background: rgb(255 255 255 / 25%); transition: all .2s; }
  .phitex-dots span.on { width: 16px; border-radius: 3px; background: var(--green-40, #53b57f); }
  .phitex-ring { position: relative; outline: 2px solid var(--green-40, #53b57f) !important; outline-offset: 2px; border-radius: 6px;
    animation: phitex-ringo 1.3s ease-out infinite; }
  phitex-preview.phitex-ring { outline-offset: -4px; }
  @keyframes phitex-ringo { 50% { outline-color: rgb(83 181 127 / 30%); } }
  #phitex-tip { position: fixed; z-index: 1060; width: 320px; max-width: calc(100vw - 16px); overflow: visible;
    border: 1.5px solid var(--green-40, #53b57f); border-radius: 12px;
    box-shadow: 0 0 0 4px rgb(83 181 127 / 18%), 0 18px 48px rgb(0 0 0 / 45%), 0 0 32px rgb(83 181 127 / 35%);
    animation: phitex-tip-in .6s cubic-bezier(.18,1.5,.4,1), phitex-glow 2.4s ease-in-out .6s infinite; }
  #phitex-tip::before { content: ""; position: absolute; top: -8px; left: var(--arrow, 50%); width: 14px; height: 14px; transform: translateX(-50%) rotate(45deg);
    background: var(--green-50, #098842); border-left: 1.5px solid var(--green-40, #53b57f); border-top: 1.5px solid var(--green-40, #53b57f); }
  #phitex-tip .phitex-tip-clip { position: relative; overflow: hidden; border-radius: 11px; }
  #phitex-tip .phitex-tip-clip::after { content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(105deg, transparent 35%, rgb(255 255 255 / 22%) 50%, transparent 65%); transform: translateX(-120%);
    animation: phitex-shimmer 2.8s ease-in-out 1s infinite; }
  #phitex-tip .popover-header { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; color: #fff; border: 0;
    background: linear-gradient(135deg, var(--green-50, #098842), var(--green-60, #1e6b41)); padding: 10px 14px; }
  #phitex-tip .phitex-bolt { font-size: 20px; }
  #phitex-tip .phitex-demo { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px; margin: 10px 0 4px; padding: 8px;
    border-radius: 8px; background: rgb(0 0 0 / 22%); font-size: 12px; }
  #phitex-tip .phitex-demo code { color: var(--green-30, #86caa5); white-space: nowrap; overflow: hidden; border-right: 2px solid currentColor;
    width: 0; animation: phitex-type 2.4s steps(9) 1s infinite; font-family: "DM Mono", monospace; }
  #phitex-tip .phitex-demo .phitex-arrow { color: var(--green-30, #86caa5); animation: phitex-zip 2.4s ease-in 1s infinite; }
  #phitex-tip .phitex-demo .phitex-mini { justify-self: end; font-family: "Noto Serif", serif; color: #1b222c; background: #fff; border-radius: 3px;
    padding: 2px 8px; box-shadow: 0 2px 6px rgb(0 0 0 / 30%); opacity: .25; animation: phitex-paint 2.4s steps(1) 1s infinite; }
  @keyframes phitex-type { 0% { width: 0; } 55%, 100% { width: 9ch; } }
  @keyframes phitex-zip { 0%, 55% { transform: translateX(-4px); opacity: .3; } 62% { transform: translateX(6px); opacity: 1; } 100% { opacity: .3; } }
  @keyframes phitex-paint { 0%, 60% { opacity: .25; } 61%, 100% { opacity: 1; } }
  @keyframes phitex-shimmer { 0% { transform: translateX(-120%); } 45%, 100% { transform: translateX(120%); } }
  @keyframes phitex-glow { 50% { box-shadow: 0 0 0 6px rgb(83 181 127 / 10%), 0 18px 48px rgb(0 0 0 / 45%), 0 0 44px rgb(83 181 127 / 55%); } }
  #phitex-tip .phitex-bolt { display: inline-block; animation: phitex-shake 1.6s ease-in-out .5s 2; transform-origin: 50% 70%; }
  #phitex-tip .phitex-tip-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 10px; }
  #phitex-tip #phitex-tip-never { margin-right: auto; padding-left: 0; color: var(--content-placeholder-dark, #8d96a5); text-decoration: none; font-size: 12px; }
  #phitex-tip #phitex-tip-never:hover { color: var(--content-primary-dark, #f4f5f6); text-decoration: underline; }
  @keyframes phitex-tip-in { 0% { opacity: 0; transform: translateY(18px) scale(.85); } 60% { opacity: 1; } }
  @keyframes phitex-shake { 0%, 100% { transform: rotate(0); } 10%, 30%, 50% { transform: rotate(-14deg) scale(1.15); } 20%, 40% { transform: rotate(14deg) scale(1.15); } 60% { transform: rotate(0); } }
  .phitex-pulse { position: relative; border-radius: 9999px; }
  .phitex-pulse::after { content: ""; position: absolute; inset: -3px; border-radius: 9999px; pointer-events: none;
    box-shadow: 0 0 0 0 rgb(83 181 127 / 90%); animation: phitex-ring 1.3s ease-out infinite; }
  .phitex-pulse { background: rgb(83 181 127 / 25%); color: #fff !important; }
  @keyframes phitex-ring { 70% { box-shadow: 0 0 0 14px rgb(83 181 127 / 0%); } 100% { box-shadow: 0 0 0 0 rgb(83 181 127 / 0%); } }
  @media (prefers-reduced-motion: reduce) {
    #phitex-tip, #phitex-tip *, #phitex-tour, .phitex-ring, #phitex-tip .phitex-tip-clip::after, .phitex-pulse::after { animation: none !important; }
    #phitex-tip .phitex-demo code { width: 9ch; } #phitex-tip .phitex-demo .phitex-mini { opacity: 1; }
  }`;

/**
 * The preview docked in Overleaf's PDF pane: a PDF | PhiTeX switch in its
 * toolbar (Overleaf's own toggle-switch markup and CSS), our controls in
 * its toolbar's right (its own buttons), our page in place of its viewer
 * (hidden, not removed). Checked again and again: React may render the
 * toolbar anew, the pane may open or close. Without the pane or its
 * toolbar (layout changed upstream, PDF closed), the panel floats: the
 * fallback.
 */
function dockInOverleaf(panel: Panel): { toggle(): boolean; tour(): void } {
  const PANE = ".pdf.full-size, .ide-redesign-pdf-container .pdf, .pdf";
  /** Without Overleaf's PDF pane this long after load, the preview floats (the fallback). */
  const FALLBACK_AFTER_MS = 8000;
  /** The full controls' width (⌃ ⌄, page, − +, zoom), and some air. */
  const FULL_CONTROLS_PX = 260;
  const started = performance.now();
  const style = document.createElement("style");
  style.textContent = DOCK_CSS;
  document.head.append(style);
  let mode: "pdf" | "phitex" = "pdf";
  /** The tip shows on every load (on Overleaf's PDF) until "Don't show again". */
  let tipOff = true;
  chrome.storage.local.get(["view", "tipOff"]).then(({ view, tipOff: off }) => {
    if (view === "phitex" || view === "pdf") mode = view;
    tipOff = !!off;
    tick();
    if (!tipOff) setTimeout(tip, 1500);
  });
  const set = (m: "pdf" | "phitex") => {
    mode = m;
    void chrome.storage.local.set({ view: m });
    if (m === "phitex") hideTip();
    tick();
  };

  function switchEl(left: Element): HTMLElement {
    let sw = document.getElementById("phitex-switch");
    if (sw && left.contains(sw)) return sw;
    sw?.remove();
    sw = document.createElement("div");
    sw.id = "phitex-switch";
    sw.className = "editor-toggle-switch";
    sw.setAttribute("aria-label", "Preview: Overleaf's PDF or PhiTeX's");
    sw.innerHTML = `<form><fieldset class="toggle-switch"><legend class="visually-hidden">Preview</legend>
      <input type="radio" name="phitex-view" id="phitex-v-pdf" class="toggle-switch-input" value="pdf">
      <label for="phitex-v-pdf" class="toggle-switch-label" title="Overleaf's compiled PDF"><span>PDF</span></label>
      <input type="radio" name="phitex-view" id="phitex-v-phitex" class="toggle-switch-input" value="phitex">
      <label for="phitex-v-phitex" class="toggle-switch-label" title="⚡ Instant: added by the PhiTeX extension, not part of Overleaf (experimental) · Alt+Shift+P"><span>⚡ Instant</span></label>
    </fieldset></form>`;
    sw.addEventListener("change", (e) => set((e.target as HTMLInputElement).value as "pdf" | "phitex"));
    left.append(sw);
    return sw;
  }

  /** Overleaf's viewer controls, markup for markup (so they look and theme the same), driving ours. */
  function controlsEl(right: Element): HTMLElement {
    let c = document.getElementById("phitex-controls");
    if (c && right.contains(c)) return c;
    c?.remove();
    c = document.createElement("div");
    c.id = "phitex-controls";
    c.className = "pdfjs-viewer-controls phitex-keep";
    const gbtn = (id: string, icon: string, label: string) =>
      `<button type="button" id="${id}" aria-label="${label}" title="${label}" class="d-inline-grid pdf-toolbar-btn pdfjs-toolbar-button btn btn-ghost">` +
      `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">${icon}</span></span></button>`;
    c.innerHTML =
      `<div role="group" class="pdfjs-toolbar-buttons btn-group">${gbtn("phitex-prev", "keyboard_arrow_up", "Previous page")}${gbtn("phitex-next", "keyboard_arrow_down", "Next page")}</div>` +
      `<div class="pdfjs-page-number-input"><form id="phitex-pform"><input id="phitex-page" aria-label="Page" inputmode="numeric" value="1"></form><span id="phitex-pages">/ 1</span></div>` +
      `<div class="pdfjs-zoom-controls"><div role="group" class="pdfjs-toolbar-buttons btn-group">${gbtn("phitex-zout", "remove", "Zoom out")}${gbtn("phitex-zin", "add", "Zoom in")}</div>` +
      `<div class="dropdown"><button type="button" id="phitex-zoom" aria-expanded="false" aria-label="PhiTeX zoom level" class="pdf-toolbar-btn pdfjs-zoom-dropdown-button small dropdown-toggle btn btn-link">100%</button>` +
      `<ul class="dropdown-menu dropdown-menu-end" id="phitex-zoom-menu" role="menu">` +
      ZOOMS.map(([v, l]) => `<li><button type="button" class="dropdown-item" data-zoom="${v}">${l}</button></li>`).join("") +
      `<li><hr class="dropdown-divider"></li><li><button type="button" class="dropdown-item" data-act="more">PhiTeX settings and timings…</button></li></ul></div></div>` +
      // (compact, as Overleaf's own narrow layout: page and zoom steps behind ⋯)
      `<div class="dropdown phitex-compact-only"><button type="button" id="phitex-more" aria-label="More" class="d-inline-grid pdf-toolbar-btn pdfjs-toolbar-popover-button btn btn-ghost">` +
      `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">more_horiz</span></span></button>` +
      `<ul class="dropdown-menu dropdown-menu-end" id="phitex-more-menu" role="menu">` +
      `<li><button type="button" class="dropdown-item" data-act="prev">Previous page</button></li><li><button type="button" class="dropdown-item" data-act="next">Next page</button></li>` +
      `<li><hr class="dropdown-divider"></li><li><button type="button" class="dropdown-item" data-act="zin">Zoom in</button></li><li><button type="button" class="dropdown-item" data-act="zout">Zoom out</button></li>` +
      `<li><hr class="dropdown-divider"></li><li><button type="button" class="dropdown-item" data-act="more">PhiTeX settings and timings…</button></li></ul></div>`;
    const q = (id: string) => c!.querySelector<HTMLElement>(`#${id}`)!;
    q("phitex-prev").onclick = () => panel.prev();
    q("phitex-next").onclick = () => panel.next();
    q("phitex-zout").onclick = () => panel.zoomStep(-1);
    q("phitex-zin").onclick = () => panel.zoomStep(1);
    q("phitex-pform").onsubmit = (e) => {
      e.preventDefault();
      const k = Number((q("phitex-page") as HTMLInputElement).value);
      if (k >= 1) panel.goPage(k - 1);
    };
    const menus: HTMLElement[] = [];
    const dropdown = (button: HTMLElement, menu: HTMLElement) => {
      menus.push(menu);
      button.onclick = (e) => {
        e.stopPropagation();
        const open = !menu.classList.contains("show");
        for (const m of menus) m.classList.remove("show");
        menu.classList.toggle("show", open);
        button.setAttribute("aria-expanded", String(open));
        Object.assign(menu.style, open ? { position: "absolute", inset: "100% 0 auto auto" } : {});
      };
      menu.onclick = (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>("[data-zoom], [data-act]");
        const act = b?.dataset.act;
        if (b?.dataset.zoom) panel.zoomTo(b.dataset.zoom);
        if (act === "more") panel.sheet(true);
        if (act === "prev") panel.prev();
        if (act === "next") panel.next();
        if (act === "zin") panel.zoomStep(1);
        if (act === "zout") panel.zoomStep(-1);
        menu.classList.remove("show");
      };
    };
    dropdown(q("phitex-zoom"), q("phitex-zoom-menu"));
    dropdown(q("phitex-more"), q("phitex-more-menu"));
    document.addEventListener("click", () => menus.forEach((m) => m.classList.remove("show")));
    const native = right.querySelector("#toolbar-pdf-controls");
    if (native) native.after(c);
    else right.append(c);
    return c;
  }

  const compiledLink = () => document.querySelector<HTMLAnchorElement>('.toolbar-pdf-left a[aria-label="Download PDF"][href]');

  /** The first Instant download says what it is, once: Overleaf's popover, under the button. */
  function explainOnce(anchor: Element): void {
    chrome.storage.local.get("dlExplained").then(({ dlExplained }) => {
      if (dlExplained) return;
      void chrome.storage.local.set({ dlExplained: true });
      const b = anchor.querySelector("#phitex-dlgroup")!.getBoundingClientRect();
      const t = document.createElement("div");
      t.className = "popover bs-popover-bottom show phitex-toast";
      t.setAttribute("role", "status");
      t.innerHTML = `<div class="popover-body">This is the <b>⚡ Instant</b> preview's PDF (PhiTeX, experimental), named <code>…-instant.pdf</code>.
        Overleaf's compiled PDF is in the <b>▾</b> menu, or on the PDF tab.</div>`;
      Object.assign(t.style, { position: "fixed", left: `${Math.max(8, b.left - 20)}px`, top: `${b.bottom + 8}px`, maxWidth: "280px", zIndex: "1060" });
      document.body.append(t);
      setTimeout(() => t.remove(), 7000);
      t.onclick = () => t.remove();
    });
  }

  /** In Overleaf's left toolbar, where its logs and download are: ours (PhiTeX's diagnostics and PDF). */
  function leftEl(left: Element): HTMLElement {
    let l = document.getElementById("phitex-left");
    if (l && left.contains(l)) return l;
    l?.remove();
    l = document.createElement("div");
    l.id = "phitex-left";
    l.innerHTML =
      `<button type="button" id="phitex-logs" aria-label="PhiTeX diagnostics" title="PhiTeX diagnostics" class="d-inline-grid pdf-toolbar-btn toolbar-item log-btn btn btn-link" style="position: relative;">` +
      `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">description</span></span>` +
      `<span class="phitex-badge" id="phitex-badge"></span></button>` +
      // (download what you see: this tab's PDF; the other one in the ▾ menu)
      `<div class="dropdown btn-group" id="phitex-dlgroup">` +
      `<button type="button" id="phitex-dl" aria-label="Download the Instant PDF" title="Download the ⚡ Instant PDF (PhiTeX, experimental)" class="d-inline-grid pdf-toolbar-btn toolbar-item btn btn-link">` +
      `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">download</span></span></button>` +
      `<button type="button" id="phitex-dlmore" aria-label="Which PDF to download" title="Which PDF to download" aria-expanded="false" class="d-inline-grid pdf-toolbar-btn toolbar-item btn btn-link phitex-caret">` +
      `<span class="material-symbols" aria-hidden="true" translate="no">expand_more</span></button>` +
      `<ul class="dropdown-menu" id="phitex-dlmenu" role="menu">` +
      `<li><button type="button" class="dropdown-item" data-dl="instant">⚡ Instant PDF <span class="text-muted small">PhiTeX, experimental</span></button></li>` +
      `<li><button type="button" class="dropdown-item" data-dl="compiled">Compiled PDF <span class="text-muted small">Overleaf</span></button></li></ul></div>`;
    l.querySelector<HTMLElement>("#phitex-logs")!.onclick = () => panel.diagnostics();
    const menu = l.querySelector<HTMLElement>("#phitex-dlmenu")!,
      more = l.querySelector<HTMLElement>("#phitex-dlmore")!;
    const instant = () => {
      panel.pdf();
      explainOnce(l!);
    };
    l.querySelector<HTMLElement>("#phitex-dl")!.onclick = instant;
    more.onclick = (e) => {
      e.stopPropagation();
      // (Overleaf's compiled PDF: its own download link, there once it has compiled)
      const native = compiledLink();
      const item = menu.querySelector<HTMLButtonElement>('[data-dl="compiled"]')!;
      item.disabled = !native;
      item.title = native ? "The PDF of Overleaf's last compile" : "Recompile first: Overleaf has no PDF yet";
      const open = !menu.classList.contains("show");
      menu.classList.toggle("show", open);
      more.setAttribute("aria-expanded", String(open));
      Object.assign(menu.style, open ? { position: "absolute", inset: "100% auto auto 0" } : {});
    };
    menu.onclick = (e) => {
      const which = (e.target as HTMLElement).closest<HTMLElement>("[data-dl]")?.dataset.dl;
      menu.classList.remove("show");
      if (which === "instant") instant();
      if (which === "compiled") compiledLink()?.click();
    };
    document.addEventListener("click", () => menu.classList.remove("show"));
    const group = left.querySelector(".compile-button-group");
    if (group) group.after(l);
    else left.prepend(l);
    return l;
  }

  panel.onState((s) => {
    const c = document.getElementById("phitex-controls");
    if (c) {
      const input = c.querySelector<HTMLInputElement>("#phitex-page")!;
      if (document.activeElement !== input) input.value = s.pages ? String(s.page + 1) : "0";
      input.setAttribute("aria-label", `Page ${s.page + 1}, Current Page`);
      c.querySelector("#phitex-pages")!.textContent = `/ ${s.pages}`;
      (c.querySelector("#phitex-prev") as HTMLButtonElement).disabled = s.page <= 0;
      (c.querySelector("#phitex-next") as HTMLButtonElement).disabled = s.page >= s.pages - 1;
      c.querySelector("#phitex-zoom")!.textContent = `${s.percent}%`;
    }
    const b = document.getElementById("phitex-badge");
    if (b) {
      b.textContent = s.diagCount ? String(s.diagCount) : "";
      b.className = `phitex-badge ${s.diagWorst}`;
      document.getElementById("phitex-logs")!.title = `PhiTeX diagnostics${s.diagCount ? ` (${s.diagCount})` : ""} · ${s.chip}`;
    }
  });

  /** The first-run tip: Overleaf's own popover, pointing at the switch. */
  function tip(): void {
    const sw = document.getElementById("phitex-switch");
    if (tipOff || mode !== "pdf" || !sw || document.getElementById("phitex-tip")) return;
    const label = sw.querySelector('label[for="phitex-v-phitex"]') as HTMLElement;
    label.classList.add("phitex-pulse");
    const t = document.createElement("div");
    t.id = "phitex-tip";
    t.className = "popover bs-popover-bottom show";
    t.setAttribute("role", "dialog");
    t.setAttribute("aria-label", "Try the PhiTeX preview");
    t.innerHTML = `<div class="phitex-tip-clip">
      <div class="popover-header"><span class="phitex-bolt" aria-hidden="true">⚡</span> New from the PhiTeX extension</div>
      <div class="popover-body">No more Recompile: PhiTeX repaints this page <b>as you type</b>, incrementally, in milliseconds, right in your browser. Nothing leaves it.
        <div class="phitex-demo" aria-hidden="true"><code>Hello TeX</code><span class="phitex-arrow">⚡→</span><span class="phitex-mini">Hello TeX</span></div>
        <div class="small text-muted" style="margin-top:6px">A browser extension, not an Overleaf feature. Experimental: plain TeX only. Overleaf's PDF is one click away.</div>
        <div class="phitex-tip-actions"><button type="button" class="btn btn-link btn-sm" id="phitex-tip-never">Don't show again</button>
        <button type="button" class="btn btn-secondary btn-sm" id="phitex-tip-no">Not now</button>
        <button type="button" class="btn btn-primary btn-sm" id="phitex-tip-yes">⚡ Try it</button></div></div></div>`;
    document.body.append(t);
    const place = () => {
      const r = label.getBoundingClientRect();
      const w = t.offsetWidth;
      const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
      t.style.left = `${left}px`;
      t.style.top = `${r.bottom + 10}px`;
      t.style.setProperty("--arrow", `${r.left + r.width / 2 - left}px`);
    };
    place();
    addEventListener("resize", place);
    t.querySelector<HTMLElement>("#phitex-tip-yes")!.onclick = () => {
      set("phitex");
      chrome.storage.local.get("toured").then(({ toured }) => !toured && setTimeout(() => tour(0), 700));
    };
    t.querySelector<HTMLElement>("#phitex-tip-no")!.onclick = hideTip;
    t.querySelector<HTMLElement>("#phitex-tip-never")!.onclick = () => {
      tipOff = true;
      void chrome.storage.local.set({ tipOff: true });
      hideTip();
    };
  }

  /** Until the next load. */
  function hideTip(): void {
    document.getElementById("phitex-tip")?.remove();
    document.querySelector(".phitex-pulse")?.classList.remove("phitex-pulse");
  }

  /** The walkthrough: Overleaf's popover, a step at a time, the thing it explains ringed. */
  const STEPS: { at: () => Element | null; title: string; body: string; inside?: boolean }[] = [
    { at: () => document.getElementById("phitex-switch"), title: "Two previews, one click", body: "<b>PDF</b> is Overleaf's compiler, as always. <b>⚡ Instant</b> is added by the PhiTeX extension (not part of Overleaf), live. Switch any time, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>." },
    { at: () => document.querySelector("phitex-preview"), inside: true, title: "Type, and watch", body: "Edit anything in the editor: this page repaints as you type, usually in a few milliseconds. The <b>⚡ chip</b> in the corner shows how fast. No Recompile." },
    { at: () => document.getElementById("phitex-logs"), title: "What PhiTeX couldn't read", body: "Diagnostics, with a count. Click one to jump to its line. PhiTeX handles plain TeX: LaTeX commands are listed here, not typeset (yet)." },
    { at: () => document.getElementById("phitex-dlgroup"), title: "Download what you see", body: "This downloads the <b>⚡ Instant</b> PDF (<code>…-instant.pdf</code>). The <b>▾</b> menu has Overleaf's compiled PDF too." },
    { at: () => document.getElementById("phitex-zoom"), title: "Zoom, and the details", body: "Zoom like Overleaf's viewer. At the bottom of this menu: settings and timings (main file, a debug check against a fresh build). Everything runs in your browser; nothing leaves it." },
  ];

  function tour(k = 0): void {
    endTour();
    if (mode !== "phitex") set("phitex");
    const step = STEPS[k];
    const target = step?.at();
    if (!step || !target) return endTour(true);
    target.classList.add("phitex-ring");
    const t = document.createElement("div");
    t.id = "phitex-tour";
    t.className = "popover bs-popover-bottom show";
    t.setAttribute("role", "dialog");
    t.setAttribute("aria-label", `Tour, step ${k + 1} of ${STEPS.length}`);
    t.innerHTML = `<div class="phitex-tip-clip"><div class="popover-header"><span>${step.title}</span><span class="phitex-step">${k + 1} of ${STEPS.length}</span></div>
      <div class="popover-body">${step.body}
        <div class="phitex-dots">${STEPS.map((_, i) => `<span class="${i === k ? "on" : ""}"></span>`).join("")}</div>
        <div class="phitex-tip-actions"><button type="button" class="btn btn-link btn-sm" data-t="skip">Skip</button>
          ${k ? `<button type="button" class="btn btn-secondary btn-sm" data-t="back">Back</button>` : ""}
          <button type="button" class="btn btn-primary btn-sm" data-t="next">${k === STEPS.length - 1 ? "Done" : "Next"}</button></div></div></div>`;
    document.body.append(t);
    const r = target.getBoundingClientRect(), w = t.offsetWidth;
    const left = Math.max(8, Math.min((step.inside ? r.left + r.width / 2 : r.left + r.width / 2) - w / 2, innerWidth - w - 8));
    t.style.left = `${left}px`;
    t.style.top = `${step.inside ? r.top + 24 : r.bottom + 10}px`;
    t.style.setProperty("--arrow", step.inside ? "-100px" : `${r.left + r.width / 2 - left}px`);
    t.onclick = (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-t]")?.dataset.t;
      if (a === "next") tour(k + 1);
      if (a === "back") tour(k - 1);
      if (a === "skip") endTour(true);
    };
    t.querySelector<HTMLElement>('[data-t="next"]')!.focus();
  }

  function endTour(done = false): void {
    document.getElementById("phitex-tour")?.remove();
    document.querySelectorAll(".phitex-ring").forEach((e) => e.classList.remove("phitex-ring"));
    if (done) void chrome.storage.local.set({ toured: true });
  }
  addEventListener("keydown", (e) => e.key === "Escape" && document.getElementById("phitex-tour") && endTour(true));

  function tick(): void {
    const pane = document.querySelector<HTMLElement>(PANE);
    const left = pane?.querySelector(".toolbar-pdf-left");
    const right = pane?.querySelector(".toolbar-pdf-right");
    if (!pane || !left || !right) {
      // (Overleaf renders its layout late: wait for it before falling back to the window)
      if (performance.now() - started < FALLBACK_AFTER_MS) return;
      panel.dock(null);
      panel.shown(true);
      document.getElementById("phitex-tip")?.remove();
      return;
    }
    const sw = switchEl(left);
    leftEl(left);
    // (compact when the full controls do not fit what the toolbar has left: measured here,
    // not taken from Overleaf's own choice, which counts our switch against its room)
    const ctl = controlsEl(right);
    if (mode === "phitex") {
      const bar = pane.querySelector<HTMLElement>(".toolbar-pdf") ?? pane;
      const used = left.getBoundingClientRect().width + (right.querySelector(".theme-toggle-btn")?.getBoundingClientRect().width ?? 0);
      ctl.classList.toggle("compact", bar.clientWidth - used < FULL_CONTROLS_PX);
    }
    (sw.querySelector(`input[value="${mode}"]`) as HTMLInputElement).checked = true;
    panel.dock(pane, pane.querySelector(".toolbar-pdf"));
    pane.classList.toggle("phitex-on", mode === "phitex");
    panel.shown(mode === "phitex");
  }
  setInterval(tick, 700);
  return {
    tour: () => tour(0),
    toggle: () => {
      if (!document.getElementById("phitex-switch")) return false;
      set(mode === "pdf" ? "phitex" : "pdf");
      return true;
    },
  };
}

(async () => {
  let session: PreviewSession;
  let dock: { toggle(): boolean; tour(): void } | undefined;
  const panel = new Panel({
    onPage: (p) => session.setPage(p),
    onPdf: async () => {
      const pdf = await session.pdf();
      if (!pdf) return;
      const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(session.main ?? "phitex").replace(/\.tex$/, "").replace(/.*\//, "")}-instant.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
    onDebug: (on) => (session.debug = on),
    onMain: (m) => session.setMain(m),
    onFormat: (f) => session?.setFormat(f),
    // (the hook moves the editor's cursor there: the one thing it writes)
    onGoto: (file, line) => window.postMessage({ src: "phitex-content", type: "goto", file, line }, location.origin),
    onReload: async () => session.refresh(await fetchDocs(panel)),
    onShortcut: () => dock?.toggle() ?? false,
    onTour: () => dock?.tour(),
  }, prefs);
  dock = dockInOverleaf(panel);
  const transport = new ChromeTransport();
  try {
    await transport.connect();
    const { panel: saved } = await chrome.storage.local.get("panel");
    session = new PreviewSession(new OverleafHost(panel), transport, panel, { format: (saved as PanelPrefs | undefined)?.format ?? "vector" });
    (globalThis as any).__phitexSession = session; // (tests, devtools)
    await session.start();
    // (closed docs: fetched again and diffed in, so collaborators' edits to
    // them arrive as edits; the open one is live through the editor)
    setInterval(async () => {
      if (document.hidden) return;
      try {
        session.refresh(await fetchDocs(panel, (p) => p !== session.open));
      } catch {
        /* (offline: next time) */
      }
    }, FOLLOW_MS);
  } catch (e) {
    panel.error(String(e));
  }
})();

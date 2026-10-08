// Compare with a past version: the toolbar's Compare button (beside the
// download, Overleaf's own dropdown markup), its menu of versions (the
// labels, then the history, older on demand: history.ts), and the tip that
// shows it. The diff bar over the page, its state and keys, are
// common/src/compare.ts's DiffControls; what a diff is made of (the
// phitex-diff markup, typeset) is the runner's: `start` gets the version
// picked.

import type { Panel } from "./common/panel.ts";
import { DiffControls, type DiffRunner as Runner } from "./common/compare.ts";
import { type Version, versions } from "./history.ts";

export type DiffRunner = Runner<Version>;

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};

/** "Not now": the tip again this much later. */
const SNOOZE_MS = 3 * 24 * 3600 * 1000;
/** After the page settled: not over a load, a tour or the first tip. */
const TIP_DELAY_MS = 20_000;

const TIP_CSS = `
  #phitex-cmptip { position: fixed; z-index: 1060; width: 330px; max-width: calc(100vw - 16px); overflow: visible;
    border: 1.5px solid var(--green-40, #53b57f); border-radius: 12px;
    box-shadow: 0 0 0 4px rgb(83 181 127 / 18%), 0 18px 48px rgb(0 0 0 / 45%), 0 0 32px rgb(83 181 127 / 35%);
    animation: phitex-tip-in .6s cubic-bezier(.18,1.5,.4,1); }
  #phitex-cmptip::before { content: ""; position: absolute; top: -8px; left: var(--arrow, 50%); width: 14px; height: 14px; transform: translateX(-50%) rotate(45deg);
    background: var(--green-50, #098842); border-left: 1.5px solid var(--green-40, #53b57f); border-top: 1.5px solid var(--green-40, #53b57f); }
  #phitex-cmptip .phitex-tip-clip { position: relative; overflow: hidden; border-radius: 11px; }
  #phitex-cmptip .popover-header { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; color: #fff; border: 0;
    background: linear-gradient(135deg, var(--green-50, #098842), var(--green-60, #1e6b41)); padding: 10px 14px; }
  #phitex-cmptip .phitex-tip-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 10px; }
  #phitex-cmptip #phitex-cmptip-never { margin-right: auto; padding-left: 0; color: var(--content-placeholder-dark, #8d96a5); text-decoration: none; font-size: 12px; }
  #phitex-cmptip #phitex-cmptip-never:hover { color: var(--content-primary-dark, #f4f5f6); text-decoration: underline; }
  /* the demo: a page whose sentence changes, then the change marked as latexdiff marks it, then the navigator */
  #phitex-cmptip .popover-body code { color: var(--green-30, #86caa5); background: rgb(0 0 0 / 22%); padding: 0 4px; border-radius: 4px; }
  #phitex-cmptip .cmp-demo { position: relative; margin: 10px 0 4px; padding: 10px 12px 30px; border-radius: 8px; background: #fff; color: #1b222c;
    font: 13px/1.5 "Noto Serif", serif; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 8%); }
  #phitex-cmptip .cmp-demo .del { position: relative; color: #1b222c; animation: cmp-del 6s ease-in-out infinite; }
  #phitex-cmptip .cmp-demo .add { display: inline-block; max-width: 0; overflow: hidden; vertical-align: bottom; white-space: nowrap; color: #1d4ed8;
    text-decoration: underline wavy #1d4ed8; text-underline-offset: 3px; animation: cmp-add 6s ease-in-out infinite; }
  #phitex-cmptip .cmp-demo .tag { position: absolute; right: 8px; bottom: 7px; font: 600 11px/1 system-ui, sans-serif; color: #fff; background: rgb(27 34 44 / 88%);
    border-radius: 9px; padding: 3px 8px; opacity: 0; animation: cmp-tag 6s ease-in-out infinite; }
  #phitex-cmptip .cmp-demo .ver { position: absolute; left: 12px; right: 76px; bottom: 9px; height: 12px; font: 11px/12px system-ui, sans-serif; color: #6b7280; }
  #phitex-cmptip .cmp-demo .ver i { font-style: normal; position: absolute; left: 0; white-space: nowrap; }
  #phitex-cmptip .cmp-demo .ver .v0 { animation: cmp-v0 6s steps(1) infinite; }
  #phitex-cmptip .cmp-demo .ver .v1 { opacity: 0; animation: cmp-v1 6s steps(1) infinite; }
  @keyframes cmp-del { 0%, 30% { color: #1b222c; text-decoration: none; } 40%, 92% { color: #b91c1c; text-decoration: line-through 2px #b91c1c; } 100% { color: #1b222c; } }
  @keyframes cmp-add { 0%, 45% { max-width: 0; } 60%, 92% { max-width: 6em; } 100% { max-width: 0; } }
  @keyframes cmp-tag { 0%, 62% { opacity: 0; transform: translateY(6px); } 70%, 92% { opacity: 1; transform: none; } 100% { opacity: 0; } }
  @keyframes cmp-v0 { 0% { opacity: 1; } 31% { opacity: 0; } }
  @keyframes cmp-v1 { 0% { opacity: 0; } 31% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    #phitex-cmptip, #phitex-cmptip * { animation: none !important; }
    #phitex-cmptip .cmp-demo .del { color: #b91c1c; text-decoration: line-through 2px #b91c1c; }
    #phitex-cmptip .cmp-demo .add { max-width: 6em; } #phitex-cmptip .cmp-demo .tag { opacity: 1; }
    #phitex-cmptip .cmp-demo .ver .v0 { opacity: 0; } #phitex-cmptip .cmp-demo .ver .v1 { opacity: 1; }
  }`;

/**
 * The compare tip: Overleaf's popover (the first-run tip's look) pointing at
 * the Compare button, with a demo of a diff. Shown TIP_DELAY_MS after the
 * page settled, while Compare was never used; "Not now" brings it back
 * SNOOZE_MS later, "Don't show again" (or using Compare) never. Never over
 * another of ours (terms, tip, news, tour).
 */
function compareTip(btn: HTMLButtonElement): void {
  setTimeout(async () => {
    const st = (await chrome.storage.local.get(["cmpUsed", "cmpTipOff", "cmpTipNext"])) as { cmpUsed?: boolean; cmpTipOff?: boolean; cmpTipNext?: number };
    if (st.cmpUsed || st.cmpTipOff || (st.cmpTipNext ?? 0) > Date.now()) return;
    const busy = ["phitex-consent", "phitex-tip", "phitex-news", "phitex-tour", "phitex-cmptip"].some((id) => document.getElementById(id));
    // (the button not shown: Overleaf's PDF in view, or a layout without the toolbar; or something else of ours up: later)
    if (busy || !btn.isConnected || !btn.offsetParent) return void compareTip(btn);
    if (!document.getElementById("phitex-cmptip-css")) {
      const css = document.createElement("style");
      css.id = "phitex-cmptip-css";
      css.textContent = TIP_CSS;
      document.head.append(css);
    }
    const t = document.createElement("div");
    t.id = "phitex-cmptip";
    t.className = "popover bs-popover-bottom show";
    t.setAttribute("role", "dialog");
    t.setAttribute("aria-label", "Compare with a past version");
    t.innerHTML = `<div class="phitex-tip-clip">
      <div class="popover-header"><span aria-hidden="true">⇄</span> New: see what changed</div>
      <div class="popover-body">Compare this document with <b>any past version</b>: changes marked in the page, as <code>latexdiff</code> marks them, updated <b>as you type</b>.
        <div class="cmp-demo" aria-hidden="true">The results are <span class="del">good</span><span class="add">&nbsp;excellent</span>.<span class="ver"><i class="v0">Submitted v1</i><i class="v1">Now vs Submitted v1</i></span><span class="tag">‹ 1 / 1 ›</span></div>
        <div class="small text-muted" style="margin-top:6px">Pick a label or any point in the history. Download the diff PDF for your reviewers.</div>
        <div class="phitex-tip-actions"><button type="button" class="btn btn-link btn-sm" id="phitex-cmptip-never">Don't show again</button>
        <button type="button" class="btn btn-secondary btn-sm" id="phitex-cmptip-no">Not now</button>
        <button type="button" class="btn btn-primary btn-sm" id="phitex-cmptip-yes">⇄ Try it</button></div></div></div>`;
    document.body.append(t);
    btn.classList.add("phitex-pulse");
    const place = () => {
      const r = btn.getBoundingClientRect();
      const w = t.offsetWidth;
      const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
      t.style.left = `${left}px`;
      t.style.top = `${r.bottom + 10}px`;
      t.style.setProperty("--arrow", `${r.left + r.width / 2 - left}px`);
    };
    place();
    addEventListener("resize", place);
    const hide = () => {
      removeEventListener("resize", place);
      t.remove();
      btn.classList.remove("phitex-pulse");
    };
    t.querySelector<HTMLElement>("#phitex-cmptip-yes")!.onclick = (e) => {
      e.stopPropagation();
      hide();
      btn.click();
    };
    t.querySelector<HTMLElement>("#phitex-cmptip-no")!.onclick = () => {
      hide();
      void chrome.storage.local.set({ cmpTipNext: Date.now() + SNOOZE_MS });
    };
    t.querySelector<HTMLElement>("#phitex-cmptip-never")!.onclick = () => {
      hide();
      void chrome.storage.local.set({ cmpTipOff: true });
    };
  }, TIP_DELAY_MS);
}

export function compareButton(host: HTMLElement, panel: Panel, base: () => string, fetcher: typeof fetch, run: DiffRunner): void {
  if (host.querySelector("#phitex-cmp")) return;
  const g = document.createElement("div");
  g.className = "dropdown btn-group";
  g.innerHTML =
    `<button type="button" id="phitex-cmp" aria-label="Compare with a past version" title="Compare with a past version (latexdiff)" aria-expanded="false" class="d-inline-grid pdf-toolbar-btn toolbar-item btn btn-link">` +
    `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">difference</span></span></button>` +
    `<ul class="dropdown-menu" id="phitex-cmpmenu" role="menu" style="max-height: 60vh; overflow-y: auto; min-width: 300px;"></ul>`;
  host.append(g);
  const btn = g.querySelector<HTMLButtonElement>("#phitex-cmp")!,
    menu = g.querySelector<HTMLElement>("#phitex-cmpmenu")!;
  let list: Version[] = [];
  let more: number | undefined;

  const item = (v: Version) =>
    `<li><button type="button" class="dropdown-item" data-v="${v.v}" style="display:flex;flex-direction:column;align-items:flex-start;gap:0;white-space:normal">` +
    `<span>${v.label ? "🏷 " : ""}${esc(v.title)}</span><span class="text-muted small">${ago(v.at)}${v.who.length ? ` · ${esc(v.who.join(", "))}` : ""} · v${v.v}</span></button></li>`;
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const render = () => {
    const labels = list.filter((v) => v.label),
      ups = list.filter((v) => !v.label);
    menu.innerHTML =
      (controls.active ? `<li><button type="button" class="dropdown-item" data-stop="1">✕ Stop comparing</button></li><li><hr class="dropdown-divider"></li>` : "") +
      `<li><h6 class="dropdown-header">Compare the current version with…</h6></li>` +
      (labels.length ? `<li><h6 class="dropdown-header">Labels</h6></li>${labels.map(item).join("")}` : "") +
      `<li><h6 class="dropdown-header">History</h6></li>${ups.map(item).join("") || `<li><span class="dropdown-item-text text-muted small">No history yet</span></li>`}` +
      (more ? `<li><button type="button" class="dropdown-item text-muted" data-more="1">Older versions…</button></li>` : "");
  };
  const load = async (before?: number) => {
    const r = await versions(base(), fetcher, 30, before);
    list = before ? [...list, ...r.versions.filter((v) => !v.label)] : r.versions;
    more = r.more;
    render();
  };
  const close = () => {
    menu.classList.remove("show");
    btn.setAttribute("aria-expanded", "false");
  };

  btn.onclick = async (e) => {
    e.stopPropagation();
    const open = !menu.classList.contains("show");
    if (!open) return close();
    menu.innerHTML = `<li><span class="dropdown-item-text text-muted small">Reading the project's history…</span></li>`;
    Object.assign(menu.style, { position: "absolute", inset: "100% auto auto 0" });
    menu.classList.add("show");
    btn.setAttribute("aria-expanded", "true");
    await load().catch((err) => (menu.innerHTML = `<li><span class="dropdown-item-text text-danger small">Couldn't read the history: ${esc(String(err.message ?? err))}</span></li>`));
  };
  menu.onclick = async (e) => {
    e.stopPropagation();
    const t = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!t) return;
    if (t.dataset.more) return void load(more).catch(() => undefined);
    close();
    if (t.dataset.stop) return stop();
    const v = list.find((x) => String(x.v) === t.dataset.v);
    if (v) void start(v);
  };
  document.addEventListener("click", close);
  compareTip(btn);

  const controls = new DiffControls(panel, run);
  const start = async (v: Version) => {
    // (used: the tip never again)
    void chrome.storage.local.set({ cmpUsed: true });
    document.getElementById("phitex-cmptip")?.remove();
    await controls.start(v, v.title, `${ago(v.at)} · v${v.v}`);
  };
  const stop = () => controls.stop();
  // (keys while comparing: not in the editor or a field)
  addEventListener("keydown", (e) => controls.key(e));
}

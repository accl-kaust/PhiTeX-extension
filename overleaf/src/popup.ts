// The toolbar popup: the extension's settings, in chrome.storage.local (the
// content script follows changes live), and actions on the open Overleaf tab.

import "./platform.ts";
import { type PackMeta, DEFAULT_CAP_MB, allMeta, capBytes, clearPacks, evict, kvGet, kvSet } from "./common/packstore.ts";
import { type Ahead, setAheadOff } from "./common/prefetch.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const TERMS = 1;

async function activeOverleafTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url && /^https:\/\/www\.overleaf\.com\/project\//.test(tab.url) ? tab : undefined;
}

function seg(id: string, value: string, onPick: (v: string) => void): void {
  const el = $(id);
  for (const b of el.querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.v === value));
    b.onclick = () => {
      for (const o of el.querySelectorAll("button")) o.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-pressed", "true");
      onPick(b.dataset.v!);
    };
  }
}

async function render(): Promise<void> {
  const s = await chrome.storage.local.get(["enabled", "view", "panel", "tipOff", "newsOff", "speedOff", "accepted", "engine", "engines", "follow"]);
  const accepted = s.accepted === TERMS;
  $<HTMLElement>("version").textContent = chrome.runtime.getManifest().version;
  const enabled = $<HTMLInputElement>("enabled");
  enabled.checked = s.enabled !== false;
  enabled.onchange = () => chrome.storage.local.set({ enabled: enabled.checked });
  seg("view", s.view === "phitex" ? "phitex" : "pdf", (v) => {
    void chrome.storage.local.set({ view: v });
    $("viewnote").textContent = v === "phitex" && !accepted ? "⚡ Instant asks you to accept its terms first, in Overleaf." : "";
  });
  seg("follow", (s.follow as string | undefined) ?? "cursor", (v) => void chrome.storage.local.set({ follow: v }));
  seg("engine", (s.engine as string | undefined) ?? "auto", (v) => void chrome.storage.local.set({ engine: v }));
  // (projects given their own engine, from the card's buttons: they keep it; cleared here)
  const own = Object.keys((s.engines as Record<string, string> | undefined) ?? {}).length;
  const note = $("enginenote");
  note.textContent = own ? `${own} project${own === 1 ? " has" : "s have"} its own engine. ` : "";
  if (own) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = "Use this setting for all";
    b.onclick = async () => {
      await chrome.storage.local.remove("engines");
      void render();
    };
    note.append(b);
  }
  const panelPrefs = (s.panel ?? {}) as { format?: string };
  seg("format", panelPrefs.format === "pdfjs" ? "pdfjs" : "vector", (v) => chrome.storage.local.set({ panel: { ...panelPrefs, format: v } }));
  const tips = $<HTMLInputElement>("tips");
  tips.checked = !s.tipOff;
  tips.onchange = () => chrome.storage.local.set({ tipOff: !tips.checked });
  const speed = $<HTMLInputElement>("speed");
  speed.checked = !s.speedOff;
  speed.onchange = () => chrome.storage.local.set({ speedOff: !speed.checked });
  void cacheStats();
  const news = $<HTMLInputElement>("news");
  news.checked = !s.newsOff;
  news.onchange = () => chrome.storage.local.set({ newsOff: !news.checked });
  $("terms").textContent = accepted
    ? "Accepted: unofficial, experimental, as is, no warranty, at your own risk."
    : "Not accepted yet: ⚡ Instant asks before its first use.";
  $("terms").className = `terms${accepted ? "" : " warn"}`;
  const withdraw = $<HTMLButtonElement>("withdraw");
  withdraw.disabled = !accepted;
  withdraw.onclick = async () => {
    await chrome.storage.local.set({ accepted: 0, view: "pdf" });
    void render();
  };
  const tab = await activeOverleafTab();
  for (const id of ["whatsnew", "tour"]) {
    const b = $<HTMLButtonElement>(id);
    b.disabled = !tab || !enabled.checked;
    b.onclick = async () => {
      if (!tab?.id) return;
      await chrome.tabs.sendMessage(tab.id, { type: id === "tour" ? "phitex-tour" : "phitex-news" });
      window.close();
    };
  }
  $("tabnote").textContent = tab ? "" : "Open an Overleaf project to see these.";
  // (two clicks: the second, within 4 s, confirms)
  const reset = $<HTMLButtonElement>("reset");
  let armed: ReturnType<typeof setTimeout> | null = null;
  reset.onclick = async () => {
    if (!armed) {
      reset.textContent = "Click again to reset";
      reset.classList.add("confirm");
      armed = setTimeout(() => {
        armed = null;
        reset.textContent = "Reset extension";
        reset.classList.remove("confirm");
      }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    await resetAll();
    reset.textContent = "Reset ✓";
    reset.classList.remove("confirm");
    void render();
  };
}

/** The packs kept in this browser (packstore.ts): how many, how big, the cap, the ones fetched ahead (prefetch.ts), and a clear. */
async function cacheStats(): Promise<void> {
  const out = $("cachestats"), btn = $<HTMLButtonElement>("cacheclear"), aheadNote = $("aheadnote");
  const all = await allMeta().catch(() => new Map<string, PackMeta>());
  let bytes = 0;
  for (const m of all.values()) bytes += m.bytes;
  const mb = (b: number) => (b < 10 * 1048576 ? (b / 1048576).toFixed(1) : String(Math.round(b / 1048576)));
  const cap = await capBytes().catch(() => DEFAULT_CAP_MB * 1048576);
  out.textContent = all.size ? `${all.size} packs, ${mb(bytes)} of ${mb(cap)} MB · fetched once, reused offline` : "Empty: packages are fetched as documents need them";
  seg("cachecap", String(Math.round(cap / 1048576)), (v) => void kvSet("capMB", +v).then(() => evict()).then(cacheStats));
  const sw = $<HTMLInputElement>("ahead");
  sw.checked = !(await kvGet<boolean>("aheadOff").catch(() => false));
  sw.onchange = async () => {
    await setAheadOff(!sw.checked);
    if (sw.checked) void chrome.runtime.sendMessage({ type: "prefetch" });
    void cacheStats();
  };
  const { ahead: a } = (await chrome.storage.local.get("ahead")) as { ahead?: Ahead };
  aheadNote.textContent = !sw.checked || !a?.total ? "" : a.state === "full" ? `${a.have} of ${a.total} fetched: the rest past the cap` : a.have >= a.total ? `All ${a.total} ready` : `${a.have} of ${a.total} ready${a.state === "running" ? ", fetching…" : ""}`;
  btn.disabled = !all.size;
  btn.onclick = async () => {
    btn.disabled = true;
    await clearPacks().catch(() => undefined);
    void cacheStats();
  };
}

/** As just installed: everything stored goes, and this version's notes count as seen (as an install's). */
export async function resetAll(): Promise<void> {
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ newsSeen: chrome.runtime.getManifest().version });
}

void render();

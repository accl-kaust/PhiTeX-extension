// The toolbar popup: the extension's settings, in chrome.storage.local (the
// content script follows changes live), and actions on the open Overleaf tab.

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
  seg("follow", (s.follow as string | undefined) ?? "select", (v) => void chrome.storage.local.set({ follow: v }));
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
  seg("format", panelPrefs.format === "png" ? "png" : "vector", (v) => chrome.storage.local.set({ panel: { ...panelPrefs, format: v } }));
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

/** The package cache (shelf.ts's IndexedDB, this extension's origin): files, bytes, and a clear. */
function cacheDb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    const o = indexedDB.open("phitex-shelf");
    // (none yet: nothing made here, shelf.ts makes it at its version)
    o.onupgradeneeded = () => {
      o.transaction!.abort();
      res(null);
    };
    o.onsuccess = () => res(o.result.objectStoreNames.contains("files") ? o.result : (o.result.close(), null));
    o.onerror = () => res(null);
  });
}

async function cacheStats(): Promise<void> {
  const out = $("cachestats"), btn = $<HTMLButtonElement>("cacheclear");
  const db = await cacheDb();
  let n = 0, bytes = 0;
  if (db) {
    await new Promise<void>((res) => {
      const c = db.transaction("files", "readonly").objectStore("files").openCursor();
      c.onsuccess = () => {
        const k = c.result;
        if (!k) return res();
        n++;
        const v = k.value as Uint8Array | string;
        bytes += typeof v === "string" ? v.length : v.byteLength;
        k.continue();
      };
      c.onerror = () => res();
    });
  }
  const mb = bytes / 1048576;
  out.textContent = n ? `${n} files, ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB · fetched once, reused offline` : "Empty: packages are fetched as documents need them";
  btn.disabled = !n;
  btn.onclick = async () => {
    if (!db) return;
    btn.disabled = true;
    await new Promise<void>((res) => {
      const t = db.transaction("files", "readwrite");
      t.objectStore("files").clear();
      t.oncomplete = t.onerror = () => res();
    });
    db.close();
    void cacheStats();
  };
}

/** As just installed: everything stored goes, and this version's notes count as seen (as an install's). */
export async function resetAll(): Promise<void> {
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ newsSeen: chrome.runtime.getManifest().version });
}

void render();

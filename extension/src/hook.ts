// Runs in the page's world (manifest "world": "MAIN"): finds Overleaf's
// CodeMirror 6 EditorView through the DOM, and posts each transaction's
// changes, and each file opened, to the content script. Reads only: it
// never changes the editor. No imports (a classic script).

(() => {
  const SRC = "phitex-hook";
  let view: any = null;
  let file: string | null = null;
  /** Changes made while the open file is not known yet (just switched). */
  let held: any[] = [];

  const post = (msg: object) => window.postMessage({ src: SRC, ...msg }, location.origin);

  /** The EditorView of `.cm-content`: `cmView.view` (CM ≤ 6.3x), or `cmTile.view`. */
  function findView(): any {
    for (const el of document.querySelectorAll(".cm-editor .cm-content")) {
      const v = (el as any).cmView?.view ?? (el as any).cmTile?.view ?? (el as any).cmView?.rootView?.view;
      if (v?.state?.doc && typeof v.update === "function") return v;
    }
    return null;
  }

  /** The open file's path: Overleaf's breadcrumbs, else the file tree. */
  function openFile(): string | null {
    const crumbs = document.querySelector(".ol-cm-breadcrumbs");
    if (crumbs) {
      const parts = [...crumbs.querySelectorAll("div, span")]
        .filter((e) => e.children.length === 0 || e.querySelector(".material-symbols") === null)
        .map((e) => e.textContent?.trim() ?? "")
        .filter((t) => t && !/^(chevron_right|description|folder_open)$/.test(t));
      const uniq = parts.filter((t, i) => parts.indexOf(t) === i);
      if (uniq.length) return uniq.join("/");
    }
    const sel = document.querySelector('.file-tree-list [role="treeitem"][aria-selected="true"], .file-tree [role="treeitem"][aria-selected="true"]');
    if (!sel) return null;
    const names: string[] = [];
    for (let li: Element | null = sel; li; li = li.parentElement?.closest('[role="treeitem"]') ?? null) {
      const n = li.getAttribute("aria-label") ?? li.querySelector(".item-name-button span, .item-name")?.textContent;
      if (n) names.unshift(n.trim());
    }
    return names.join("/") || null;
  }

  function changesOf(tr: any): number[][] | null {
    if (!tr.docChanged && !tr.changes?.length) return null;
    const out: any[] = [];
    // (fromA, toA: in the doc before; fromB: in the doc after, which is
    // where the change is once the ones before it are applied)
    tr.changes.iterChanges((fromA: number, toA: number, fromB: number, _toB: number, ins: any) =>
      out.push([fromB, fromB + (toA - fromA), ins.toString()]),
    );
    return out.length ? out : null;
  }

  function identify(): void {
    const name = openFile();
    if (!view) return;
    file = name;
    post({ type: "open", file: name, text: view.state.doc.toString() });
    if (held.length) post({ type: "changes", file: name, edits: held.flat() });
    held = [];
  }

  function hook(v: any): void {
    if (v.__phitex) return;
    v.__phitex = true;
    const update = v.update;
    v.update = function (trs: any[]) {
      const r = update.call(this, trs);
      const edits: any[] = [];
      for (const tr of trs) {
        const c = changesOf(tr);
        if (c) edits.push(...c);
      }
      if (edits.length) {
        if (file === null) held.push(edits);
        else post({ type: "changes", file, edits, t: performance.now() });
      }
      return r;
    };
    const setState = v.setState;
    v.setState = function (s: any) {
      const r = setState.call(this, s);
      // (a file switch: the DOM's name settles after the state)
      file = null;
      setTimeout(identify, 100);
      return r;
    };
    view = v;
    setTimeout(identify, 100);
  }

  // Overleaf builds the editor late and may build a new one: look again.
  setInterval(() => {
    const v = findView();
    if (v && v !== view) hook(v);
    else if (v && file !== null && openFile() !== file) identify();
  }, 500);

  /** Put the cursor at the start of `line` (1-based) and scroll to it. */
  function gotoLine(line: number): void {
    const doc = view.state.doc;
    const at = doc.line(Math.max(1, Math.min(line, doc.lines))).from;
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    view.focus();
  }

  /** Open `path` in the editor (its file tree item), then `then`. */
  function openThen(path: string, then: () => void): void {
    const name = path.split("/").at(-1)!;
    const items = [...document.querySelectorAll('.file-tree-list [role="treeitem"], .file-tree [role="treeitem"]')];
    const item = items.find((li) => li.getAttribute("aria-label") === name);
    const target = item?.querySelector<HTMLElement>(".entity, .item-name-button, .entity-name") ?? (item as HTMLElement | undefined);
    if (!target) return;
    target.click();
    let tries = 0;
    const wait = setInterval(() => {
      if (file === path || ++tries > 30) {
        clearInterval(wait);
        if (file === path) then();
      }
    }, 100);
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.src !== "phitex-content") return;
    const m = e.data;
    if (m.type === "hello") identify();
    else if (m.type === "goto" && view && typeof m.line === "number") {
      if (m.file === file) gotoLine(m.line);
      else openThen(m.file, () => gotoLine(m.line));
    }
  });
})();

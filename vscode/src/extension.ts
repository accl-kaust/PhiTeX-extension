// PhiTeX ⚡ Instant in VS Code: "PhiTeX: Open Preview" typesets the project
// the active .tex file is in, in the extension host (common/src/session.ts,
// its core in worker threads: core.ts), and draws it in a webview beside the
// editor (webview.ts: common/src/panel.ts, the sink calls sent on as
// remote.ts's `tee` sends them). The editor's changes go in as edits as they
// are typed (changes.ts); a double-click on a page opens its source there.

import * as vscode from "vscode";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setPlatform } from "../../common/src/platform.ts";
import { PreviewSession, type EditorHost, type PreviewSink } from "../../common/src/session.ts";
import { tee, type Told } from "../../common/src/remote.ts";
import { hostPackages } from "../../common/src/packages.ts";
import { resolve } from "../../common/src/engines.ts";
import type { Edit } from "../../common/src/edits.ts";
import { findMain, relPath, toEdits } from "./changes.ts";
import { HostTransport, startCore } from "./core.ts";
import { nodePlatform } from "./platform.ts";

/** The webview → extension host messages (overleaf/src/mirror.ts's Ask, less the channel's own). */
type Ask = { t: "hello" } | { t: "need"; k: number } | { t: "page"; k: number } | { t: "goto"; file: string; line: number } | { t: "range"; file: string; from: number; to: number } | { t: "sync"; k: number; x: number; y: number } | { t: "pdf" } | { t: "clean" } | { t: "main"; m: string };

/** The project's text files (what the core reads as source), and the binary ones it is given apart. */
const TEXT = /\.(tex|sty|cls|bib|bst|cfg|def|clo|fd|ltx|bbx|cbx|lbx|dtx|ins|txt|csv|dat|tikz|pgf|bbl)$/i;
const BINARY = /\.(png|jpe?g|pdf|eps|gif)$/i;
/** Folders never read (VCS, build output, dependencies). */
const SKIP = new Set([".git", "node_modules", ".vscode", "out", "build", ".phitex-diff"]);
/** The most files read from a folder (a project, not a home directory). */
const MAX_FILES = 4000;

async function walk(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) break;
    if (e.name.startsWith(".") && e.isDirectory()) continue;
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out);
    else if (TEXT.test(e.name) || BINARY.test(e.name)) out.push(p);
  }
  return out;
}

/** The project in `folder`: the open documents' text over what is on disk. */
class FolderHost implements EditorHost {
  readonly folder: string;
  binaries: Record<string, Uint8Array> = {};
  private active?: string;
  private subs: vscode.Disposable[] = [];

  constructor(folder: string, active?: string) {
    this.folder = folder;
    this.active = active;
  }

  rel(uri: vscode.Uri): string | null {
    return uri.scheme === "file" ? relPath(this.folder, uri.fsPath) : null;
  }

  async loadProject(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    this.binaries = {};
    for (const p of await walk(this.folder)) {
      const r = relPath(this.folder, p);
      if (!r) continue;
      if (BINARY.test(p)) this.binaries[r] = new Uint8Array(await readFile(p));
      else files[r] = await readFile(p, "utf8");
    }
    for (const d of vscode.workspace.textDocuments) {
      const r = this.rel(d.uri);
      if (r && TEXT.test(r)) files[r] = d.getText();
    }
    return files;
  }

  mainFile(files: Record<string, string>): string | null {
    return findMain(files, this.active);
  }

  onOpen(cb: (file: string, text: string) => void): void {
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        const r = e && this.rel(e.document.uri);
        if (r && TEXT.test(r)) cb(r, e.document.getText());
      }),
    );
  }

  onChanges(cb: (file: string, edits: Edit[]) => void): void {
    this.subs.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        const r = this.rel(e.document.uri);
        if (r && TEXT.test(r) && e.contentChanges.length) cb(r, toEdits(e.contentChanges));
      }),
    );
  }

  ready(): void {
    const e = vscode.window.activeTextEditor;
    const r = e && this.rel(e.document.uri);
    if (r) this.active = r;
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }
}

/** A sink whose every call does nothing: the panel is the webview's, the calls sent there by `tee`. */
function quietSink(over: Partial<PreviewSink>): PreviewSink {
  return new Proxy(over as PreviewSink, {
    get: (t, k) => (k in t ? t[k as keyof PreviewSink] : () => undefined),
    has: () => true,
  });
}

let core: ReturnType<typeof startCore> | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const root = ctx.extensionPath;
  const store = join(ctx.globalStorageUri.fsPath, "store");
  setPlatform(nodePlatform(root, store));
  const log = vscode.window.createOutputChannel("PhiTeX");
  ctx.subscriptions.push(log);
  ctx.subscriptions.push(vscode.commands.registerCommand("phitex.preview", () => preview(ctx, root, log)));
}

async function preview(ctx: vscode.ExtensionContext, root: string, log: vscode.OutputChannel): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  const folder = ed ? vscode.workspace.getWorkspaceFolder(ed.document.uri) : vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") {
    void vscode.window.showErrorMessage("PhiTeX: open a .tex file in a folder first.");
    return;
  }
  core ??= startCore(root, join(ctx.globalStorageUri.fsPath, "store"), (s) => log.appendLine(s));
  const host = new FolderHost(folder.uri.fsPath, ed ? (relPath(folder.uri.fsPath, ed.document.uri.fsPath) ?? undefined) : undefined);

  const view = vscode.window.createWebviewPanel("phitex.preview", "⚡ PhiTeX", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "dist"), vscode.Uri.joinPath(ctx.extensionUri, "fonts")],
  });
  const asset = (p: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, p)).toString();
  const nonce = Math.random().toString(36).slice(2);
  view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource} data: blob:; font-src ${view.webview.cspSource} data:; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;height:100vh"><script nonce="${nonce}">window.PHITEX_FONTS=${JSON.stringify(asset("fonts/"))};</script><script nonce="${nonce}" src="${asset("dist/webview.js")}"></script></body></html>`;

  // (the webview's panel told everything the session tells its sink, once it said hello)
  let live = false;
  const ch = { postMessage: (m: Told) => void view.webview.postMessage(m) };
  const goto = async (file: string, at: (d: vscode.TextDocument) => vscode.Range, focus = true) => {
    const d = await vscode.workspace.openTextDocument(vscode.Uri.file(join(host.folder, file)));
    const r = at(d);
    const e = await vscode.window.showTextDocument(d, { viewColumn: vscode.ViewColumn.One, preserveFocus: !focus, selection: r });
    e.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };
  const sink = tee(
    quietSink({
      goto: (file, from, to, focus) => void goto(file, (d) => new vscode.Range(d.positionAt(from), d.positionAt(to)), focus ?? false),
    }),
    ch,
    () => live,
  );
  const transport = new HostTransport(core.host);
  const session = new PreviewSession(host, transport, sink, {
    engine: (main) => resolve("auto", undefined, main),
    format: "vector",
    packages: hostPackages(transport as never),
  });

  view.webview.onDidReceiveMessage(async (a: Ask) => {
    if (a.t === "hello") {
      live = true;
      void session.resync();
    }
    if (a.t === "need") void session.fetch(a.k);
    if (a.t === "page") void session.setPage(a.k);
    if (a.t === "sync") void session.toSource(a.k, a.x, a.y);
    if (a.t === "goto") void goto(a.file, (d) => d.lineAt(Math.max(0, Math.min(a.line - 1, d.lineCount - 1))).range);
    if (a.t === "range") void goto(a.file, (d) => new vscode.Range(d.positionAt(a.from), d.positionAt(a.to)), false);
    if (a.t === "main") void session.setMain(a.m);
    if (a.t === "clean") session.clean(await host.loadProject());
    if (a.t === "pdf") {
      const pdf = await session.pdf();
      if (!pdf?.length) return void vscode.window.showWarningMessage("PhiTeX: no complete PDF yet (see the diagnostics).");
      const to = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(join(host.folder, (session.main ?? "main.tex").replace(/\.tex$/, "") + "-instant.pdf")) });
      if (to) await vscode.workspace.fs.writeFile(to, pdf);
    }
  });
  // (a double-click in the editor: that place on the page)
  const subs = [
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const r = host.rel(e.textEditor.document.uri);
      if (!r || e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
      void session.follow(r, e.textEditor.document.offsetAt(e.selections[0].active));
    }),
  ];
  view.onDidDispose(() => {
    subs.forEach((s) => s.dispose());
    host.dispose();
    transport.close();
  });

  try {
    // (the project read, its binary files given first: the first build has them)
    await host.loadProject();
    for (const [file, bytes] of Object.entries(host.binaries)) await transport.request({ op: "binary", file, bytes });
    await session.start();
  } catch (e) {
    log.appendLine(`start: ${e}`);
    void vscode.window.showErrorMessage(`PhiTeX: ${e}`);
  }
}

export function deactivate(): void {
  core?.host.stop();
  core?.stop();
  core = undefined;
}

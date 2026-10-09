// The preview in VS Code's webview: the panel (common/src/panel.ts), told
// what the extension host's session tells its sink (remote.ts's `apply`), and
// what the panel is asked (a page in view, a page wanted, a double-click, a
// download) sent back to it (extension.ts's Ask).

import { apply, type Told } from "../../common/src/vendor/viewer/remote.ts";
import { Panel, type PanelPrefs } from "../../common/src/vendor/viewer/panel.ts";
import { setFontBase } from "../../common/src/vendor/viewer/page2.ts";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
declare const PHITEX_FONTS: string;

const vscode = acquireVsCodeApi();
const ask = (m: unknown) => vscode.postMessage(m);
setFontBase(PHITEX_FONTS);

const panel = new Panel(
  {
    onPage: (k) => ask({ t: "page", k }),
    onNeed: (k) => ask({ t: "need", k }),
    onPdf: () => ask({ t: "pdf" }),
    onDebug: () => {},
    onMain: (m) => ask({ t: "main", m }),
    onReload: () => ask({ t: "clean" }),
    onClean: () => ask({ t: "clean" }),
    onFormat: () => {},
    onGoto: (file, line) => ask({ t: "goto", file, line }),
    onGotoRange: (file, from, to) => ask({ t: "range", file, from, to }),
    onSyncSource: (k, x, y) => ask({ t: "sync", k, x, y }),
    // (text selected on the pages: the editor selects its source)
    onSelectPage: (sel) => ask({ t: "select", sel }),
  },
  // (the panel's settings: kept in the webview's own state)
  {
    load: async () => ((vscode.getState() as { prefs?: Partial<PanelPrefs> } | undefined)?.prefs ?? {}),
    save: (prefs) => vscode.setState({ prefs }),
  },
  {
    pdfjs: false,
    header: true,
    // (VS Code's words: no Overleaf here, nothing to disclaim; the license a click away)
    words: {
      badge: "Instant",
      badgeTitle: "PhiTeX typesets the project as you type, in VS Code itself",
      byline: "⚡ PhiTeX",
      about: `<b>⚡ PhiTeX Instant</b>: an incremental TeX engine that typesets as you type, in VS Code itself; nothing
        leaves your machine but TeX Live's packages, fetched as needed.
        <div class="about-foot">Free software (AGPL-3.0-only, <a id="license" target="_blank" rel="noopener">full license</a>),
        provided as is, without any warranty.</div>`,
      realPdf: "",
      stopped: "Open ⓘ diagnostics for the details.",
      notReady: "This engine does not run here yet.",
      openFailed: "Close the preview and open it again to retry.",
      reading: "Reading the project's files from this folder.",
      keptIn: "this machine",
    },
  },
);
// (docked in a pane that fills the webview, as in Overleaf's PDF pane)
const pane = document.createElement("div");
pane.style.cssText = "position:fixed;inset:0";
document.body.append(pane);
panel.dock(pane);
panel.shown(true);

addEventListener("message", (e: MessageEvent<Told>) => apply(panel, e.data));
ask({ t: "hello" });

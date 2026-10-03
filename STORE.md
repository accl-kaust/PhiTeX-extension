# Chrome Web Store: listing kit

Everything the Developer Dashboard asks for, ready to paste. Build the
upload with `scripts/package.sh` (→ `store/phitex-instant-<version>.zip`).

## Store listing

**Name** (from the manifest): PhiTeX Instant for Overleaf (unofficial)

**Summary** (≤ 132 characters):
> Unofficial, experimental: an instant, incremental TeX preview beside Overleaf's PDF. Runs locally. Not affiliated with Overleaf.

**Description:**

> PhiTeX Instant adds an instant preview to Overleaf's PDF pane: switch
> between Overleaf's compiled PDF and ⚡ Instant, and the page repaints as
> you type, usually in a few milliseconds.
>
> It is powered by PhiTeX, an incremental TeX engine that keeps your
> document compiled as you edit it: a keystroke rebuilds only the part it
> touched. The engine runs entirely in your browser, as WebAssembly. Your
> documents are never sent anywhere.
>
> • Switch between PDF and ⚡ Instant with one click (or Alt+Shift+P)
> • The page repaints as you type; a small chip shows how fast
> • Diagnostics for what the engine could not read, with a click to the line
> • Selectable text, zoom, and a PDF of the instant preview
> • Real LaTeX: TeX Live's packages are downloaded once, when a document
>   first needs them, and kept in your browser (see and clear the cache in
>   the settings)
> • Settings behind the extension's icon: turn it off, choose what opens, reset
>
> This is an UNOFFICIAL extension. It is not made, endorsed or supported by
> Overleaf. It is experimental: PhiTeX runs LaTeX (pdfTeX, with TeX Live's
> packages) in your browser, but for anything that matters, use Overleaf's
> own PDF, one click away. Before its first use it asks you to accept that it is
> provided as is, without warranty.
>
> Free software under the GNU AGPL, version 3 only.

**Category:** Tools (or Productivity) · **Language:** English

**Graphics** (in `store/`):
- Icon: `icon-128.png` (128×128)
- Screenshots, 1280×800:
  1. `screenshot-1-instant.png`: the Instant preview, as you type
  2. `screenshot-2-tip.png`: the tip on Overleaf's PDF
  3. `screenshot-3-consent.png`: the terms, before first use
  4. `screenshot-4-tour.png`: the guided tour
  5. `screenshot-5-diagnostics.png`: diagnostics, with jump to line
  6. `screenshot-6-settings.png`: the settings
- Small promo tile: `promo-small-440x280.png` (440×280)

## Privacy practices

**Single purpose:**
> Show an experimental, locally computed TeX preview of the Overleaf
> project being edited, next to Overleaf's own PDF.

**Permission justifications:**
- `offscreen`: Runs the WebAssembly typesetting engine in a worker in an
  offscreen document, outside the Overleaf page, so typing stays smooth.
- `storage`: Keeps the extension's own settings (on/off, which preview
  opens, the page view, tips, acceptance of the terms, panel layout). No
  document content is stored.
- `activeTab`: Lets the settings popup start the tour or show what's new
  in the Overleaf tab the user is on.
- Host access (content scripts on `https://www.overleaf.com/project/*`):
  Adds the switch and the preview to Overleaf's editor, reads the project
  being edited (from the editor and the project's own files, as the user
  is signed in) to typeset it locally.

**Remote code:** No. All code, including the WebAssembly engine, ships in
the package (CSP `script-src 'self' 'wasm-unsafe-eval'`).

**Data usage:** tick nothing. The extension collects none of: personally
identifiable information, health, financial, authentication, personal
communications, location, web history, user activity, website content.
(It reads the Overleaf project to typeset it, in the browser, and sends
it nowhere.)
- I do not sell or transfer user data to third parties ✓
- I do not use or transfer user data for purposes unrelated to the single purpose ✓
- I do not use or transfer user data to determine creditworthiness or for lending ✓

**Privacy policy URL:** host `PRIVACY.md` (e.g. as a page in the source
repository) and paste its URL.

## Distribution

- **Visibility:** to get reviewed without going public, choose **Private**
  (trusted testers) or **Unlisted**, or keep **Public** but untick
  *publish automatically after review* ("deferred publishing").
- **Trader status:** non-trader (free, no monetization, no ads).
- **Regions:** all.

## Notes for the reviewer

> To test: open any Overleaf project (a free account works), then click
> "⚡ Instant" in the PDF toolbar and accept the terms. A LaTeX document
> works; for example, replace main.tex with:
>
>     \documentclass{article}
>     \begin{document}
>     Hello world. This paragraph repaints as you type.
>     \end{document}
>
> The extension's network requests: overleaf.com (the project's files, as
> the signed-in user) and Shelf (shelf-phitex.pages.dev, TeX Live's package files,
> fetched by name when a document needs one not bundled; nothing about the
> document is sent). The engine runs locally in an offscreen document.

## Updates

Each upload is reviewed again. Code-only updates within the same
permissions are the quick kind. A new permission or host makes Chrome ask
existing users again, and disables the extension until they accept. Bump
`extension/manifest.base.json`'s version and add an entry to
`extension/src/news.ts`, which users see once after updating.

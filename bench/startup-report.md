# PhiTeX Instant 0.4.1: where a cold start's time goes

Measured on 2026-10-08 against 0.4.1 (engine 44b4a63, branch `partex-engine`,
`extension/` as built at 39de975). No extension code was changed.
Everything below comes from `bench/startup.mjs`.

## How it was measured

- **Harness (`bench/startup.mjs`).** It runs headless Chromium 153 with the unpacked extension, on the mock Overleaf, on a 24-core machine.
  - Before the extension's scripts run, it wraps browser APIs in each extension context over CDP: `WebAssembly.compileStreaming` and `instantiate`, the core's exports (`ph_assets`, `ph_open`, …) and imports (`resolve` and `fetch`), `fetch` and XHR, and IndexedDB `get` and `put`.
  - It records the network of every target: the tab, the offscreen document and the three workers.
  - Times are milliseconds from the moment the content script starts. The mock page's own load (0.3–2 s, its CDN fonts) is not ours.
- **Projects.** Six real arXiv e-prints, fetched with `bench/startup-projects.sh`. Figures are included.

  | name | arXiv | class | pages | project zip |
  |---|---|---|---|---|
  | article | 2610.02048 | article | 41 | 2.7 MB |
  | revtex | 2610.00844 | revtex4-2 | 20 | 0.05 MB |
  | ieeetran | 2610.02175 | IEEEtran (its own .cls) | 7 | 0.14 MB |
  | acmart | 2610.01884 | acmart (its own .cls) | 26 | 9.6 MB |
  | xelatex | 2610.02072 | article + fontspec | 39 | 11 MB |
  | longtail | 2610.01909 | article, 19 packages outside the bundle | 62 | 0.4 MB |

  The XeLaTeX project was measured two ways:
  - `xelatex`: the "auto" engine, which approximates it with pdfLaTeX and stand-ins.
  - `xelatex-xe`: XeLaTeX itself.
- **Phases.** Each project was opened in three phases:
  - **cold:** a fresh profile, as a new install.
  - **restart:** Chromium restarted on that profile. IndexedDB and the HTTP cache are warm; the offscreen document and the workers are new. This is the next day's first open.
  - **reload:** the tab reloaded, with the offscreen document and its workers still alive.
- **Networks.**
  - **fast:** the real network from KAUST. Shelf (Cloudflare Pages) answers from Amsterdam: about 0.5–0.7 s for a 400 KB pack.
  - **slow:** CDP emulation of 10 Mbit/s down, 5 Mbit/s up and 80 ms RTT on every target. `chrome-extension://` resources are not throttled.
- **Repeats.** Fast runs were repeated 3 times, slow runs 2 times. Tables show medians. Raw JSON is in `target/startup/`; `python3 bench/startup-analyze.py --summary` regenerates `target/startup/summary.md`.

## Headline: first paint, seconds after the content script starts (median)

| project | cold fast | restart fast | reload fast | cold slow | restart slow | reload slow |
|---|---|---|---|---|---|---|
| ieeetran (7 pp) | 3.7 | 2.5 | 1.3 | 3.9 | 2.7 | 1.5 |
| revtex (20 pp) | 5.7 | 4.1 | 2.7 | 7.4 | 4.2 | 2.9 |
| article (41 pp) | 5.6 | 4.7 | 3.6 | 11.4 | 7.2 | 6.0 |
| acmart (26 pp) | 11.6 | 9.4 | 8.2 | 25.5 | 20.2 | 16.6 |
| xelatex, auto (39 pp) | 16.2 | 12.0 | 9.6 | 28.7 | 20.7 | 19.1 |
| xelatex-xe (39 pp) | 16.5 | 11.7 | 9.5 | 29.2 | 20.6 | 18.9 |
| longtail (62 pp) | 19.9 | 9.8 | 7.1 | 19.8 | 11.5 | 7.4 |

Two things stand out:
- **The reload column is the floor every fix below has to work against.** It already has a warm worker, warm packs and warm caches, yet it is 1.3–9.6 s. The build of the whole document before page 1, and the project download, dominate it.
- **Restart costs 1–3 s more than reload.** That gap is spin-up, index parsing and the IndexedDB refetch.

## Where the time goes

Each stage is on the critical path, in order. Medians over the repeats, in ms (cold / restart / reload; fast network unless marked).

| stage | article | revtex | ieeetran | acmart | xelatex | longtail |
|---|---|---|---|---|---|---|
| project zip download (fast) | 163 / 169 / 159 | 18 | 31–45 | 523 / 519 / 511 | 629 / 632 / 612 | 49–61 |
| project zip download (slow) | 3236 / 2573 / 2658 | 160 | 310 | 9699 / 9045 / 9070 | 10157 / 9794 / 9724 | 514–633 |
| unzip + figures handed to the core | 599 / 610 / 627 | 26 | 99 / 42 / 129 | 1879 / 1848 / 1907 | 2017 / 2018 / 2038 | 146–198 |
| prefetch (scan → packs) | 870 / 885 / 26 | 27 / 32 / 7 | 791 / 558 / 8 | 1536 / 916 / 76 | 2064 / 1094 / 65 | 3587 / 2511 / 104 |
| … of it: offscreen index read + parsed | 733 / 676 / – | – | 774 / 544 / – | 741 / 516 / – | 673 / 482 / – | 719 / 783 / – |
| … of it: packs (bundled, IDB, Shelf) | 140 / 172 / – | – | 16 / 13 / – | 782 / 400 / – | 1493 / 633 / – | 2868 / 1896 / – |
| waiting for the worker (open_wait) | 32 / 34 / 14 | **1190 / 1041 / 8** | **425 / 477 / 17** | 132 / 134 / 100 | 299 / 290 / 77 | 216 / 198 / 94 |
| build, `ph_open` (the whole document) | 3430 / 2105 / 2001 | 3538 / 2185 / 2248 | 1628 / 815 / 776 | 6680 / 5167 / 5152 | 10332 / 7062 / 6550 | 15433 / 6422 / 6428 |
| … of it: waiting on Shelf, synchronous XHR (fast) | 986 (6 fetches) | 964 (5) | 573 (2) | 1009 (7) | 2896 (6) | **8442 (15)** |
| … of it: waiting on Shelf (slow) | 3058 | 2616 | 870 | 3034 | 6036 | 6351 |
| `← open` → first paint | 342 / 813 / 687 | 592 / 531 / 357 | 486 / 453 / 296 | 664 / 601 / 408 | 721 / 717 / 320 | 397 / 390 / 244 |

### Extension and worker spin-up

The worker is off the critical path unless the prefetch is short.

| step (build worker A, cold + restart, n = 64) | min | median | max |
|---|---|---|---|
| content script → offscreen document created | | 6 | |
| content script → worker A ready (median per project) | 1280 | 1430 | 1635 |
| `WebAssembly.compileStreaming`, 11 MB `core.wasm` | 45 | 97 (cold 55, restart 119) | 162 |
| Shelf index: fetch, gunzip, `new Index` (`loadShelf`) | 566 | 691 | 962 |
| … of it: `new Index` alone | 491 | 548 | 668 |
| assets: fetch + gunzip, 12.7 MB → 64.8 MB | 344 | 382 | 476 |
| handoff to the core (`ph_assets`) | 35 | 38 | 50 |

- **`load()` runs every step serially:** compile, then `loadShelf`, then instantiate, then the assets. Nothing overlaps.
- **wasm compilation is not the problem.** Chrome compiles lazily (Liftoff), so `compileStreaming` takes 50–110 ms. A warm worker (reload) builds no faster than a fresh one (restart), so the cost of lazy compilation during the build is also negligible.
- **The index constructor costs about 0.55 s, three times on every start.** `new Index` runs in the offscreen document (on the prefetch's critical path), in worker A and in worker B. This matches the main session's node measurement of 550–615 ms; the lazy rewrite brings it to 110–145 ms.
- **The worker is on the critical path for projects whose packages are all in the core's assets.** revtex waits 1.0–1.2 s and ieeetran 0.4–0.5 s for it, even on restart.
- **Three workers each compile `core.wasm`.** Build worker A, the draw worker, and the SSA worker B (started at the first open) each compile it. A and B each gunzip the 65 MB of assets and parse the index. That is harmless on 24 cores, and contention on a 4-core laptop.

### Package resolution

- **No rounds after the open in any run.** The scan-based prefetch finds every name the sources load, and the core fetches the rest itself, mid-build.
- **What the core fetches itself is mostly fonts.** For example, `lm.hot7`, `lm.cold` and `lm.f-lmr` for the article, and `cm-super.*` for others. No scan sees these; the build asks for them as it typesets.
- **Those fetches are synchronous and serial.** The core fetches them with synchronous XHR, one pack and one round trip after another. On a cold start that costs 0.6–8.4 s of the build on the fast network, and 0.9–6.4 s on the slow one. longtail makes 15 such fetches, 8.4 s in all.

Bytes on a cold fast start (from the network log):

| project | Shelf packs (bytes) | bundled packs read | Shelf metadata |
|---|---|---|---|
| article | 13 packs, 2.5 MB | 31, 5.1 MB | 0.93 MB |
| acmart | 27, 2.9 MB | 33, 6.1 MB | 0.93 MB |
| xelatex | 21, 6.7 MB | 43, 6.8 MB | 0.93 MB |
| longtail | 59, 9.0 MB | 79, 11.8 MB | 0.93 MB |

- "Shelf metadata" is the release index, which a fresh install downloads again; see "Surprises".
- Shelf counts include the second worker's requests, which hit the HTTP cache.

### The IndexedDB refetch waste: confirmed

- **On restart, `resolve` refetches every pack of every name the prefetch asks for.** The name's file is in IndexedDB (every `get` hits), yet `resolve` still fetches all its packs, from the extension or the HTTP cache. It then unpacks them and `put`s every file into IndexedDB again. The cause is that `given` and `packs` live in memory only.

  | project (fast) | restart: IDB `get`s (hits) | restart: files re-`put` | restart: prefetch pack phase | reload (in-memory state) |
  |---|---|---|---|---|
  | article | 3 (3) | 125 files, 1.7 MB | 172 ms | 26 ms (whole prefetch) |
  | ieeetran | 3 (3) | 4, 0.06 MB | 13 ms | 8 ms |
  | acmart | 22 (22) | 186, 6.4 MB | 400 ms (fast), 376 (slow) | 76 ms |
  | xelatex | 17 (17) | 244, 8.4 MB | 633 ms | 65 ms |
  | longtail | 45 (45) | **1558, 17.4 MB** | **1896 ms (fast), 2922 (slow)** | 104 ms |

- **What it costs.** The waste is 0.2–2.9 s on every browser session's first open. It grows with the number of packages outside the core's assets. It is not network time: the HTTP cache serves the Shelf packs, and the bundled ones come from the extension. The time goes to reading, unpacking and re-`put`ting the files.
- **The other half of the restart prefetch is the offscreen index parse.** That costs 0.5–0.8 s, and its fix is separate.

### Project download and figures

- **The whole project ZIP is downloaded on every open, including reloads.** Nothing caches it. At 10 Mbit/s that costs 2.6 s for article, and 9–10 s for acmart and xelatex, because of their figures.
- **Handing figures to the core costs 0.6–2.0 s on every open.** Each figure is sent base64 over the runtime port, then decoded, then posted to worker A and to worker B. That costs 0.6 s for 2.6 MB (article) and 1.9–2.0 s for about 10 MB (acmart, xelatex). This is CPU, not network.

### The build, and the first paint

- **Page 1 waits for the whole document.** The "plain first paint" build typesets every page before the open answers. Even with everything warm (reload) it takes 0.8 s (7 pages), 2.0–2.2 s (20–41 pages), 5.2 s (acmart, 26 pages), 6.4–6.6 s (39–62 pages).
- **This is the largest single item in every warm open.** It is also the largest in cold opens, apart from the Shelf waits.
- **`← open` → first paint takes 0.25–0.8 s.** The tab gets `← open`, then the draw worker draws, then the SVG goes in.
- **The draw worker can block page 1 behind page 2.** It draws ahead before it answers the request for page 1; in the article it spent 0.45–0.7 s on page 2 first.

## Fixes, ranked by expected win

Wins are per open, in seconds, from the tables above. Where a fix is on a parallel path, only the critical-path part is counted.

| # | fix | cold | restart (each browser session) | reload | notes |
|---|---|---|---|---|---|
| 1 | **Background prefetch of the 95% set, fonts included** (`data/ahead.txt`: 63 MB beyond the bundle, 54 MB of it fonts) | 0.6–8.4 s fast, 0.9–6.4 s slow from the build's synchronous Shelf waits, plus 0.1–4.4 s of prefetch Shelf time | ~0 (packs already cached) | 0 | The biggest cold win, but only for the first open of each package set. It must include the font packs builds read (`lm.*`, `cm-super.*`, `amsfonts.hot3`, `dvips`), which no scan finds: 93% of papers read at least one pack the bundle lacks, mostly fonts. |
| 2 | **IndexedDB refetch fix** (`resolve` serves a name and its packs from IDB without refetching or re-putting) | – | 0.2–2.9 s | 0 | Every browser session, every project with packages outside the core's assets. Cheap to do. |
| 3 | Lazy Shelf index (not on the list, but measured; done on branch `startup-prefetch`) | 0.5–0.75 s on the prefetch path; 0.4–1.2 s where the worker is critical | same | 0 | Three parses per start (offscreen, A, B). The branch's lazy `Index` cuts each from about 550 ms to about 120 ms. |
| 4 | **Caching the unpacked assets** | ≤ 0.35 s, only where the worker is critical (revtex, ieeetran) | same | 0 | Gunzipping 12.7 MB → 65 MB takes about 0.38 s. Reading 65 MB back from IDB or Cache Storage is not free (around 0.1 s), so the net win is about 0.25 s. Running the asset fetch in parallel with compile and index parsing gets most of it with no cache. |
| 5 | **Caching the compiled wasm** | ≤ 0.05–0.1 s | ≤ 0.1 s | 0 | `compileStreaming` is already lazy (50–110 ms) and off the critical path. Not worth doing. |
| 6 | **Shrinking the bundle**, or rather re-choosing it | as is ≈ 0; re-chosen, the same 0.6–8.4 s as fix 1 for 61% of papers instead of 7% | ≈ 0 | 0 | Bundled packs are read from the extension in 5–15 ms each, so shrinking alone saves install size, not time. Re-choosing it is what pays. The bundle covers 6.9% of papers whole once fonts are counted. 1.3 MB of small additions (`dvips`, `amsfonts.hot3`, `amsfonts.f-eufb`, …) take it to 36%. A 20 MB set chosen from these data covers 61%. |

Order of the listed five, by win per open:
1. Prefetch of the 95% set (cold).
2. The IndexedDB fix (each restart).
3. Re-choosing the bundle (cold; the same mechanism as 1, shipped instead of fetched).
4. Caching the unpacked assets.
5. Caching the compiled wasm.

Shrinking the bundle as such saves no time.

From the main session, on the same code:
- **`new Index` costs 550–615 ms of CPU per construction in node**, and it runs in both the offscreen document and the worker. The branch's lazy rewrite takes it to 110–145 ms with identical results. Here it shows as the 0.49–0.67 s `new Index` in worker A, and as the 0.48–0.84 s index part of the prefetch.
- **On a warm open of a long-tail project, the package round took about 15–470 ms on 0.4.1, and about 20–310 ms on the branch.** The variance comes from that harness's first, aborted session.

Not on the list, but larger than items 3–6 in the measurements:
- **First paint from the first pages, not the whole document.** This is 0.8–6.6 s on every open, warm or cold. It is the largest item on warm opens and engine-side.
- **Cache the project ZIP or the figures, or diff against Overleaf's file list.** The download is 2.5–10 s on 10 Mbit for projects with figures, on every open. The figure handoff costs 0.6–2 s of CPU; transferring `ArrayBuffer`s instead of base64 over the port would cut it.
- **Fetch font packs in parallel or ahead instead of serially in the build.** Even without the 95% set, the serial synchronous XHR multiplies the RTT (about 0.5 s to Shelf's Amsterdam edge) by the number of font packs.
- **Answer the requested page before drawing ahead.** That is up to 0.7 s.

## Coverage: which papers the bundle builds, and what it would take

- **Sample: 3,432 e-prints, 3,298 of them with LaTeX source.**
  - 986 come from the original survey, which `target/arxiv-packages/ids.txt` and `results.jsonl` still hold: the newest papers in 28 categories.
  - 2,312 are fresh: 77 categories, the 15–160 papers after the newest 150 in each.
  - They were fetched from `export.arxiv.org` by 8 Slurm tasks on accl, with all requests combined at no more than one every 3 s. Only the text sources are kept: `bench/arxiv/fetch.py`.
- **Per paper:** class, engine, packages, `.bst` and the files it ships itself (`bench/arxiv/extract.py`).
- **The packs a build really reads.** `bench/arxiv/build-packs.mjs` builds each paper with the extension's own `core.wasm` in Node: 4 × 16 cores on accl, about 8 minutes for all of them. For the article project this reproduced exactly the 33 packs the browser fetched.
  - 3,056 papers (92.7%) built pages. Missing figures become draft boxes.
  - For the rest, the index's closure of the paper's names stands in.
- **Data:** `data/arxiv-papers.tsv.gz`, one paper a row. `python3 bench/arxiv/coverage.py [--subset survey1|fresh] [--sets data/arxiv-sets] [--ahead data/ahead.txt]` regenerates every number below.

### Engines and buildability

- **Declared engine.** Every e-print has arXiv's `00README.json`. Of the 3,298: pdfLaTeX 3,139, XeLaTeX 92, LaTeX (dvi) 66. None declares LuaLaTeX.
- **Engine actually needed.** Only 15 papers (0.45%) load `fontspec`, `unicode-math`, `polyglossia` or `xeCJK` without an `\ifPDFTeX`/`\iftutex` guard, so XeLaTeX is needed. The other 77 that declare XeLaTeX build with pdfLaTeX.
- **Buildable from TeX Live: 3,239 papers (98.2%).** The rest name a file that is in neither TeX Live nor the tarball: `l3regex.sty` (23), `charis.sty` (18), `AASTeX62.cls`, … Every percentage below is of these 3,239.

### Fonts change the picture

- **A build reads about 9 packs more than the index's closure of the paper's names.** The median is 7, almost all fonts:
  - `lm.*` for Latin Modern;
  - `cm-super.*` for T1 Computer Modern;
  - `amsfonts.hot3` and `amsfonts.f-eufb`;
  - `newtx.*`;
  - `dvips` (`8r.enc`, for any Times/Helvetica document).

  No source scan sees them, because the build asks for them as it typesets. In 0.4.1 they are exactly the synchronous, serial Shelf fetches inside the build.
- **Counted by closure only, the bundle covers 49.6% of papers. Counted by what builds read, it covers 6.9%.** The same holds in both subsets: 5.8% of survey1 and 7.4% of fresh.
  - So a first open of almost any paper fetches something from Shelf.
  - The most common misses are `dvips` (1,300 papers, a 67 KB pack), `amsfonts.hot3` (993), `cm-super.hot12` (392), `amsfonts.f-eufb` (384) and the `lm.*` font chunks (about 300 each).

### Cheapest additions to the bundle

Each step adds the pack that completes the most papers per MB.

| + pack | KB | papers it completes | covered after | added MB |
|---|---|---|---|---|
| dvips | 67 | 359 | 18.0% | 0.07 |
| capt-of, subfigure, thmtools, babel-english, silence | 1–14 | 65 | 20.0% | 0.09 |
| amsfonts.hot3 | 496 | 225 | 27.0% | 0.59 |
| … 12 more small packs | | | 29.9% | 0.69 |
| amsfonts.f-eufb | 496 | 115 | 33.5% | 1.18 |
| psfrag, nicematrix, pdfcol, tikzfill, listingsutf8 | | | 36.3% | 1.26 |

**1.3 MB more raises the bundle's coverage from 6.9% to 36%.** Most of that comes from `dvips` alone (+11 points for 67 KB).

### The coverage curve: papers covered whole against MB of packs

There are two greedy curves; the right-hand column is the minimal-set result:
- **From nothing:** each step adds the pack that completes the most papers per MB, or the cheapest paper's missing packs.
- **From the current bundle:** the same, starting from the 167 bundled packs (19.8 MB). Its column is the total size including the bundle, which is the minimal set to ship or prefetch.

| covered | from nothing: MB (packs, of them fonts MB) | from the bundle: total MB (packs, fonts MB) |
|---|---|---|
| 50% | 12.8 (305, 8.1) | 23.0 (366, 16.1) |
| 75% | 39.4 (564, 28.0) | 39.9 (589, 29.2) |
| 80% | 66.9 (679, 53.5) | 55.0 (669, 41.7) |
| 90% | 75.5 (715, 61.5) | 69.4 (726, 55.7) |
| **95%** | **84.0 (760, 69.5)** | **83.1 (790, 68.1)** |
| 98% | 91.3 (791, 75.1) | 91.4 (818, 74.9) |
| 99% | 113.7 (861, 97.2) | 115.4 (882, 98.4) |

```
from nothing:  0 MB 1% · 5 MB 15% · 10 MB 42% · 15 MB 56% · 20 MB 61% · 25 MB 66% · 30 MB 68% · 40 MB 77%
               · 60 MB 79% · 70 MB 84% · 75 MB 89% · 81 MB 94% · 85 MB 98% · 114 MB 99% · 203 MB 100%
from bundle:  20 MB 7% · (+0.1 MB) 24% · 25 MB 58% · 30 MB 66% · 35 MB 72% · 40 MB 75% · 55 MB 80%
               · 65 MB 90% · 81 MB 94% · 86 MB 98% · 115 MB 99% · 205 MB 100%
```

- **The current 20 MB bundle is badly chosen for what builds read.** A 20 MB set chosen from these data covers 61% of papers whole, against 6.9% today.
- **Fonts are four fifths of every set from 80% up.** The flat stretch between 40 and 65 MB is big Type 1 font families (`cm-super`, `newtx`, `libertine`), each needed whole by a few percent of papers.
- **The two subsets agree.** The 95% point is 62.9 MB on survey1 and 76.1 MB on fresh (totals from the bundle), so the sample size matters less than the font tail.
- **Sets written.** `data/arxiv-sets/pNN.txt` holds each set from nothing, and `bundle+pNN.txt` what each adds to the bundle (closure and fonts included).

### `data/ahead.txt`: what to fetch ahead

- **Contents: 554 names.**
  - 389 are packages, classes and `.bst` files.
  - 138 are font files (`.tfm`, `.pfb`, `.enc`, `.vf`): one name for each font pack a build reads that no name's closure brings, such as `6w.enc` for `dvips` and `ec-lmbx9.tfm`.
  - 27 are other files a pack holds, such as `.ldf`, `.bbx` and `.def`.
  - Two names are `<TAB>xetex`.
- **Order:** the greedy coverage rank from the bundle.
- **Size:** resolved the way the extension does (each name's packs and their dependency packs, the bundled ones skipped), they bring 627 packs, **63.4 MB beyond the bundle, 54.0 MB of it fonts**. That covers 97.0% of the buildable papers whole: the greedy step that crosses 95% lands at 97%.
- **Gap:** 2 small packs of the 95% set (`elocalloc`, `inlinedef`) have no file a name resolves back to. They are not in the list.

## Surprises

- **The bundle covers 6.9% of arXiv papers whole, not about 50%.** The bundle was chosen by the packages papers *load*, but builds also read the fonts their text is set in. A 67 KB pack (`dvips`, for `8r.enc`) blocks 39% of papers on its own.

- **Shelf is about 0.5 s away per pack from Saudi Arabia.** Cloudflare serves it from Amsterdam. Every serial fetch in a build pays that.
- **A fresh install downloads the Shelf index it already ships (926 KB).** `release.ts` compares the live release with the index stored in IndexedDB, not with the shipped `shelf-release.json`. Both are tl2026.5.
- **The "auto" XeLaTeX approximation is no faster than XeLaTeX itself.** It took 16.2 s against 16.5 s cold, and 9.6 s against 9.5 s on reload.
- **arXiv now records the compiler.** Every e-print in the sample has a `00README.json` with `"process": {"compiler": …}`. Some papers declare `xelatex` but guard `fontspec` with `\ifPDFTeX`, so they build with pdfLaTeX too.

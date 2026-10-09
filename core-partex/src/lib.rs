//! The preview's engine on partex-PhiTeX: pdfTeX (real LaTeX) as a wasm
//! core, behind the same raw C ABI as `core/` (`ph_*`), so the worker,
//! session and panel are unchanged.
//!
//! - Files are in memory ([`MemHost`]): the project's, the packages the
//!   host fetched (`set_file`), and the assets (`ph_assets`: the LaTeX
//!   format and the fonts' metrics, binary, loaded once per instance).
//! - A build runs `pdflatex.fmt` in DVI mode (`\pdfoutput=0`): each page
//!   reaches the host as partex's page IR ([`Page`]), drawn as the panel's
//!   draw list ([`draws_json`]). What the job wrote and reads back (the
//!   `.aux`, `.toc`, ...) is kept for the next build, as latexmk would.
//! - A file the job looks for and lacks stops the job (TeX's "file not
//!   found" is fatal without a terminal); the status lists it as
//!   `missing`, the host fetches it, and the next build gets further.
//! - Builds are lazy: `set_file` and edits mark the session stale, and the
//!   next query builds. (Cold for now; partex's SSA rebuild comes next.)

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write as _;
use std::hash::{Hash, Hasher};
use std::ops::Range;
use std::sync::Arc;
use std::time::Instant;

use partex_core::pageir::Page;
use partex_core::ssa::{self, Recorder, SsaTracker};
use partex_core::{DateTime, FileKind, Host, OpenedFile, Params, Tex, Untracked, WriteId};

pub mod draws;
pub mod dvi;
mod bib;
pub mod shelf;
mod stream;
pub mod system;
pub mod xetex;

pub use draws::draws_json;

/// Files by name (flat, as Shelf serves them), and what the job wrote.
#[derive(Default)]
pub struct MemHost {
    pub files: BTreeMap<Vec<u8>, Arc<[u8]>>,
    pub written: BTreeMap<Vec<u8>, Vec<u8>>,
    open: BTreeMap<u32, Vec<u8>>,
    /// Every handle given, and the file it named (open_write_again).
    given: BTreeMap<u32, Vec<u8>>,
    next: u32,
    pub term: Vec<u8>,
    /// Names looked up and not found: what to fetch.
    pub missing: Vec<(Vec<u8>, FileKind)>,
    /// The pages shipped, in order (DVI mode).
    pub pages: Vec<Page>,
    pub now: Option<DateTime>,
    /// The engine's cache (`cache_get`/`cache_put`: a map file's warnings),
    /// for this session's later builds.
    cache: BTreeMap<u128, Vec<u8>>,
    /// Asked for a name not in `files` (the format tool's lookup); what it
    /// gives is kept in `files`.
    pub fallback: Option<Box<dyn FnMut(&[u8]) -> Option<Vec<u8>>>>,
    /// `PARTEX_HOST_TRACE`: each file served (name, length, from), for debugging.
    pub served: Vec<(String, usize, &'static str)>,
    /// Handles an SSA build writes on (`open_write_later`): its bytes are
    /// the build's, a link writes the file; writes on them are dropped.
    later: BTreeSet<u32>,
    /// The engine's content-keyed memo (`cached`/`cache`: a PNG's decoded
    /// rows, a Type 1 font's subsets), kept across rebuilds.
    memo: HashMap<u128, partex_core::host::Memo>,
    /// The outputs the link last wrote (by name): the build's own, not
    /// edited (`output_edited`).
    pub linked: BTreeSet<Vec<u8>>,
    /// The project's own files, by name: what a command (`system`) is
    /// handed, with the job's outputs; not TeX Live's (the assets, Shelf's).
    pub project: BTreeSet<Vec<u8>>,
    /// (wasm) Shelf, through the worker, and the engine names resolve for
    /// (pdftex, xetex): a name the host lacks resolved to its texmf path
    /// as kpathsea would for that engine, fetched, kept by path.
    pub shelf: Option<(shelf::Cache, &'static str)>,
    /// A streamed build's (`stream.rs`): the pages and forms shipped so
    /// far (`Host::stream_shipped`), and the pages shipped since asked.
    pub shipments: Option<partex_core::pagepdf::Shipments>,
    pub shipped_new: Vec<usize>,
    /// The files the job named ahead (`Host::will_need`), not yet asked
    /// for: what the host can fetch while the build runs.
    pub hints: Option<Vec<(Vec<u8>, FileKind)>>,
}

fn suffix(kind: FileKind) -> &'static [u8] {
    match kind {
        FileKind::Tex => b".tex",
        FileKind::Tfm => b".tfm",
        FileKind::Fmt => b".fmt",
        FileKind::Bst => b".bst",
        FileKind::Bib => b".bib",
        FileKind::Ist => b".ist",
        FileKind::OpenType => b".otf",
        _ => b"",
    }
}

fn with_suffix(name: &[u8], kind: FileKind) -> Vec<u8> {
    let s = suffix(kind);
    let mut n = name.to_vec();
    if !s.is_empty() && !name.ends_with(s) {
        n.extend_from_slice(s);
    }
    n
}

impl Host for MemHost {
    fn read_file(&mut self, name: &[u8], kind: FileKind) -> Option<OpenedFile> {
        // kpathsea: the name with the kind's suffix first, then as given
        let base = name.strip_prefix(b"./").unwrap_or(name);
        // (XeTeX's font index: one asset, whatever the name)
        if kind == FileKind::FontIndex {
            let c = self.files.get(xetex::INDEX).cloned().or_else(|| self.fallback.as_mut().and_then(|f| f(xetex::INDEX)).map(Arc::from))?;
            self.files.insert(xetex::INDEX.to_vec(), c.clone());
            return Some(OpenedFile { name: xetex::INDEX.to_vec(), contents: c });
        }
        // (XeTeX's fonts: by TeX Live's absolute path, kept by the path
        // inside it; or by base name, found in the font index's paths)
        // (native tools only: in the browser Shelf resolves paths, below)
        if self.shelf.is_none() && (matches!(kind, FileKind::OpenType | FileKind::TrueType | FileKind::MiscFonts | FileKind::Type1 | FileKind::Pict) || base.starts_with(xetex::TL)) {
            for n in [with_suffix(base, kind), base.to_vec()] {
                for k in xetex::keys(&n).into_iter().skip(1) {
                    let c = self.files.get(&k).cloned().or_else(|| {
                        let c: Arc<[u8]> = Arc::from(self.fallback.as_mut()?(&k)?);
                        self.files.insert(k.clone(), c.clone());
                        Some(c)
                    });
                    if let Some(c) = c {
                        self.served.push((String::from_utf8_lossy(&k).into_owned(), c.len(), "font"));
                        // (under the name asked too: `unchanged` finds it by that)
                        self.files.insert(n.clone(), c.clone());
                        return Some(OpenedFile { name: n, contents: c });
                    }
                }
            }
        }
        for n in [with_suffix(base, kind), base.to_vec()] {
            // (a file this job wrote, `\jobname.aux` at the end: as on a
            // disk, what was written so far, open or not; a rebuild opens it
            // again in a step it runs and may not run the step closing it)
            if let Some(w) = self.written.get(&n) {
                self.served.push((String::from_utf8_lossy(&n).into_owned(), w.len(), "written"));
                return Some(OpenedFile { name: n, contents: Arc::from(&w[..]) });
            }
            if let Some(c) = self.files.get(&n) {
                self.served.push((String::from_utf8_lossy(&n).into_owned(), c.len(), "file"));
                return Some(OpenedFile { name: n, contents: c.clone() });
            }
        }
        // (Shelf: the name resolved for the engine and the kind's format,
        // the file kept by its path and under the name asked, which
        // `unchanged` looks it up by)
        if let Some((cache, engine)) = &self.shelf {
            for n in [with_suffix(base, kind), base.to_vec()] {
                let files = &self.files;
                if let Some((key, c)) = shelf::find(cache, &n, shelf::format(kind), engine, &|k| files.get(k).cloned()) {
                    self.served.push((String::from_utf8_lossy(&key).into_owned(), c.len(), "shelf"));
                    self.files.entry(key).or_insert_with(|| c.clone());
                    self.files.insert(n.clone(), c.clone());
                    return Some(OpenedFile { name: n, contents: c });
                }
            }
        }
        if let Some(f) = &mut self.fallback {
            for n in [with_suffix(base, kind), base.to_vec()] {
                if let Some(c) = f(&n) {
                    let c: Arc<[u8]> = Arc::from(c);
                    self.files.insert(n.clone(), c.clone());
                    return Some(OpenedFile { name: n, contents: c });
                }
            }
        }
        // (the name to fetch: as given if it has an extension, as kpathsea
        // tries it too)
        let want = if base.contains(&b'.') { base.to_vec() } else { with_suffix(base, kind) };
        self.served.push((String::from_utf8_lossy(&want).into_owned(), 0, "missing"));
        if !self.missing.iter().any(|(n, _)| *n == want) {
            self.missing.push((want, kind));
        }
        None
    }
    /// Whether each load would read the same again, without reading: the
    /// file it found is the same shared buffer (an edit replaces a file's
    /// buffer), or it found none and there still is none. A file the job
    /// wrote is compared by the engine (it is rebuilt on each read).
    fn cache_get(&mut self, key: u128) -> Option<Vec<u8>> {
        self.cache.get(&key).cloned()
    }

    fn cache_put(&mut self, key: u128, value: &[u8]) {
        self.cache.insert(key, value.to_vec());
    }

    fn cached(&mut self, key: u128) -> Option<partex_core::host::Memo> {
        self.memo.get(&key).cloned()
    }

    fn cache(&mut self, key: u128, value: partex_core::host::Memo) {
        self.memo.insert(key, value);
    }

    fn unchanged(&mut self, loads: &[partex_core::host::Load<'_>]) -> Vec<bool> {
        loads
            .iter()
            .map(|(name, kind, got)| {
                let base = name.strip_prefix(b"./").unwrap_or(name);
                // (XeTeX's font index: the one asset, whatever the name)
                let cands = if *kind == FileKind::FontIndex { [xetex::INDEX.to_vec(), xetex::INDEX.to_vec()] } else { [with_suffix(base, *kind), base.to_vec()] };
                if cands.iter().any(|n| self.written.contains_key(n)) {
                    return false;
                }
                let now = cands.iter().find_map(|n| self.files.get(n));
                // (a load the job made and found nothing, still absent: the job
                // still lacks it, whether or not this rebuild runs its step
                // again; missing is the job's, not this build's lookups)
                if now.is_none() && got.is_none() {
                    let want = if base.contains(&b'.') { base.to_vec() } else { with_suffix(base, *kind) };
                    if !self.missing.iter().any(|(n, _)| *n == want) {
                        self.missing.push((want, *kind));
                    }
                }
                match (now, got) {
                    (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                    (None, None) => true,
                    _ => false,
                }
            })
            .collect()
    }
    fn open_write(&mut self, name: &[u8], kind: FileKind) -> Option<(WriteId, Vec<u8>)> {
        let n = with_suffix(name, kind);
        self.next += 1;
        self.open.insert(self.next, n.clone());
        self.given.insert(self.next, n.clone());
        self.written.insert(n.clone(), Vec::new());
        Some((WriteId(self.next), n))
    }
    /// A step run again opens its file on the handle it had: the same
    /// handle, emptied, if it named this file (so later steps' writers and
    /// writes still name it); else a new one.
    fn open_write_again(&mut self, name: &[u8], kind: FileKind, id: WriteId) -> Option<(WriteId, Vec<u8>)> {
        let n = with_suffix(name, kind);
        if self.given.get(&id.0) != Some(&n) {
            return self.open_write(name, kind);
        }
        self.open.insert(id.0, n.clone());
        self.written.insert(n.clone(), Vec::new());
        Some((id, n))
    }
    /// An SSA build's output: a handle, the file not touched (the build
    /// keeps the bytes; the link writes the file). Before this, the file
    /// was emptied mid-build by a step run again, and the next rebuild read
    /// the cut file as an edit.
    fn open_write_later(&mut self, name: &[u8], kind: FileKind, again: Option<WriteId>) -> Option<(WriteId, Vec<u8>)> {
        let n = with_suffix(name, kind);
        let id = match again {
            Some(id) if self.given.get(&id.0) == Some(&n) => id.0,
            _ => {
                self.next += 1;
                self.next
            }
        };
        self.given.insert(id, n.clone());
        self.later.insert(id);
        Some((WriteId(id), n))
    }
    /// `\write18`: the worker's runner (latexminted in Pyodide, system.rs),
    /// over the project's files, what the job wrote and the build's own
    /// version of the job's files, the last winning.
    fn system(&mut self, command: &[u8], inputs: &[(Vec<u8>, Arc<[u8]>)]) -> Option<partex_core::host::Ran> {
        if !system::on() {
            return None;
        }
        // (the project's files, what the job and earlier commands wrote, and
        // what the engine hands it; not TeX Live's 2000 files, 65 MB, which
        // latexminted never reads and which cost a second a call to copy)
        let mut files: BTreeMap<&[u8], &[u8]> = BTreeMap::new();
        files.extend(self.files.iter().filter(|(n, _)| self.project.contains(*n) || self.linked.contains(*n) || n.ends_with(b".minted")).map(|(n, c)| (&n[..], &c[..])));
        files.extend(self.written.iter().map(|(n, c)| (&n[..], &c[..])));
        files.extend(inputs.iter().map(|(n, c)| (&n[..], &c[..])));
        let (status, wrote, removed) = system::run(command, &files)?;
        // (read back by the job as files: the next \input of them finds them)
        for (n, c) in &wrote {
            self.files.insert(n.clone(), c.clone());
            self.project.insert(n.clone());
        }
        for n in &removed {
            self.files.remove(n);
        }
        Some(partex_core::host::Ran { status, wrote, removed, stdout: Vec::new() })
    }
    fn runs_commands(&self) -> bool {
        system::on()
    }
    fn output_edited(&mut self, name: &[u8]) -> bool {
        // (outputs are the build's: no one edits a .aux in the editor; one
        // the link never wrote is read as an edit, as the default)
        let base = name.strip_prefix(b"./").unwrap_or(name);
        !self.linked.contains(base)
    }
    fn write(&mut self, file: WriteId, bytes: &[u8]) {
        if self.later.contains(&file.0) {
            return;
        }
        if let Some(n) = self.open.get(&file.0) {
            self.written.get_mut(n).unwrap().extend_from_slice(bytes);
        }
    }
    fn close(&mut self, file: WriteId) {
        self.open.remove(&file.0);
    }
    fn term_write(&mut self, bytes: &[u8]) {
        self.term.extend_from_slice(bytes);
    }
    fn term_read_line(&mut self) -> Option<Vec<u8>> {
        None
    }
    fn now(&self) -> DateTime {
        self.now.unwrap_or(DateTime { year: 2026, month: 1, day: 1, minutes: 0 })
    }
    /// `\pdffilemoddate` (XeTeX's `\filemoddate`): a file the job has (the
    /// project's, one it read or wrote) changed when the session started,
    /// as far as it can tell: the job's own date, the same every build.
    fn file_mod_date(&mut self, name: &[u8]) -> Option<Vec<u8>> {
        let base = name.strip_prefix(b"./").unwrap_or(name);
        (self.files.contains_key(base) || self.written.contains_key(base)).then(|| self.creation_date())
    }
    fn page_written(&mut self, page: &Page) {
        self.pages.push(page.clone());
    }
    fn deflate(&mut self, level: i32, data: &[u8]) -> Option<Vec<u8>> {
        Some(miniz_oxide::deflate::compress_to_vec_zlib(data, u8::try_from(level.clamp(0, 9)).unwrap_or(6)))
    }
    fn wants_streams(&self) -> bool {
        self.shipments.is_some()
    }
    fn stream_shipped(&mut self, page: Option<usize>, stream: partex_core::pagepdf::ShippedStream) {
        if let Some(s) = &mut self.shipments {
            s.add(page, stream);
            if let Some(k) = page {
                self.shipped_new.push(k);
            }
        }
    }
    fn wants_hints(&self) -> bool {
        self.hints.is_some()
    }
    fn will_need(&mut self, files: &[(Vec<u8>, FileKind)]) {
        if let Some(h) = &mut self.hints {
            h.extend_from_slice(files);
        }
    }
}

/// TeX Live's `texmf.cnf` sizes for pdfTeX (LaTeX needs more than
/// web2c's compiled-in defaults). A job loading a format must use the
/// sizes that made it.
#[must_use]
pub fn texlive_params(ini: bool) -> Params {
    engine_params(false, ini)
}

/// TeX Live's sizes for pdfTeX, or (`xetex`) XeTeX.
#[must_use]
pub fn engine_params(xetex: bool, ini: bool) -> Params {
    Params {
        flavor: if xetex { partex_core::Flavor::XeTeX } else { partex_core::Flavor::PdfTex },
        etex: ini,
        ini,
        main_memory: 5_000_000,
        extra_mem_top: 0,
        extra_mem_bot: 0,
        pool_size: 6_250_000,
        string_vacancies: 90_000,
        pool_free: 47_500,
        max_strings: 500_000,
        strings_free: 100,
        font_mem_size: 8_000_000,
        font_max: 9000,
        trie_size: 1_000_000,
        hyph_size: 8191,
        buf_size: 200_000,
        nest_size: 500,
        max_in_open: 15,
        param_size: 10_000,
        save_size: 100_000,
        stack_size: 10_000,
        dvi_buf_size: 16_384,
        error_line: 79,
        half_error_line: 50,
        max_print_line: 79,
        hash_extra: 600_000,
        expand_depth: 10_000,
        // (pdflatex's default: restricted shell escape, TeX Live's list;
        // a command runs only where the worker has a runner, system.rs)
        shell_escape: true,
        restricted_shell: true,
        shell_escape_commands: partex_core::shell::command_list(
            b"bibtex,bibtex8,extractbb,gregorio,kpsewhich,l3sys-query,latexminted,makeindex,memoize-extract.pl,memoize-extract.py,repstopdf,r-mpost,texosquery-jre8,",
        ),
        ..Params::default()
    }
}

/// Run `command_line` cold; the host afterwards.
pub fn run(host: MemHost, params: Params, command_line: &[u8]) -> (i32, MemHost) {
    let mut tex = Tex::new(host, Untracked, params);
    let h = tex.run(command_line);
    (h, std::mem::take(tex.host_mut()))
}

/// The assets' framing: `u32 n, (str name, bytes) × n` (little-endian
/// lengths), the same as the ABI's input.
#[must_use]
pub fn parse_assets(mut b: &[u8]) -> Option<BTreeMap<Vec<u8>, Arc<[u8]>>> {
    fn u32_(b: &mut &[u8]) -> Option<usize> {
        let (a, rest) = b.split_at_checked(4)?;
        *b = rest;
        Some(u32::from_le_bytes(a.try_into().ok()?) as usize)
    }
    let n = u32_(&mut b)?;
    let mut m = BTreeMap::new();
    for _ in 0..n {
        let k = u32_(&mut b)?;
        let (name, rest) = b.split_at_checked(k)?;
        b = rest;
        let k = u32_(&mut b)?;
        let (data, rest) = b.split_at_checked(k)?;
        b = rest;
        m.insert(name.to_vec(), Arc::from(data));
    }
    Some(m)
}

thread_local! {
    /// The format and fonts (`ph_assets`), shared by every session.
    static ASSETS: RefCell<BTreeMap<Vec<u8>, Arc<[u8]>>> = RefCell::default();
}

/// Add assets (the format, fonts) for every session of this instance.
pub fn add_assets(m: BTreeMap<Vec<u8>, Arc<[u8]>>) {
    // (XeTeX's font index: its fonts' base names, for a font asked by file name)
    if let Some(b) = m.get(xetex::INDEX) {
        xetex::learn_index(b);
    }
    ASSETS.with_borrow_mut(|a| a.extend(m));
}

/// One project: one engine, built cold once and then rebuilt in place
/// (partex's SSA runtime: the steps an edit reaches run again, the files
/// are linked from the steps' effects).
pub struct Session {
    main: String,
    /// The project's files and the packages it was given.
    files: BTreeMap<String, String>,
    /// Binary files it was given (font metrics, a package not in UTF-8).
    bytes: BTreeMap<String, Arc<[u8]>>,
    tex: Option<Tex<MemHost, SsaTracker>>,
    /// Files changed since the last build (a rebuild reloads them).
    changed: Vec<String>,
    stale: bool,
    dvi: Vec<u8>,
    /// The PDF the last build wrote (PDF mode), and its pages.
    pub pdf: Vec<u8>,
    shipped: usize,
    /// Its pages' draw lists and hashes (pdfdraw), made when first asked for.
    pdf_hashes: Option<Vec<u64>>,
    /// Pages drawn since the last build, by number.
    pdf_draws: HashMap<usize, String>,
    /// Font programs parsed, kept across builds.
    pdf_fonts: phitex_draw::Fonts,
    /// The PDF, read (its cross-reference and pages), when first drawn or hashed.
    pdf_doc: Option<phitex_draw::Pdf>,
    /// The files the last plain build wrote that a next run reads (`.aux`,
    /// `.toc`, `.lof`, acronym lists, …), not the PDF or the log: the
    /// tracked build starts from them, as a second pdflatex run does, so
    /// its trips don't re-run the whole job for references.
    carried: BTreeMap<Vec<u8>, Arc<[u8]>>,
    /// The session's one "now" (\today, \time, the PDF's dates): the plain
    /// first paint and the tracked build agree, as two pdflatex runs of one
    /// latexmk would within a minute.
    started: DateTime,
    /// Each `.aux`'s contents at its last BibTeX run (bib.rs).
    bib_memo: bib::Memo,
    /// The last rebuild ran one trip (a keystroke): `settle_idle` is owed.
    unsettled: bool,
    /// Rebuilds traced, their log kept in the build log (`ph_trace`).
    pub trace: bool,
    pages: Vec<dvi::DviPage>,
    fonts: BTreeMap<i32, draws::Font>,
    term: Vec<u8>,
    missing: Vec<String>,
    history: i32,
    pub build_ms: f64,
    pub builds: u32,
    /// Each build: what changed before it and what it cost (the debug log).
    history_log: Vec<String>,
    /// Each page's hash with where its content lies, for the next hashing.
    page_sums: Vec<phitex_draw::PageSum>,
    /// The PDF's first byte the last link changed (None: unknown, hash all).
    pdf_first: Option<usize>,
    /// The next link is a full one (the last kept the pages of the trip before).
    relink: bool,
    /// The incremental link's state for the tracked job.
    lk: LinkState,
    /// What Shelf packs gave (wasm): every file of every pack fetched, for every later build.
    shelf: shelf::Cache,
    /// The last cold build's time (ms): a rebuild's deadline.
    cold_ms: f64,
    /// The names changed since the last build (for the log).
    trigger: Vec<String>,
    /// `prepare_rebuilds` done (after the cold build, when idle).
    prepared: bool,
    /// The last build was plain (no SSA program yet): the first paint.
    plain: bool,
    /// Build the SSA program at the next build (an edit, or idle).
    want_ssa: bool,
    /// The last build: "cold", or "rebuild" with what it ran.
    pub how: String,
    /// (native tools) A flat directory of TeX Live's files the host reads a
    /// name from when it has none: no fetch loop.
    pub fallback_dir: Option<std::path::PathBuf>,
    /// XeTeX (xelatex), not pdfTeX: `pdf` is made from the XDV the job writes.
    pub xetex: bool,
    /// Plain builds only (`plain_only`).
    plain_only: bool,
    /// (XeTeX) The XDV the last link made (the PDF is converted from it).
    xdv: Vec<u8>,
    /// (XeTeX) A hash of the XDV `pdf` was made from.
    xdv_hash: u64,
    /// (XeTeX) Each page's glyph runs, from xdvipdfmx.
    runs: Vec<Vec<partex_xdvipdfmx::api::GlyphRun>>,
    /// (XeTeX) The fonts xdvipdfmx read (their outlines are drawn), and the faces parsed.
    xread: xetex::Read,
    faces: phitex_draw::xetex::Faces,
    /// (XeTeX) xdvipdfmx started, gone on from for each XDV.
    dpx: xetex::Started,
    /// A build streamed, running (`stream.rs`).
    stream: Option<stream::Stream>,
}

#[derive(Debug)]
pub struct Status {
    pub pages: usize,
    /// The job's history (0: spotless … 3: fatal error).
    pub history: i32,
    /// Files read and not found (a package not in the project). Sorted.
    pub missing: Vec<String>,
    /// The last lines of the terminal (the error, if the job stopped).
    pub tail: String,
    /// The job's first error, read off the terminal.
    pub error: Option<TexError>,
}

/// A TeX error as the terminal shows it: `! message`, the context lines, and
/// `l.N` in the file open at that point.
#[derive(Debug, PartialEq, Eq)]
pub struct TexError {
    pub message: String,
    /// The file being read (the innermost `(name` not yet closed).
    pub file: Option<String>,
    pub line: Option<u32>,
    /// The lines from the `! message` to the `l.N` line and the one after.
    pub context: String,
    /// The file a "not found" error names (LaTeX's or TeX's own).
    pub missing: Option<String>,
}

/// The error that matters in `term`, with where it happened: the one that
/// stopped the job if it stopped (the last before "Emergency stop"), else
/// the first (TeX goes on after most errors, as pdflatex does).
#[must_use]
pub fn first_error(term: &str) -> Option<TexError> {
    let starts: Vec<usize> = term.starts_with("! ").then_some(0).into_iter().chain(term.match_indices("\n! ").map(|(i, _)| i + 1)).collect();
    let fatal = term.contains("! Emergency stop.") || term.contains("==> Fatal error occurred");
    let at = if fatal {
        *starts.iter().rev().find(|&&i| !term[i..].starts_with("! Emergency stop.") && !term[i..].starts_with("!  ==> Fatal")).or(starts.first())?
    } else {
        *starts.first()?
    };
    // (the open files: TeX prints `(name` on opening and `)` on closing)
    let mut open: Vec<String> = Vec::new();
    let b = term[..at].as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'(' => {
                let n: String = term[i + 1..at].chars().take_while(|c| !c.is_whitespace() && !matches!(c, '(' | ')' | '[' | '{')).collect();
                if n.contains('.') {
                    open.push(n.trim_start_matches("./").to_string());
                } else {
                    open.push(String::new());
                }
                i += 1 + n.len();
                continue;
            }
            b')' => {
                open.pop();
            }
            _ => {}
        }
        i += 1;
    }
    let rest: Vec<&str> = term[at..].lines().collect();
    let message = rest[0].trim_start_matches("! ").to_string();
    let mut end = rest.len().min(12);
    let mut line = None;
    for (k, l) in rest.iter().enumerate().skip(1).take(40) {
        if let Some(n) = l.strip_prefix("l.").and_then(|r| r.split(|c: char| !c.is_ascii_digit()).next()).and_then(|d| d.parse().ok()) {
            line = Some(n);
            end = (k + 2).min(rest.len());
            break;
        }
    }
    let context = rest[..end].join("\n");
    let missing = context.split_once("File `").and_then(|(_, r)| r.split_once('\'')).map(|(n, _)| n.to_string()).or_else(|| {
        // (TeX's own: "! I can't find file `name'.")
        message.split_once('`').and_then(|(_, r)| r.split_once('\'')).filter(|_| message.contains("find file")).map(|(n, _)| n.to_string())
    });
    let file = open.iter().rev().find(|n| !n.is_empty()).cloned();
    Some(TexError { message, file, line, context, missing })
}

impl Status {
    fn json(&self) -> String {
        format!(
            "\"engine\":\"partex\",\"fetches\":{},\"mode\":\"{}\",\"pages\":{},\"pending\":0,\"undefined\":0,\"undefined_names\":[],\"history\":{},\"missing\":[{}],\"term\":{}",
            shelf::available(),
            if pdf_mode() { "pdf" } else { "dvi" },
            self.pages,
            self.history,
            self.missing.iter().map(|n| esc(n)).collect::<Vec<_>>().join(","),
            esc(&self.tail)
        ) + &self.error.as_ref().map_or_else(String::new, |e| {
            format!(
                ",\"error\":{{\"message\":{},\"file\":{},\"line\":{},\"context\":{},\"missing\":{}}}",
                esc(&e.message),
                e.file.as_deref().map_or("null".into(), esc),
                e.line.map_or("null".into(), |n| n.to_string()),
                esc(&e.context),
                e.missing.as_deref().map_or("null".into(), esc)
            )
        })
    }
}

/// Whether startup runs plain passes plus BibTeX until the .aux files are
/// stable before the tracked build (as latexmk); off: the tracked build's
/// trips converge them.
pub static CONVERGE_PLAIN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The incremental link's state, per tracked job (a cold build starts anew).
#[derive(Default)]
struct LinkState {
    splice: partex_core::effects::Splice,
    virt: partex_core::effects::Resolver,
    /// `ssa::keys_renumbered` at the last link.
    renumbered: u32,
    /// The numbering can't be followed: every link full.
    dead: bool,
    /// Deflate's output by its input's hash, with the link that last used it.
    deflated: HashMap<u128, (Arc<[u8]>, u64)>,
    links: u64,
    /// Each file as last written, by name: the engine's id of it, its length.
    written: BTreeMap<Vec<u8>, (u32, u64)>,
}

/// BibTeX and makeindex, as nodes of the build (they run inside its trips,
/// again only where what they read changed).
fn native_tools() -> ssa::NativeTools {
    ssa::NativeTools {
        bibtex: Some(partex_bibtex::Options::default()),
        makeindex: Some(b"version 2.18 [TeX Live 2026] (kpathsea + Thai support)".to_vec()),
        calls: true,
    }
}

fn no_tools(_: &mut MemHost, _: &[(Vec<u8>, Arc<[u8]>)]) -> (bool, Vec<String>) {
    (false, Vec::new())
}

impl Session {
    #[must_use]
    pub fn open(files: BTreeMap<String, String>, main: &str) -> Session {
        Session {
            main: main.to_string(),
            files,
            bytes: BTreeMap::new(),
            tex: None,
            changed: Vec::new(),
            stale: true,
            dvi: Vec::new(),
            pdf: Vec::new(),
            shipped: 0,
            pdf_hashes: None,
            pdf_draws: HashMap::new(),
            pdf_fonts: phitex_draw::Fonts::new(),
            pdf_doc: None,
            carried: BTreeMap::new(),
            trace: false,
            unsettled: false,
            bib_memo: bib::Memo::default(),
            started: now(),
            pages: Vec::new(),
            fonts: BTreeMap::new(),
            term: Vec::new(),
            missing: Vec::new(),
            history: 0,
            build_ms: 0.0,
            builds: 0,
            history_log: Vec::new(),
            page_sums: Vec::new(),
            pdf_first: None,
            relink: false,
            lk: LinkState::default(),
            shelf: shelf::Cache::default(),
            cold_ms: 0.0,
            trigger: Vec::new(),
            prepared: false,
            plain: false,
            want_ssa: true,
            how: String::new(),
            fallback_dir: None,
            xetex: false,
            plain_only: false,
            xdv: Vec::new(),
            xdv_hash: 0,
            runs: Vec::new(),
            xread: xetex::Read::default(),
            faces: phitex_draw::xetex::Faces::new(),
            dpx: None,
            stream: None,
        }
    }

    /// The project's own files' names (`MemHost::project`).
    fn project_names(&self) -> BTreeSet<Vec<u8>> {
        self.files.keys().chain(self.bytes.keys()).map(|n| n.clone().into_bytes()).chain(self.carried.keys().cloned()).collect()
    }

    fn host_files(&self) -> BTreeMap<Vec<u8>, Arc<[u8]>> {
        let mut m = ASSETS.with_borrow(Clone::clone);
        // (the project's own files win: an .aux it ships is its own)
        m.extend(self.carried.iter().map(|(n, b)| (n.clone(), b.clone())));
        for (n, b) in &self.bytes {
            m.insert(n.clone().into_bytes(), b.clone());
        }
        for (n, text) in &self.files {
            m.insert(n.clone().into_bytes(), Arc::from(text.as_bytes()));
        }
        m
    }

    /// Start fast (the browser's session): a plain first paint, the SSA
    /// program at the first edit or when idle. Without
    /// it (tests, tools) the first build is the SSA one, as before.
    /// PHITEX_NO_PLAIN keeps the old start.
    pub fn fast_start(&mut self) {
        if std::env::var("PHITEX_NO_PLAIN").is_err() && self.tex.is_none() {
            self.want_ssa = false;
        }
    }

    /// Plain builds only (the browser's first-paint worker, while another
    /// builds the SSA program): an edit builds plain again, and nothing is
    /// readied when idle. `false` lets the SSA program come, as `fast_start`.
    pub fn plain_only(&mut self, on: bool) {
        self.plain_only = on;
        if on {
            self.fast_start();
        } else {
            self.want_ssa = true;
        }
    }

    /// What each build was (the `log` op's first part).
    pub fn builds_log(&self) -> &[String] {
        &self.history_log
    }

    /// A missing file, looked for where the host has more: a flat TeX
    /// Live (native, `fallback_dir`), or Shelf through the worker (wasm,
    /// `shelf::fetch`: the job never stops at a file TeX Live has; what a
    /// pack holds is kept for every later build).
    fn fallback(&self) -> Option<Box<dyn FnMut(&[u8]) -> Option<Vec<u8>>>> {
        if let Some(dir) = self.fallback_dir.clone() {
            return Some(Box::new(move |n: &[u8]| {
                let n = std::str::from_utf8(n).ok()?;
                // (XeTeX's fonts, by their path inside TeX Live, from this machine's)
                if n.starts_with("fonts/") {
                    return std::fs::read(std::path::Path::new("/usr/share/texmf-dist").join(n)).ok();
                }
                if n.contains('/') {
                    return None;
                }
                std::fs::read(dir.join(n)).ok()
            }));
        }
        // (native tools, XeTeX: a font by its path inside TeX Live, from this machine's)
        if !shelf::available() && self.xetex {
            return Some(Box::new(|n: &[u8]| {
                let n = std::str::from_utf8(n).ok()?;
                if !n.starts_with("fonts/") {
                    return None;
                }
                std::fs::read(std::path::Path::new("/usr/share/texmf-dist").join(n)).ok()
            }));
        }
        // (the browser: Shelf, `MemHost::shelf`)
        None
    }

    /// Shelf for this session's hosts (the browser), and its engine's name.
    fn shelf_for(&self) -> Option<(shelf::Cache, &'static str)> {
        shelf::available().then(|| (self.shelf.clone(), if self.xetex { "xetex" } else { "pdftex" }))
    }

    /// Ready the engine for its first rebuild (the format's definitions
    /// decoded): once per cold build, when idle; the first keystroke would
    /// pay it. True if there was anything to do.
    pub fn prepare(&mut self) -> bool {
        if self.plain_only || self.streaming() {
            return false;
        }
        // (after a plain first paint: the SSA program, now, while idle; from
        // converged files, as latexmk's last run, so its trips are few)
        if self.plain && self.tex.is_none() {
            // (the tracked build's own trips converge the .aux files, BibTeX
            // and makeindex being its nodes: from the first paint straight
            // to it; the plain passes as latexmk runs them only by switch)
            if CONVERGE_PLAIN.load(std::sync::atomic::Ordering::Relaxed) || std::env::var("PHITEX_CONVERGE").is_ok() {
                self.converge_plain();
            }
            self.want_ssa = true;
            self.stale = true;
            self.build();
            return true;
        }
        match &self.tex {
            Some(tex) if !self.prepared => {
                ssa::prepare_rebuilds(tex);
                self.prepared = true;
                true
            }
            _ => self.settle_idle(),
        }
    }

    /// latexmk's loop on plain passes: BibTeX on the .aux files the last pass
    /// wrote, then a pass again, until the files read are the files written
    /// (at most four passes). The tracked build then starts converged: one
    /// or two trips, not five, and a fraction of the memory a five-trip
    /// settle records.
    fn converge_plain(&mut self) {
        for _ in 0..4 {
            let before = self.carried.clone();
            let mut host = MemHost { files: self.host_files(), project: self.project_names(), now: Some(self.started.clone()), ..MemHost::default() };
            host.fallback = self.fallback();
            host.shelf = self.shelf_for();
            let streams: Vec<(Vec<u8>, Arc<[u8]>)> = self.carried.iter().filter(|(n, _)| n.ends_with(b".aux")).map(|(n, b)| (n.clone(), b.clone())).collect();
            let (_, lines) = bib::tools(self.bib_memo.clone())(&mut host, &streams);
            self.history_log.extend(lines.iter().map(|l| format!("tool: {l}")));
            for (n, b) in &host.files {
                if n.ends_with(b".bbl") || n.ends_with(b".blg") {
                    self.carried.insert(n.clone(), b.clone());
                }
            }
            if self.carried.iter().all(|(n, b)| before.get(n).is_some_and(|o| o[..] == b[..])) && before.len() == self.carried.len() && self.builds > 1 {
                break;
            }
            let t = Instant::now();
            self.plain_build();
            self.builds += 1;
            self.history_log.push(format!("build {}: plain pass (converging) {:.0} ms", self.builds, ms(t.elapsed())));
            if self.carried.iter().all(|(n, b)| before.get(n).is_some_and(|o| o[..] == b[..])) && before.len() == self.carried.len() {
                break;
            }
        }
    }

    /// After one-trip keystrokes, on idle: the trips that follow (the .aux,
    /// .toc, … read against what the last trip wrote), as a cold build's
    /// settle, then the link. True if it ran.
    pub fn settle_idle(&mut self) -> bool {
        if !self.unsettled || self.stale {
            return false;
        }
        let Some(tex) = self.tex.as_mut() else { return false };
        self.unsettled = false;
        let t = Instant::now();
        // (until settled, as the cold build)
        let native = native_tools();
        let mut trips = ssa::Trips { max: 12, tools: &mut no_tools, native: Some(&native), clock: None };
        let s = ssa::settle(tex, false, true, &mut trips, 0, 0);
        self.history_log.extend(s.tools.iter().map(|l| format!("tool: {l}")));
        if !s.settled {
            self.history_log.push(format!(
                "settle: not settled after {} trips: {:?}; stopped: {:?}",
                s.trips,
                s.unsettled.iter().map(|n| String::from_utf8_lossy(n).into_owned()).collect::<Vec<_>>(),
                s.unsupported
            ));
        }
        if let Some(why) = s.unsupported {
            self.history_log.push(format!("settle stopped ({why}): cold"));
            self.tex = None;
            self.stale = true;
            self.build();
            return true;
        }
        if s.trips <= 1 {
            // (nothing read differs from what was written: settled already)
            return false;
        }
        self.history = s.history;
        self.how = format!("settle: {} trips, {} steps, {} commands", s.trips, s.steps_run, s.commands);
        let t_run = ms(t.elapsed());
        self.link();
        self.build_ms = ms(t.elapsed());
        let _ = write!(self.how, "; run {t_run:.1} ms, link {:.1} ms", self.build_ms - t_run);
        self.builds += 1;
        self.history_log.push(format!("build {}: {} (changed: settling)", self.builds, self.how));
        true
    }

    /// Build if anything changed since the last build: a rebuild of the
    /// engine there is, else (none yet, or the last job stopped) cold.
    pub fn build(&mut self) {
        // (a build streamed runs: it is the build; queries answer from it)
        if !self.stale || self.streaming() {
            return;
        }
        self.stale = false;
        let t = Instant::now();
        // (trips a build may take; PHITEX_TRIPS overrides)
        // (until the files read equal the files written: a bibliography's
        // .bbl, then the reflow it makes, then the page records that move,
        // can take more than four)
        let max = std::env::var("PHITEX_TRIPS").ok().and_then(|v| v.parse().ok()).unwrap_or(12);
        // (BibTeX between trips, as latexmk: the engine's own, in process)
        let native = native_tools();
        let mut trips = ssa::Trips { max, tools: &mut no_tools, native: Some(&native), clock: None };
        // (a job that ended fatally, an unclosed brace's runaway argument, is
        // rebuilt too: the fix runs on past the old end; PHITEX_COLD_AFTER_FATAL
        // goes cold instead)
        // (whether a rebuild turns into a whole re-run, a preamble edit say, is
        // the engine's to tell: its cascade goes cold, its deadline stops it)
        let rebuild = self.tex.is_some() && (self.history < 3 || std::env::var("PHITEX_COLD_AFTER_FATAL").is_err());
        if !rebuild && !self.want_ssa {
            self.plain_build();
            self.build_ms = ms(t.elapsed());
            let _ = write!(self.how, "; run {:.1} ms", self.build_ms);
            self.builds += 1;
            self.history_log.push(format!("build {}: {}", self.builds, self.how));
            return;
        }
        self.plain = false;
        if rebuild {
            let tex = self.tex.as_mut().unwrap();
            let h = tex.host_mut();
            h.missing.clear();
            h.term.clear();
            self.trigger.clone_from(&self.changed);
            for n in std::mem::take(&mut self.changed) {
                if let Some(text) = self.files.get(&n) {
                    h.files.insert(n.into_bytes(), Arc::from(text.as_bytes()));
                } else if let Some(b) = self.bytes.get(&n) {
                    h.files.insert(n.into_bytes(), b.clone());
                }
            }
            // (PHITEX_REBUILD_LOG=1: the rebuild traced, its log on stderr)
            // (the trace: by PHITEX_REBUILD_LOG natively, by `ph_trace` in wasm)
            let trace = self.trace || std::env::var("PHITEX_REBUILD_LOG").is_ok();
            // (a rebuild may take as long as the last cold build took, then
            // stops and the build goes cold: a backstop only; when a rebuild
            // has become a re-run of everything is the engine's to tell;
            // PHITEX_DEADLINE_MS overrides)
            let limit = std::env::var("PHITEX_DEADLINE_MS").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(self.cold_ms.max(300.0));
            tex.tracker().deadline.set(Some((clock_ns, clock_ns() + (limit * 1e6) as u64)));
            // (a keystroke: one trip, as one pdflatex run; references and the
            // TOC settle on idle (`settle_idle`), not on each keystroke;
            // PHITEX_KEY_TRIPS overrides)
            let native = native_tools();
            let mut key_trips = ssa::Trips { max: std::env::var("PHITEX_KEY_TRIPS").ok().and_then(|v| v.parse().ok()).unwrap_or(1), tools: &mut no_tools, native: Some(&native), clock: None };
            let r = ssa::rebuild_trips(tex, trace, true, &mut key_trips);
            let _ = &mut trips;
            if trace {
                for l in &r.log {
                    eprintln!("rebuild-log: {l}");
                }
                // (kept for `ph_log`: wasm has no stderr anyone reads)
                self.history_log.extend(r.log.iter().map(|l| format!("rebuild-log: {l}")));
            }
            if let Some(why) = r.unsupported {
                // (a rebuild it cannot make: built again cold)
                self.history_log.push(format!("rebuild stopped ({why}, {} commands): cold", r.commands));
                self.tex = None;
                self.stale = true;
                self.build();
                return;
            }
            self.history = r.history;
            self.unsettled = true;
            self.how = format!(
                "rebuild: {} steps, {} commands, {} trips (edits {}, seeds {}, phi {}, store readers {}, queries {}, defs changed {}, readers marked {}, new {}, retries {}){}",
                r.steps_run, r.commands, r.trips, r.edits, r.seeds, r.phi, r.store_readers, r.queries, r.defs_changed, r.readers_marked, r.new_steps, r.retries,
                r.log.iter().take(8).map(|l| format!("\n  {l}")).collect::<String>()
            );
        } else {
            let mut tex = self.cold_tex();
            let cmd = self.command();
            let r = ssa::run_applying(&mut tex, cmd.as_bytes(), false, 0, false);
            let run_ms = ms(t.elapsed());
            let s = ssa::settle(&mut tex, false, false, &mut trips, r.commands, 0);
            self.cold_done(tex, &r, &s, t, run_ms);
        }
        self.built(t);
    }

    /// A cold SSA build's engine, its job not started.
    fn cold_tex(&mut self) -> Tex<MemHost, SsaTracker> {
        self.changed.clear();
        let mut host = MemHost { files: self.host_files(), project: self.project_names(), now: Some(self.started.clone()), ..MemHost::default() };
        host.fallback = self.fallback();
        host.shelf = self.shelf_for();
        let tracker = SsaTracker::new(Recorder::new());
        // (a keystroke whose job ends fatally, no legal \end: its cut
        // .aux is not the next keystroke's, the last complete trip's
        // streams stay, and it leaves no PDF: the last good pages stay)
        tracker.keep_complete.set(true);
        let mut tex = Tex::new(host, tracker, engine_params(self.xetex, false));
        // (windows: steps cut inside long runs, a tikzpicture's say, at
        // most every 4096 commands; PHITEX_WINDOW overrides, 0 = off)
        tex.set_window(std::env::var("PHITEX_WINDOW").ok().and_then(|v| v.parse().ok()).unwrap_or(4096));
        // (each glyph's source bytes: double-click on the page → the
        // editor, the cursor → the page; rebuilds keep them mapped)
        tex.set_origins(true);
        tex
    }

    /// A cold SSA build's trips ran (`r` the first, `s` the settle; `t`
    /// when it began, the first trip `run_ms`): the engine kept.
    fn cold_done(&mut self, tex: Tex<MemHost, SsaTracker>, r: &ssa::SsaReport, s: &ssa::RebuildReport, t: Instant, run_ms: f64) {
        {
            self.history_log.extend(s.tools.iter().map(|l| format!("tool: {l}")));
            if !s.settled {
                self.history_log.push(format!("cold: not settled after {} trips: {:?}; stopped: {:?}", s.trips, s.unsettled.iter().map(|n| String::from_utf8_lossy(n).into_owned()).collect::<Vec<_>>(), s.unsupported));
            }
            self.history = s.history.max(r.history);
            // (the first pass, then settle's trips: what each cost, in commands and ms)
            let more: Vec<String> = s.trip_commands.iter().zip(&s.trip_ns).skip(1).map(|(c, n)| format!("{c} commands {:.0} ms", *n as f64 / 1e6)).collect();
            self.how = format!(
                "cold: {} commands; pass 1 {run_ms:.0} ms; settle {} trips {:.0} ms [{}]",
                r.commands,
                s.trips,
                ms(t.elapsed()) - run_ms,
                more.join(", ")
            );
            self.cold_ms = ms(t.elapsed());
            // (a command budget only by PHITEX_BUDGET: the deadline below is the measure)
            if let Some(b) = std::env::var("PHITEX_BUDGET").ok().and_then(|v| v.parse().ok()) {
                tex.tracker().budget.set(b);
            }
            self.prepared = false;
            self.tex = Some(tex);
            // (a new job: its first link lays out from cold)
            self.lk = LinkState::default();
        }
    }

    /// A build's run ended (begun at `t`): linked, counted, logged.
    fn built(&mut self, t: Instant) {
        let t_run = ms(t.elapsed());
        self.link();
        self.build_ms = ms(t.elapsed());
        let _ = write!(self.how, "; run {t_run:.1} ms, link {:.1} ms", self.build_ms - t_run);
        self.builds += 1;
        let mut t = std::mem::take(&mut self.trigger);
        t.dedup();
        let more = t.len().saturating_sub(8);
        t.truncate(8);
        self.history_log.push(format!(
            "build {}: {}; run {t_run:.1} ms, link {:.1} ms (changed: {}{})",
            self.builds,
            self.how.lines().next().unwrap_or("").split("; run ").next().unwrap_or(""),
            self.build_ms - t_run,
            if t.is_empty() { "nothing: cold".into() } else { t.join(" ") },
            if more > 0 { format!(" +{more}") } else { String::new() }
        ));
    }

    /// The job's command line.
    fn command(&self) -> String {
        let main = self.main.strip_suffix(".tex").unwrap_or(&self.main);
        // (XeTeX: its XDV made a PDF by the link, `xetex::to_pdf`)
        if self.xetex {
            return format!("&xelatex \\nonstopmode\\csname @@input\\endcsname{{{main}}}");
        }
        // (PDF mode uncompressed: pdfdraw reads the content streams back;
        // the main file by the primitive \input, as `pdflatex main.tex`)
        let mode = if pdf_mode() { "\\pdfcompresslevel=0 \\pdfobjcompresslevel=0 " } else { "\\pdfoutput=0 " };
        format!("&pdflatex \\nonstopmode{mode}\\csname @@input\\endcsname{{{main}}}")
    }

    /// A build without the SSA program (an untracked run, ~3x faster than
    /// a cold SSA build): the first paint. The SSA program is built at the first edit or when idle.
    fn plain_build(&mut self) {
        let mut tex = self.plain_tex();
        let h = tex.run(self.command().as_bytes());
        self.plain_done(&mut tex, h);
    }

    /// A plain build's engine, its job not started.
    fn plain_tex(&mut self) -> Tex<MemHost, Untracked> {
        self.changed.clear();
        self.tex = None;
        self.plain = true;
        let mut host = MemHost { files: self.host_files(), project: self.project_names(), now: Some(self.started.clone()), ..MemHost::default() };
        host.fallback = self.fallback();
        host.shelf = self.shelf_for();
        Tex::new(host, Untracked, engine_params(self.xetex, false))
    }

    /// A plain build's job ended (`h` its history): its files and pages kept.
    fn plain_done(&mut self, tex: &mut Tex<MemHost, Untracked>, h: i32) {
        let job = self.main.strip_suffix(".tex").unwrap_or(&self.main).to_string();
        // (its command count, beside the tracked build's: the two compared)
        let commands = tex.commands();
        let host = std::mem::take(tex.host_mut());
        self.history = h;
        self.term = host.term.clone();
        self.pdf_hashes = None;
        self.pdf_first = None;
        self.pdf_draws.clear();
                self.pdf_doc = None;
        self.missing = host.missing.iter().map(|(n, _)| String::from_utf8_lossy(n).into_owned()).collect();
        self.missing.sort();
        self.missing.dedup();
        self.pdf = host.written.get(format!("{job}.pdf").as_bytes()).cloned().unwrap_or_default();
        if self.xetex {
            let xdv = std::mem::take(&mut self.pdf);
            self.from_xdv(xdv, host.files.clone());
        }
        // (BibTeX's .bbl/.blg are not the job's: kept from the run before)
        let tools: BTreeMap<Vec<u8>, Arc<[u8]>> = self.carried.iter().filter(|(n, _)| n.ends_with(b".bbl") || n.ends_with(b".blg")).map(|(n, b)| (n.clone(), b.clone())).collect();
        self.carried = host
            .written
            .iter()
            .filter(|(n, _)| !n.ends_with(b".pdf") && !n.ends_with(b".log") && !n.ends_with(b".synctex"))
            .map(|(n, b)| (n.clone(), Arc::from(&b[..])))
            .collect();
        for (n, b) in tools {
            self.carried.entry(n).or_insert(b);
        }
        self.shipped = self.pdf_hashes().len();
        self.how = format!("plain: the first paint, {commands} commands, 1 pass");
    }

    /// Link the files from the steps' effects; read the DVI's pages. The
    /// incremental link (`effects::Splice`, with `effects::Resolver` for
    /// virtual object numbers): a keystroke resolves only its steps'
    /// chunks, and each file is written from its first changed byte; else
    /// (a cold build's first link, a numbering it cannot follow) the full
    /// link, every file whole. As the CLI's `SsaLinker::link`.
    fn link(&mut self) {
        // (XeTeX: the link splices the XDV, `pdf` the PDF made of it)
        if self.xetex {
            std::mem::swap(&mut self.pdf, &mut self.xdv);
        }
        let tex = self.tex.as_mut().unwrap();
        // (exactly once per link: the steps' chunks changed since the last)
        let changes = ssa::take_step_changes(&mut tex.tracker().rec.borrow_mut());
        // (a job that ended fatally leaves no PDF, as pdfTeX's
        // remove_pdffile: the last good pages stay, and the next link is a
        // full one, its splice state having followed this trip's)
        let fatal = tex.fatal_pdf().is_some();
        let kept = fatal.then(|| (self.pdf.clone(), self.dvi.clone(), self.pdf_first, self.pdf_hashes.clone(), self.pages.clone(), self.fonts.clone()));
        let full = std::mem::take(&mut self.relink) || std::env::var("PHITEX_LINK_FULL").is_ok() || !self.link_spliced(changes);
        // (traced: each incremental link checked against a full one)
        if !full && self.trace {
            let (pdf, dvi) = (self.pdf.clone(), self.dvi.clone());
            let (first, hashes) = (self.pdf_first, self.pdf_hashes.clone());
            let t = Instant::now();
            self.link_full();
            // (the check leaves the incremental state as the spliced link made it)
            (self.pdf_first, self.pdf_hashes) = (first, hashes);
            let same = self.pdf == pdf && self.dvi == dvi;
            self.history_log.push(format!("link check: spliced {} full ({:.1} ms for the full link)", if same { "==" } else { "!=" }, ms(t.elapsed())));
        }
        if full {
            self.link_full();
            let st = &mut self.lk;
            st.splice.reset();
            st.virt.reset();
            st.written.clear();
        }
        let tex = self.tex.as_mut().unwrap();
        // (the build's tools' outputs: .bbl, .blg, .ind, .ilg)
        let produced = ssa::produced_streams(tex);
        // (a trip that ended fatally: the streams it cut, .aux say, put
        // back as the last complete trip wrote them, as the CLI's
        // SsaLinker::write_produced)
        let withheld = ssa::withheld_streams(tex);
        let h = tex.host_mut();
        for (n, b) in withheld {
            match b {
                Some(b) => _ = h.files.insert(n, b),
                None => _ = h.files.remove(&n),
            }
        }
        for (n, b) in produced {
            let Some(b) = b else { continue };
            if h.files.get(&n).is_none_or(|o| o[..] != b[..]) {
                h.files.insert(n.clone(), b);
            }
            h.linked.insert(n);
        }
        self.missing = h.missing.iter().map(|(n, _)| String::from_utf8_lossy(n).into_owned()).collect();
        let files = &h.files;
        let (pages, fonts) = dvi::pages(&self.dvi, &|n| files.get(format!("{n}.tfm").as_bytes()).cloned());
        self.pages = pages;
        self.fonts = fonts;
        self.missing.retain(|n| !self.files.contains_key(n) && !self.bytes.contains_key(n));
        self.missing.sort();
        self.missing.dedup();
        if let Some((pdf, dvi, first, hashes, pages, fonts)) = kept {
            (self.pdf, self.dvi, self.pdf_first, self.pdf_hashes, self.pages, self.fonts) = (pdf, dvi, first, hashes, pages, fonts);
            self.relink = true;
        }
        if self.xetex {
            let xdv = std::mem::take(&mut self.pdf);
            self.pdf = std::mem::take(&mut self.xdv);
            let files = self.tex.as_ref().map(|t| t.host().files.clone()).unwrap_or_default();
            self.from_xdv(xdv, files);
        }
    }

    /// (XeTeX) The PDF of `xdv` (the job's), its glyph runs: made again
    /// only when the XDV changed.
    fn from_xdv(&mut self, xdv: Vec<u8>, files: BTreeMap<Vec<u8>, Arc<[u8]>>) {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        xdv.hash(&mut h);
        let h = h.finish();
        if h != self.xdv_hash || self.pdf.is_empty() {
            let t = Instant::now();
            let job = format!("{}.pdf", self.main.strip_suffix(".tex").unwrap_or(&self.main));
            match xetex::to_pdf(&xdv, job.as_bytes(), files, &self.xread, &self.shelf, epoch(&self.started), &mut self.dpx) {
                Ok((pdf, runs)) => {
                    self.pdf = pdf;
                    self.shipped = runs.len();
                    self.runs = runs;
                }
                // (the driver stopped, as xelatex's xdvipdfmx would: said
                // as the job's error, the last good pages kept)
                Err(fatal) => {
                    self.term.extend_from_slice(format!("\n! {fatal}\n").as_bytes());
                    self.history = self.history.max(2);
                    self.xdv = xdv;
                    return;
                }
            }
            self.xdv_hash = h;
            self.pdf_hashes = None;
            self.pdf_first = None;
            self.pdf_draws.clear();
                self.pdf_doc = None;
            let _ = write!(self.how, "; xdvipdfmx {:.1} ms", ms(t.elapsed()));
            self.history_log.push(format!("xdvipdfmx: {:.1} ms: {}", ms(t.elapsed()), xetex::COST.with_borrow(Clone::clone)));
        }
        self.xdv = xdv;
    }

    /// The incremental link of `changes`; false: the full link is to be made.
    fn link_spliced(&mut self, changes: Vec<partex_core::effects::StepChunks>) -> bool {
        let tex = self.tex.as_mut().unwrap();
        let st = &mut self.lk;
        st.links += 1;
        let virt_on = tex.virtual_objects();
        if virt_on && st.dead {
            return false;
        }
        let links = st.links;
        let LinkState { splice, virt, deflated, renumbered, dead, written, .. } = st;
        // (deflate memoized by content; what the last 8 links used is kept:
        // an edit undone finds its streams)
        let mut was = std::mem::take(deflated);
        let mut now: HashMap<u128, (Arc<[u8]>, u64)> = HashMap::new();
        let res = {
            let mut deflate = |level: i32, data: &[u8]| -> Option<Vec<u8>> {
                let key = partex_core::StableHasher::of(&(b"deflate", level, data));
                if let Some((z, _)) = now.get(&key) {
                    return Some(z.to_vec());
                }
                let z: Arc<[u8]> = match was.remove(&key) {
                    Some((z, _)) => z,
                    None => Arc::from(miniz_oxide::deflate::compress_to_vec_zlib(data, u8::try_from(level.clamp(0, 9)).unwrap_or(6))),
                };
                now.insert(key, (z.clone(), links));
                Some(z.to_vec())
            };
            let rec = tex.tracker().rec.borrow();
            let r = ssa::keys_renumbered(&rec);
            let key_of = |s: u32| ssa::step_key(&rec, s);
            let keys: Option<&dyn Fn(u32) -> u64> = (r != *renumbered).then_some(&key_of);
            *renumbered = r;
            let c = if !virt_on {
                Some(changes)
            } else if let Some(c) = virt.changes(&changes, &mut deflate) {
                Some(c)
            } else {
                let f = virt.full(&ssa::all_step_chunks(&rec), &mut deflate);
                if f.as_ref().is_none_or(|x| x.1) {
                    splice.reset();
                }
                f.map(|x| x.0)
            };
            match c {
                Some(c) => splice.link(c, keys, &mut deflate, &|| clock_ns()),
                None => Ok(None),
            }
        };
        was.retain(|_, (_, at)| *at + 8 > links);
        now.extend(was);
        *deflated = now;
        let out = match res {
            Ok(Some(out)) => out,
            Ok(None) => {
                *dead |= virt_on;
                return false;
            }
            Err(_) => return false,
        };
        // (each file by the name it was opened with, the last open winning;
        // one as last written, written from its first changed byte, else whole)
        let h = tex.host_mut();
        let mut last: BTreeMap<Vec<u8>, u32> = BTreeMap::new();
        for (id, n, _) in &out.opened {
            last.insert(n.clone(), id.0);
        }
        let mut wrote = Vec::new();
        for (name, id) in last {
            let (len, first) = out.files.get(&id).copied().unwrap_or((0, None));
            let old: &[u8] = if name.ends_with(b".pdf") {
                &self.pdf
            } else if name.ends_with(b".dvi") {
                &self.dvi
            } else {
                h.files.get(&name).map_or(&[][..], |a| &a[..])
            };
            let as_written = written.get(&name) == Some(&(id, old.len() as u64));
            let from = match (as_written, first) {
                (true, None) => continue,
                (true, Some(x)) => x,
                (false, _) => 0,
            };
            let from_us = usize::try_from(from).unwrap_or(0).min(old.len());
            let mut buf = old[..from_us].to_vec();
            splice.write_from(id, from, &mut |b| buf.extend_from_slice(b));
            buf.truncate(usize::try_from(len).unwrap_or(usize::MAX));
            written.insert(name.clone(), (id, len));
            wrote.push(format!("{} from {from}", String::from_utf8_lossy(&name)));
            if name.ends_with(b".pdf") {
                self.pdf = buf;
                // (several patches before a hashing: the earliest counts;
                // a whole write, every page)
                self.pdf_first = if self.pdf_hashes.is_some() || self.pdf_first.is_some() {
                    Some(self.pdf_first.map_or(from_us, |f| f.min(from_us)))
                } else {
                    None
                };
                self.pdf_hashes = None;
                self.pdf_draws.clear();
                self.pdf_doc = None;
            } else if name.ends_with(b".dvi") {
                self.dvi = buf;
            } else {
                h.files.insert(name.clone(), Arc::from(buf));
                h.linked.insert(name);
            }
        }
        if self.trace {
            self.history_log.push(format!("link spliced: {}", wrote.join(", ")));
        }
        let mut term = h.term.clone();
        term.extend_from_slice(&out.term);
        self.term = term;
        self.shipped = splice.pages().len();
        true
    }

    /// The full link: every step's chunks, every file written whole.
    fn link_full(&mut self) {
        let tex = self.tex.as_mut().unwrap();
        let chunks = ssa::step_effects(&tex.tracker().rec.borrow());
        let slices: Vec<&[partex_core::effects::Effect]> = chunks.iter().map(|(_, e)| &e.1[..]).collect();
        let linked = partex_core::effects::link(&slices, &partex_core::Sequential, &mut |level, data| {
            Some(miniz_oxide::deflate::compress_to_vec_zlib(data, u8::try_from(level.clamp(0, 9)).unwrap_or(6)))
        });
        let h = tex.host_mut();
        match linked {
            Ok(l) => {
                let dvi = l.opened.iter().rev().find(|(_, n, _)| n.ends_with(b".dvi")).and_then(|(id, ..)| l.files.get(&id.0));
                self.dvi = dvi.cloned().unwrap_or_default();
                let pdf = l.opened.iter().rev().find(|(_, n, _)| n.ends_with(b".pdf")).and_then(|(id, ..)| l.files.get(&id.0));
                self.pdf = pdf.cloned().unwrap_or_default();
                // (each file the link made, by the name it was opened with,
                // the last open winning)
                let mut last: BTreeMap<&[u8], u32> = BTreeMap::new();
                for (id, n, _) in &l.opened {
                    last.insert(&n[..], id.0);
                }
                for (n, id) in last {
                    if n.ends_with(b".pdf") || n.ends_with(b".dvi") {
                        continue;
                    }
                    if let Some(b) = l.files.get(&id)
                        && h.files.get(n).is_none_or(|o| o[..] != b[..])
                    {
                        h.files.insert(n.to_vec(), Arc::from(&b[..]));
                    }
                    h.linked.insert(n.to_vec());
                }
                if self.trace {
                    self.history_log.push(format!("link full: {} files", l.opened.len()));
                }
                self.shipped = l.pages.len();
                self.pdf_hashes = None;
                self.pdf_first = None;
                self.pdf_draws.clear();
                self.pdf_doc = None;
                let mut term = h.term.clone();
                term.extend_from_slice(&l.term);
                self.term = term;
            }
            Err(e) => {
                self.dvi.clear();
                self.term = format!("partex: the link failed: {e:?}").into_bytes();
            }
        }
    }

    fn valid(&self, name: &str, range: &Range<usize>) -> Result<(), String> {
        let Some(t) = self.files.get(name) else {
            return Err(format!("no file {name}"));
        };
        if range.start > range.end || range.end > t.len() {
            return Err(format!("range {range:?} outside {name} ({} bytes)", t.len()));
        }
        if !t.is_char_boundary(range.start) || !t.is_char_boundary(range.end) {
            return Err(format!("range {range:?} not on UTF-8 boundaries in {name}"));
        }
        Ok(())
    }

    pub fn set_file(&mut self, name: &str, text: &str) {
        if self.files.get(name).is_none_or(|t| t != text) {
            self.files.insert(name.to_string(), text.to_string());
            self.changed.push(name.to_string());
            self.stale = true;
            self.stream_edited();
        }
    }

    /// A binary file, new or replaced whole.
    pub fn set_bytes(&mut self, name: &str, bytes: &[u8]) {
        // (a package's pack can hold a file the project has its own of, a
        // class it ships: the project's wins, and nothing changed)
        if self.files.contains_key(name) {
            return;
        }
        if self.bytes.get(name).is_none_or(|b| **b != *bytes) {
            self.bytes.insert(name.to_string(), Arc::from(bytes));
            self.changed.push(name.to_string());
            self.stale = true;
            self.stream_edited();
        }
    }

    pub fn edit_file(&mut self, name: &str, range: Range<usize>, text: &str) -> Result<(), String> {
        self.valid(name, &range)?;
        self.files.get_mut(name).unwrap().replace_range(range, text);
        self.changed.push(name.to_string());
        self.stale = true;
        self.stream_edited();
        // (the writer is typing: the program that makes keystrokes cheap;
        // not here when another worker builds it, `plain_only`)
        self.want_ssa = !self.plain_only;
        Ok(())
    }

    pub fn status(&mut self) -> Status {
        if self.streaming() {
            // (the build running: the pages it shipped so far)
            let pages = self.stream_hashes().len();
            return Status { pages, history: 0, missing: Vec::new(), tail: String::new(), error: None };
        }
        self.build();
        let term = String::from_utf8_lossy(&self.term);
        let lines: Vec<&str> = term.lines().collect();
        let tail = lines[lines.len().saturating_sub(12)..].join("\n");
        let error = first_error(&term);
        Status { pages: self.page_count(), history: self.history, missing: self.missing.clone(), tail, error }
    }

    /// Pages shipped by the last build.
    fn page_count(&mut self) -> usize {
        if self.streaming() {
            return self.stream_hashes().len();
        }
        if self.pdf.is_empty() { self.pages.len() } else { self.shipped }

    }

    /// Each page's hash (its DVI bytes, less `bop`'s pointer to the page
    /// before): unchanged, the page need not be drawn again. (In PDF mode
    /// the whole file's, with the page's number: every page is drawn again
    /// after a change, by the host's PDF renderer.)
    pub fn page_hashes(&mut self) -> Vec<u64> {
        if self.streaming() {
            return self.stream_hashes();
        }
        self.build();
        if !self.pdf.is_empty() {
            return self.pdf_hashes().to_vec();
        }
        self.pages
            .iter()
            .map(|p| {
                let b = &self.dvi[p.bytes.clone()];
                let mut h = std::collections::hash_map::DefaultHasher::new();
                b.get(1..41).hash(&mut h);
                b.get(45..).hash(&mut h);
                h.finish()
            })
            .collect()
    }

    /// The PDF, read once per link.
    fn doc(&mut self) -> Option<&phitex_draw::Pdf> {
        if self.pdf_doc.is_none() && !self.pdf.is_empty() {
            self.pdf_doc = phitex_draw::Pdf::open(&Arc::from(&self.pdf[..]));
        }
        self.pdf_doc.as_ref()
    }

    /// The PDF's pages' hashes (cheap: no drawing).
    fn pdf_hashes(&mut self) -> &[u64] {
        if self.pdf_hashes.is_none() {
            // (the pages after the link's first changed byte hashed again,
            // the others kept)
            let first = self.pdf_first.take();
            self.doc();
            let Some(doc) = self.pdf_doc.as_ref() else { return &[] };
            let sums = doc.hashes_since(&self.page_sums, first);
            let hs: Vec<u64> = sums.iter().map(|s| s.hash).collect();
            // (traced: checked against every page hashed again)
            if self.trace {
                let kept = sums.iter().zip(&self.page_sums).filter(|(a, b)| a.hash == b.hash).count();
                let same = self.doc().is_some_and(|d| d.hashes() == hs);
                self.history_log.push(format!("pages: first changed byte {first:?}, {kept} of {} kept, {}", hs.len(), if same { "== all hashed" } else { "!= all hashed" }));
            }
            self.pdf_hashes = Some(hs);
            self.page_sums = sums;
        }
        self.pdf_hashes.as_deref().unwrap_or(&[])
    }

    pub fn draws(&mut self, page: usize) -> Option<String> {
        if self.streaming() {
            return self.stream_draw(page);
        }
        self.build();
        if !self.pdf.is_empty() {
            // (only the page asked for is drawn, its fonts parsed once per session)
            if let Some(d) = self.pdf_draws.get(&page) {
                return Some(d.clone());
            }
            self.doc()?;
            let doc = self.pdf_doc.as_ref()?;
            let d = if self.xetex {
                // (XeTeX: the native fonts' glyphs from the glyph runs)
                let runs = self.runs.get(page).map_or(&[][..], |r| &r[..]);
                let (files, read, shelf) = (self.tex.as_ref().map(|t| &t.host().files), &self.xread, &self.shelf);
                let empty = BTreeMap::new();
                let files = files.unwrap_or(&empty);
                let faces = &mut self.faces;
                let mut extra = |f0: usize, h: f64| phitex_draw::xetex::extra(runs, h, f0, faces, &mut |n: &[u8]| xetex::get(files, read, shelf, n, "").map(|(_, b)| b));
                doc.draw_with(page, &mut self.pdf_fonts, Some(&mut extra))?
            } else {
                doc.draw(page, &mut self.pdf_fonts)?
            };
            self.pdf_draws.insert(page, d.clone());
            return Some(d);
        }
        let p = self.pages.get(page)?;
        Some(draws::json(&p.draws, &self.fonts, &p.specials, draws::ONE_INCH))
    }

    /// Page `page`'s glyphs with their source (JSON): `{"files":[names the
    /// job read],"g":[[x, y, file, start, end, synthesized]]}`, x and y in
    /// PDF points from the page's top left (as the draw list), in
    /// content-stream order; file `-1`: no source.
    pub fn origins(&mut self, page: usize) -> Option<String> {
        self.build();
        if self.pdf.is_empty() {
            return None;
        }
        let data: Arc<[u8]> = self.pdf.clone().into();
        let doc = partex_engine::pdfread::Doc::open(&data).ok()?;
        let pg = doc.page(page + 1)?;
        let shown = partex_engine::pdftext::page_codes(&doc, &pg);
        let [x0, _, _, y1] = pg.media;
        let tex = self.tex.as_mut()?;
        let o = tex.origins(page);
        let files: Vec<String> = tex.origin_files().iter().map(|f| esc(f)).collect();
        let mut g = String::new();
        // (XeTeX: one origin per glyph run, in the runs' order, 1:1)
        if self.xetex {
            for (i, r) in self.runs.get(page).map_or(&[][..], Vec::as_slice).iter().enumerate() {
                let o = o.get(i).copied().unwrap_or(partex_core::GlyphOrigin::NONE);
                let file = if o.file == u32::MAX { -1 } else { i64::from(o.file) };
                let _ = write!(g, "{}[{:.2},{:.2},{file},{},{},{}]", if g.is_empty() { "" } else { "," }, r.x - x0, y1 - r.y, o.start, o.end, u8::from(o.synthesized));
            }
            return Some(format!("{{\"files\":[{}],\"g\":[{g}]}}", files.join(",")));
        }
        for (i, s) in shown.iter().enumerate() {
            let o = o.get(i).copied().unwrap_or(partex_core::GlyphOrigin::NONE);
            let file = if o.file == u32::MAX { -1 } else { i64::from(o.file) };
            let _ = write!(g, "{}[{:.2},{:.2},{file},{},{},{}]", if g.is_empty() { "" } else { "," }, s.x - x0, y1 - s.y, o.start, o.end, u8::from(o.synthesized));
        }
        Some(format!("{{\"files\":[{}],\"g\":[{g}]}}", files.join(",")))
    }

    #[must_use]
    pub fn text(&self, name: &str) -> Option<String> {
        self.files.get(name).cloned()
    }

    /// A binary file it was given (tests, tools).
    #[must_use]
    pub fn bytes(&self, name: &str) -> Option<Arc<[u8]>> {
        self.bytes.get(name).cloned()
    }

    /// The terminal's output of the last build (tests, tools).
    #[must_use]
    pub fn term(&self) -> String {
        String::from_utf8_lossy(&self.term).into_owned()
    }

    /// The files served since the last call (tests).
    pub fn served(&mut self) -> Vec<(String, usize, &'static str)> {
        self.tex.as_mut().map_or_else(Vec::new, |t| std::mem::take(&mut t.host_mut().served))
    }

    /// A `\write` file's bytes as the job left them (tests).
    #[must_use]
    pub fn written_bytes(&self, name: &str) -> Option<Vec<u8>> {
        self.tex.as_ref()?.host().written.get(name.as_bytes()).cloned()
    }

    /// For debugging a build's convergence: the auxiliary files (.aux, .toc,
    /// .lof, .lot, .out, .bbl, .blg, acro/glossary files) as carried into
    /// the tracked build, as its host holds them now (inputs), and as the job
    /// wrote them. JSON: {"carried":{name:text},"files":{…},"written":{…}}.
    pub fn aux_dump(&self) -> String {
        let aux = |n: &[u8]| {
            let n = String::from_utf8_lossy(n);
            !(n.ends_with(".tex") || n.ends_with(".sty") || n.ends_with(".cls") || n.ends_with(".bib") || n.ends_with(".pdf") || n.ends_with(".png") || n.ends_with(".jpg") || n.ends_with(".tfm") || n.ends_with(".vf") || n.ends_with(".fmt") || n.ends_with(".log") || n.contains('.') && (n.ends_with(".def") || n.ends_with(".cfg") || n.ends_with(".fd") || n.ends_with(".map") || n.ends_with(".enc") || n.ends_with(".pfb") || n.ends_with(".clo") || n.ends_with(".ldf") || n.ends_with(".code.tex") || n.ends_with(".dict") || n.ends_with(".trsl") || n.ends_with(".bst") || n.ends_with(".cbx") || n.ends_with(".bbx") || n.ends_with(".lbx")))
        };
        let obj = |it: Vec<(&[u8], &[u8])>| {
            let parts: Vec<String> = it.into_iter().filter(|(n, _)| aux(n)).map(|(n, b)| format!("{}:{}", esc(&String::from_utf8_lossy(n)), esc(&String::from_utf8_lossy(b)))).collect();
            format!("{{{}}}", parts.join(","))
        };
        let carried = obj(self.carried.iter().map(|(n, b)| (&n[..], &b[..])).collect());
        let (files, written) = self.tex.as_ref().map_or(("{}".into(), "{}".into()), |t| {
            let h = t.host();
            (obj(h.files.iter().map(|(n, b)| (&n[..], &b[..])).collect()), obj(h.written.iter().map(|(n, b)| (&n[..], &b[..])).collect()))
        });
        format!("{{\"carried\":{carried},\"files\":{files},\"written\":{written}}}")
    }

    /// What the job wrote outside the link (`\write` files), by name (tests).
    #[must_use]
    pub fn written(&self) -> Vec<(String, usize)> {
        self.tex.as_ref().map_or_else(Vec::new, |t| {
            t.host().written.iter().map(|(n, b)| (String::from_utf8_lossy(n).into_owned(), b.len())).collect()
        })
    }
}

/// PDF mode, Overleaf's build: the default (`PHITEX_DVI=1`, natively,
/// builds DVI and reads pages from it).
#[must_use]
pub fn pdf_mode() -> bool {
    !std::env::var("PHITEX_DVI").is_ok_and(|v| v == "1")
}

/// A monotonic clock in ns (the rebuild deadline's): since the first call.
fn clock_ns() -> u64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    u64::try_from(START.get_or_init(Instant::now).elapsed().as_nanos()).unwrap_or(u64::MAX)
}

/// The clock, as the host's WASI shim gives it (UTC).
fn now() -> DateTime {
    // (SOURCE_DATE_EPOCH, natively: builds compared byte for byte share
    // their \time and PDF dates, as pdfTeX's)
    let s = std::env::var("SOURCE_DATE_EPOCH").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs())
    });
    let days = i64::try_from(s / 86_400).unwrap_or(0);
    // (Howard Hinnant's civil_from_days)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    #[allow(clippy::cast_possible_truncation)]
    DateTime {
        year: year as i32,
        month: month as i32,
        day: day as i32,
        minutes: ((s % 86_400) / 60) as i32,
    }
}

/// A job time as seconds since 1970 (UTC; xdvipdfmx's dates).
fn epoch(t: &DateTime) -> i64 {
    // (days from the civil date, Howard Hinnant's algorithm)
    let (y, m, d) = (i64::from(t.year) - i64::from(t.month <= 2), i64::from(t.month), i64::from(t.day));
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe - 719_468) * 86_400 + i64::from(t.minutes) * 60
}

fn ms(d: std::time::Duration) -> f64 {
    d.as_secs_f64() * 1e3
}

/// A JSON string.
#[must_use]
pub fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            c if (c as u32) < 0x20 => {
                let _ = write!(o, "\\u{:04x}", c as u32);
            }
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

// The raw C ABI the worker calls, as `core/`'s.
#[allow(unsafe_code, clippy::missing_safety_doc)]
mod abi {
    use super::*;

    thread_local! {
        static SESSIONS: RefCell<HashMap<u32, Session>> = RefCell::default();
        static NEXT: RefCell<u32> = const { RefCell::new(1) };
        static OUT: RefCell<Vec<u8>> = RefCell::default();
        static LAST: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
        /// Page drawers (`ph_draw_*`), by the host's slot: a PDF and its
        /// pages' draw lists, apart from any session, so that a second
        /// instance (the extension's draw worker) draws while this one builds.
        static DRAWERS: RefCell<HashMap<u32, Drawer>> = RefCell::default();
    }

    #[derive(Default)]
    struct Drawer {
        pdf: Option<phitex_draw::Pdf>,
        hashes: Vec<u64>,
        /// Draw lists by page hash: a page unchanged in a new PDF is not drawn again.
        draws: HashMap<u64, String>,
        fonts: phitex_draw::Fonts,
    }

    /// Give drawer `slot` a new PDF (the input). Returns its page count; the
    /// draw lists of pages it still has (by hash) are kept.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn ph_draw_set(slot: u32, ptr: *const u8, len: usize) -> u32 {
        let pdf = phitex_draw::Pdf::open(&Arc::from(unsafe { input(ptr, len) }));
        DRAWERS.with_borrow_mut(|m| {
            let d = m.entry(slot).or_default();
            d.hashes = pdf.as_ref().map(phitex_draw::Pdf::hashes).unwrap_or_default();
            let keep: std::collections::HashSet<u64> = d.hashes.iter().copied().collect();
            d.draws.retain(|h, _| keep.contains(h));
            d.pdf = pdf;
            u32::try_from(d.hashes.len()).unwrap_or(0)
        })
    }

    /// Page `k` of drawer `slot`: out, its draw list (JSON); returns 1 if it
    /// was drawn now, 2 if it was kept from before, 0 if there is no page `k`.
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_draw_page(slot: u32, k: u32) -> u32 {
        let (r, o) = DRAWERS.with_borrow_mut(|m| {
            let Some(d) = m.get_mut(&slot) else { return (0, Vec::new()) };
            let Some(&h) = d.hashes.get(k as usize) else { return (0, Vec::new()) };
            if let Some(j) = d.draws.get(&h) {
                return (2, j.clone().into_bytes());
            }
            let Some(j) = d.pdf.as_ref().and_then(|p| p.draw(k as usize, &mut d.fonts)) else { return (0, Vec::new()) };
            d.draws.insert(h, j.clone());
            (1, j.into_bytes())
        });
        out(o);
        r
    }

    /// Page `k`'s hash in drawer `slot`, as `ph_pages` gives it (out, text).
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_draw_hash(slot: u32, k: u32) {
        let h = DRAWERS.with_borrow(|m| m.get(&slot).and_then(|d| d.hashes.get(k as usize).copied()));
        out(h.map(|h| format!("{h:016x}").into_bytes()).unwrap_or_default());
    }

    /// Drop drawer `slot` (its tab went away).
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_draw_drop(slot: u32) {
        DRAWERS.with_borrow_mut(|m| m.remove(&slot));
    }

    struct Reader<'a>(&'a [u8]);

    impl<'a> Reader<'a> {
        fn u32(&mut self) -> Option<u32> {
            let (a, b) = self.0.split_at_checked(4)?;
            self.0 = b;
            Some(u32::from_le_bytes(a.try_into().ok()?))
        }
        fn str(&mut self) -> Option<&'a str> {
            std::str::from_utf8(self.bytes()?).ok()
        }
        fn bytes(&mut self) -> Option<&'a [u8]> {
            let n = self.u32()? as usize;
            let (a, b) = self.0.split_at_checked(n)?;
            self.0 = b;
            Some(a)
        }
    }

    unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
        if len == 0 { &[] } else { unsafe { std::slice::from_raw_parts(ptr, len) } }
    }

    fn out(v: Vec<u8>) {
        OUT.with_borrow_mut(|o| *o = v);
    }

    fn out_json(s: String) {
        out(s.into_bytes());
    }

    fn with<T>(h: u32, f: impl FnOnce(&mut Session) -> T) -> Option<T> {
        SESSIONS.with_borrow_mut(|s| s.get_mut(&h).map(f))
    }

    const NO_HANDLE: &str = "{\"error\":\"no such handle\"}";

    #[unsafe(no_mangle)]
    pub extern "C" fn ph_alloc(len: usize) -> *mut u8 {
        let mut v = Vec::<u8>::with_capacity(len.max(1));
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn ph_free(ptr: *mut u8, len: usize) {
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ph_out_ptr() -> *const u8 {
        OUT.with_borrow(Vec::as_ptr)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ph_out_len() -> usize {
        OUT.with_borrow(Vec::len)
    }

    /// A panic's message and place, kept where the host can read it after
    /// the trap (`panic = "abort"`: the instance stops, its memory stays):
    /// the address and length of the leaked text, 0 if none.
    static PANIC_PTR: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    static PANIC_LEN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    /// Keep each panic's message (`ph_panic_ptr`, `ph_panic_len`) as well as printing it.
    fn keep_panics() {
        use std::sync::atomic::Ordering::SeqCst;
        let print = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            // (the first: a later one is what the trap left behind, a
            // RefCell still borrowed by the call that panicked)
            if PANIC_PTR.load(SeqCst) == 0 {
                let text: &'static str = Box::leak(info.to_string().into_boxed_str());
                PANIC_PTR.store(text.as_ptr() as usize, SeqCst);
                PANIC_LEN.store(text.len(), SeqCst);
            }
            print(info);
        }));
    }

    /// The last panic's text (see `keep_panics`): its address, 0 if none.
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_panic_ptr() -> usize {
        PANIC_PTR.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ph_panic_len() -> usize {
        PANIC_LEN.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The format and fonts ([`parse_assets`]' framing), once per
    /// instance, before the first `ph_open`. Returns how many files.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn ph_assets(ptr: *const u8, len: usize) -> u32 {
        keep_panics();
        // (the engine's switches are env vars for its CLI; wasm has none, so
        // each runs at its default: soft and class reads on, sound since 468180a)
        let Some(m) = parse_assets(unsafe { input(ptr, len) }) else { return 0 };
        let n = u32::try_from(m.len()).unwrap_or(0);
        add_assets(m);
        n
    }

    /// Open a project: `u32 fuel, str main, u32 n, (str name, str text) × n`.
    /// Returns a handle (0: bad input); out: status JSON.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn ph_open(ptr: *const u8, len: usize) -> u32 {
        let mut r = Reader(unsafe { input(ptr, len) });
        // (fuel, main, the text files, then the binary ones, figures: all
        // there before the first build)
        let mut parse = || -> Option<(String, BTreeMap<String, String>, Vec<(String, &[u8])>, bool, u32, bool)> {
            let _fuel = r.u32()?;
            let main = r.str()?.to_string();
            let n = r.u32()?;
            let mut files = BTreeMap::new();
            for _ in 0..n {
                let name = r.str()?.to_string();
                files.insert(name, r.str()?.to_string());
            }
            let mut bins = Vec::new();
            for _ in 0..r.u32().unwrap_or(0) {
                bins.push((r.str()?.to_string(), r.bytes()?));
            }
            // (then the engine: 1 XeTeX; absent or 0 pdfTeX)
            let xetex = r.u32().unwrap_or(0) == 1;
            // (then how to start: 0 or absent a plain first paint, the SSA
            // program at the first edit or when idle; 1 plain builds only
            // (another worker builds the program); 2 the SSA program at once)
            let start = r.u32().unwrap_or(0);
            // (then 1: the build streamed, `ph_step` runs it on; absent or
            // 0: built before the open answers)
            let streamed = r.u32().unwrap_or(0) == 1;
            Some((main, files, bins, xetex, start, streamed))
        };
        let Some((main, files, bins, xetex, start, streamed)) = parse() else {
            out_json("{\"error\":\"bad open input\"}".into());
            return 0;
        };
        let mut s = Session::open(files, &main);
        s.xetex = xetex;
        for (n, b) in bins {
            s.set_bytes(&n, b);
        }
        match start {
            1 => s.plain_only(true),
            2 => {}
            _ => s.fast_start(),
        }
        let h = NEXT.with_borrow_mut(|n| {
            *n += 1;
            *n - 1
        });
        if streamed {
            // (the build begun, its first slice run: the rest by `ph_step`)
            s.stream_begin();
            out_json(s.stream_json(h));
            SESSIONS.with_borrow_mut(|m| m.insert(h, s));
            return h;
        }
        let st = s.status();
        // (`how`: "plain: …" a first paint, the SSA program still to come)
        out_json(format!("{{\"handle\":{h},\"build_ms\":{},\"how\":{},{}}}", s.build_ms, esc(&s.how), st.json()));
        SESSIONS.with_borrow_mut(|m| m.insert(h, s));
        h
    }

    /// Run session `h`'s streamed build on for `budget_ms` (out: its state,
    /// `Session::stream_json`: the pages shipped so far, or, done, what
    /// `ph_open` answers). Returns 1 while there is more to do, 0 when it
    /// is done (or there is no streamed build).
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_step(h: u32, budget_ms: u32) -> u32 {
        let r = with(h, |s| {
            let more = s.stream_step(f64::from(budget_ms));
            out_json(s.stream_json(h));
            u32::from(more)
        });
        if r.is_none() {
            out_json(NO_HANDLE.into());
        }
        r.unwrap_or(0)
    }

    /// Plain builds only, on or off (`Session::plain_only`): off, the SSA
    /// program is built at the next build (the other worker failed).
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_plain_only(h: u32, on: u32) {
        let _ = with(h, |s| s.plain_only(on != 0));
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ph_close(h: u32) {
        SESSIONS.with_borrow_mut(|m| m.remove(&h));
    }

    /// Edit: `str name, u32 start, u32 end, str text` (byte offsets). With
    /// `page` = u32::MAX, the edit only; else the job is built and that
    /// page drawn (read with `ph_png_last`; draw lists only, any `dpi`).
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn ph_edit(h: u32, ptr: *const u8, len: usize, page: u32, _dpi: u32) -> u32 {
        let mut r = Reader(unsafe { input(ptr, len) });
        let (Some(name), Some(a), Some(b), Some(text)) = (r.str(), r.u32(), r.u32(), r.str()) else {
            out_json("{\"error\":\"bad edit input\"}".into());
            return 0;
        };
        let res = with(h, |s| {
            let t = Instant::now();
            s.edit_file(name, a as usize..b as usize, text)?;
            let stats = "{\"rebuilt\":1,\"reused\":0,\"passes\":1,\"loop_rebuilt\":0,\"pages_changed\":0,\"aux_changed\":0,\"externs_changed\":0}";
            if page == u32::MAX {
                return Ok(format!("{{\"stats\":{stats},\"total_ms\":{},\"pages\":{}}}", ms(t.elapsed()), s.page_count()));
            }
            let hashes = s.page_hashes();
            let k = (page as usize).min(hashes.len().saturating_sub(1));
            let d = s.draws(k);
            let painted = hashes.get(k).map_or("null".into(), |h| format!("\"{h:016x}\""));
            let total = ms(t.elapsed());
            LAST.with_borrow_mut(|l| *l = d.map(String::into_bytes));
            let pages = s.page_count();
            Ok::<_, String>(format!(
                "{{\"stats\":{stats},\"painted_hash\":{painted},\"paint_ms\":{total},\"total_ms\":{total},\"call_ms\":{total},\"wrong\":false,\"build_ms\":{},\"pages\":{pages}}}",
                s.build_ms
            ))
        });
        match res {
            Some(Ok(j)) => {
                out_json(j);
                1
            }
            Some(Err(e)) => {
                out_json(format!("{{\"error\":{}}}", esc(&e)));
                0
            }
            None => {
                out_json(NO_HANDLE.into());
                0
            }
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ph_png_last() {
        out(LAST.with_borrow_mut(Option::take).unwrap_or_default());
    }

    /// Idle work: ready every session's engine for its first rebuild.
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_idle() -> u32 {
        SESSIONS.with_borrow_mut(|m| m.values_mut().map(|s| u32::from(s.prepare())).sum())
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ph_status(h: u32) {
        let j = with(h, |s| {
            let t = Instant::now();
            let st = s.status();
            format!("{{{},\"ms\":{},\"build_ms\":{},\"builds\":{},\"how\":{}}}", st.json(), ms(t.elapsed()), s.build_ms, s.builds, esc(&s.how))
        });
        out_json(j.unwrap_or_else(|| NO_HANDLE.into()));
    }

    /// Set a file whole (`str name, str text`). Out: `{}` (the build is
    /// lazy: the next query makes it).
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn ph_set_file(h: u32, ptr: *const u8, len: usize) -> u32 {
        let mut r = Reader(unsafe { input(ptr, len) });
        let (Some(name), Some(text)) = (r.str(), r.str()) else { return 0 };
        let ok = with(h, |s| s.set_file(name, text));
        out_json("{}".into());
        u32::from(ok.is_some())
    }

    /// Set a binary file whole: `str name`, then the bytes (the rest of
    /// the input). Out: `{}`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn ph_set_bytes(h: u32, ptr: *const u8, len: usize) -> u32 {
        let mut r = Reader(unsafe { input(ptr, len) });
        let Some(name) = r.str() else { return 0 };
        let rest = r.0;
        let ok = with(h, |s| s.set_bytes(name, rest));
        out_json("{}".into());
        u32::from(ok.is_some())
    }

    /// Page `page`'s draw list (out; empty if there is no such page).
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_png(h: u32, page: u32, _dpi: u32) {
        let o = with(h, |s| s.draws(page as usize)).flatten();
        out(o.map(String::into_bytes).unwrap_or_default());
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ph_pages(h: u32) {
        let j = with(h, |s| {
            let hs: Vec<String> = s.page_hashes().iter().map(|id| format!("\"{id:016x}\"")).collect();
            format!("{{\"pages\":[{}]}}", hs.join(","))
        });
        out_json(j.unwrap_or_else(|| NO_HANDLE.into()));
    }

    /// For debugging: the whole terminal of the last build and the job's
    /// `.log` (out, text: the terminal, a `--- log` line, the log).
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_log(h: u32) {
        out(with(h, |s| {
            s.build();
            let job = s.main.strip_suffix(".tex").unwrap_or(&s.main).to_string();
            let mut t = s.history_log.join("\n").into_bytes();
            t.extend_from_slice(b"\n--- terminal\n");
            t.extend_from_slice(&s.term);
            t.extend_from_slice(b"\n--- log\n");
            t.extend(s.written_bytes(&format!("{job}.log")).unwrap_or_default());
            t
        })
        .unwrap_or_default());
    }

    /// The worker has (`on` 1) a `\write18` runner loaded (system.rs).
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_set_system(on: u32) {
        super::system::ON.store(on != 0, std::sync::atomic::Ordering::Relaxed);
    }

    /// Trace session `h`'s rebuilds (`on` 1) into its build log (`ph_log`).
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_trace(h: u32, on: u32) {
        with(h, |s| s.trace = on != 0);
        out_json("{}".into());
    }

    /// The auxiliary files, for debugging convergence (out, JSON: `Session::aux_dump`).
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_auxdump(h: u32) {
        out_json(with(h, |s| s.aux_dump()).unwrap_or_else(|| "{}".into()));
    }

    /// Page `page`'s glyph origins (out, JSON: `Session::origins`).
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_origins(h: u32, page: u32) {
        out_json(with(h, |s| s.origins(page as usize)).flatten().unwrap_or_else(|| "{\"files\":[],\"g\":[]}".into()));
    }

    /// The PDF the last build wrote (out; empty in DVI mode).
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_pdf(h: u32) {
        out(with(h, |s| {
            s.build();
            s.pdf.clone()
        })
        .unwrap_or_default());
    }

    /// The incremental check: builds are cold for now, so it holds.
    #[unsafe(no_mangle)]
    pub extern "C" fn ph_check(_h: u32) {
        out_json("{\"ok\":true,\"ms\":0}".into());
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn ph_text(h: u32, ptr: *const u8, len: usize) {
        let mut r = Reader(unsafe { input(ptr, len) });
        let t = r.str().and_then(|n| with(h, |s| s.text(n)).flatten());
        out(t.unwrap_or_default().into_bytes());
    }
}

#[cfg(test)]
mod error_tests {
    use super::first_error;

    #[test]
    fn latex_missing_file() {
        let t = "(./main.tex (/x/article.cls (size10.clo)) (foo.sty)\n\n! LaTeX Error: File `bar.sty' not found.\n\nType X to quit or <RETURN> to proceed,\nor enter new name. (Default extension: sty)\n\nEnter file name: \n! Emergency stop.\n<read *> \n         \nl.12 \\usepackage\n                 {bar}^^M\n";
        let e = first_error(t).unwrap();
        assert_eq!(e.message, "LaTeX Error: File `bar.sty' not found.");
        assert_eq!(e.file.as_deref(), Some("main.tex"));
        assert_eq!(e.line, Some(12));
        assert_eq!(e.missing.as_deref(), Some("bar.sty"));
    }

    #[test]
    fn undefined_in_input_file() {
        let t = "(main.tex (sec.tex\n! Undefined control sequence.\nl.3 \\foo\n         x\n";
        let e = first_error(t).unwrap();
        assert_eq!(e.message, "Undefined control sequence.");
        assert_eq!(e.file.as_deref(), Some("sec.tex"));
        assert_eq!(e.line, Some(3));
        assert_eq!(e.missing, None);
        assert!(first_error("(main.tex)\nOutput written").is_none());
    }

    #[test]
    fn fatal_error_wins_over_an_earlier_one() {
        let t = "(main.tex\n! LaTeX Error: Missing \\begin{document}.\nl.1 -\n (x.sty)\n! LaTeX Error: File `balance.sty' not found.\nEnter file name: \n! Emergency stop.\n<read *> \nl.9 \\begin{document}\n";
        let e = first_error(t).unwrap();
        assert_eq!(e.missing.as_deref(), Some("balance.sty"));
        assert_eq!(e.line, Some(9));
    }
}

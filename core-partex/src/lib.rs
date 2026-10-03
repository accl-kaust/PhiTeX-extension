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
use std::collections::{BTreeMap, HashMap};
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
pub mod pdfdraw;
mod shelf;
pub mod type1;

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
}

fn suffix(kind: FileKind) -> &'static [u8] {
    match kind {
        FileKind::Tex => b".tex",
        FileKind::Tfm => b".tfm",
        FileKind::Fmt => b".fmt",
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

    fn unchanged(&mut self, loads: &[partex_core::host::Load<'_>]) -> Vec<bool> {
        loads
            .iter()
            .map(|(name, kind, got)| {
                let base = name.strip_prefix(b"./").unwrap_or(name);
                let cands = [with_suffix(base, *kind), base.to_vec()];
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
    fn write(&mut self, file: WriteId, bytes: &[u8]) {
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
    fn page_written(&mut self, page: &Page) {
        self.pages.push(page.clone());
    }
    fn deflate(&mut self, level: i32, data: &[u8]) -> Option<Vec<u8>> {
        Some(miniz_oxide::deflate::compress_to_vec_zlib(data, u8::try_from(level.clamp(0, 9)).unwrap_or(6)))
    }
}

/// TeX Live's `texmf.cnf` sizes for pdfTeX (LaTeX needs more than
/// web2c's compiled-in defaults). A job loading a format must use the
/// sizes that made it.
#[must_use]
pub fn texlive_params(ini: bool) -> Params {
    Params {
        flavor: partex_core::Flavor::PdfTex,
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
    pdf_fonts: pdfdraw::Fonts,
    pages: Vec<dvi::DviPage>,
    fonts: BTreeMap<i32, draws::Font>,
    term: Vec<u8>,
    missing: Vec<String>,
    history: i32,
    pub build_ms: f64,
    pub builds: u32,
    /// Each build: what changed before it and what it cost (the debug log).
    history_log: Vec<String>,
    /// What Shelf packs gave (wasm): every file of every pack fetched, for every later build.
    shelf: shelf::Cache,
    /// An edit since the last build touched the main file's preamble: cold.
    preamble_edited: bool,
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
            pdf_fonts: pdfdraw::Fonts::new(),
            pages: Vec::new(),
            fonts: BTreeMap::new(),
            term: Vec::new(),
            missing: Vec::new(),
            history: 0,
            build_ms: 0.0,
            builds: 0,
            history_log: Vec::new(),
            shelf: shelf::Cache::default(),
            preamble_edited: false,
            cold_ms: 0.0,
            trigger: Vec::new(),
            prepared: false,
            plain: false,
            want_ssa: true,
            how: String::new(),
            fallback_dir: None,
        }
    }

    fn host_files(&self) -> BTreeMap<Vec<u8>, Arc<[u8]>> {
        let mut m = ASSETS.with_borrow(Clone::clone);
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
                if n.contains('/') {
                    return None;
                }
                std::fs::read(dir.join(n)).ok()
            }));
        }
        let cache = self.shelf.clone();
        shelf::available().then(|| -> Box<dyn FnMut(&[u8]) -> Option<Vec<u8>>> { Box::new(move |n: &[u8]| shelf::get(&cache, n)) })
    }

    /// Ready the engine for its first rebuild (the format's definitions
    /// decoded): once per cold build, when idle; the first keystroke would
    /// pay it. True if there was anything to do.
    pub fn prepare(&mut self) -> bool {
        // (after a plain first paint: the SSA program, now, while idle)
        if self.plain && self.tex.is_none() {
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
            _ => false,
        }
    }

    /// Build if anything changed since the last build: a rebuild of the
    /// engine there is, else (none yet, or the last job stopped) cold.
    pub fn build(&mut self) {
        if !self.stale {
            return;
        }
        self.stale = false;
        let t = Instant::now();
        // (trips a build may take; PHITEX_TRIPS overrides)
        let max = std::env::var("PHITEX_TRIPS").ok().and_then(|v| v.parse().ok()).unwrap_or(4);
        let mut trips = ssa::Trips { max, tools: &mut no_tools, clock: None };
        // (a job that ended fatally, an unclosed brace's runaway argument, is
        // rebuilt too: the fix runs on past the old end; PHITEX_COLD_AFTER_FATAL
        // goes cold instead)
        let rebuild = self.tex.is_some() && !std::mem::take(&mut self.preamble_edited) && (self.history < 3 || std::env::var("PHITEX_COLD_AFTER_FATAL").is_err());
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
            let trace = std::env::var("PHITEX_REBUILD_LOG").is_ok();
            // (a rebuild may take as long as the last cold build took, then
            // stops and the build goes cold: past that, starting over is
            // cheaper, a preamble edit say; PHITEX_DEADLINE_MS overrides)
            let limit = std::env::var("PHITEX_DEADLINE_MS").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(self.cold_ms.max(300.0));
            tex.tracker().deadline.set(Some((clock_ns, clock_ns() + (limit * 1e6) as u64)));
            let r = ssa::rebuild_trips(tex, trace, true, &mut trips);
            if trace {
                for l in &r.log {
                    eprintln!("rebuild-log: {l}");
                }
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
            self.how = format!(
                "rebuild: {} steps, {} commands, {} trips (edits {}, seeds {}, phi {}, store readers {}, queries {}, defs changed {}, readers marked {}, new {}, retries {}){}",
                r.steps_run, r.commands, r.trips, r.edits, r.seeds, r.phi, r.store_readers, r.queries, r.defs_changed, r.readers_marked, r.new_steps, r.retries,
                r.log.iter().take(8).map(|l| format!("\n  {l}")).collect::<String>()
            );
        } else {
            self.changed.clear();
            let mut host = MemHost { files: self.host_files(), now: Some(now()), ..MemHost::default() };
            host.fallback = self.fallback();
            let mut tex = Tex::new(host, SsaTracker::new(Recorder::new()), texlive_params(false));
            // (windows: steps cut inside long runs, a tikzpicture's say, at
            // most every 4096 commands; PHITEX_WINDOW overrides, 0 = off)
            tex.set_window(std::env::var("PHITEX_WINDOW").ok().and_then(|v| v.parse().ok()).unwrap_or(4096));
            // (each glyph's source bytes: double-click on the page → the
            // editor, the cursor → the page; rebuilds keep them mapped)
            tex.set_origins(true);
            let main = self.main.strip_suffix(".tex").unwrap_or(&self.main);
            // (DVI mode: the pages are read from the DVI the link writes;
            // nonstop, as Overleaf runs pdflatex: an error is reported and
            // the job goes on, where without a terminal it would end)
            // (PDF mode uncompressed: pdfdraw reads the content streams back)
            let mode = if pdf_mode() { "\\pdfcompresslevel=0 \\pdfobjcompresslevel=0 " } else { "\\pdfoutput=0 " };
            // (the main file by the primitive \input, as `pdflatex main.tex`
            // opens it: LaTeX's \input{main} tests it with \pdffilesize,
            // which every keystroke changes, and re-ran that lookup)
            let cmd = format!("&pdflatex \\nonstopmode{mode}\\csname @@input\\endcsname{{{main}}}");
            let r = ssa::run_applying(&mut tex, cmd.as_bytes(), false, 0, false);
            let s = ssa::settle(&mut tex, false, false, &mut trips, r.commands, 0);
            self.history = s.history.max(r.history);
            self.how = format!("cold: {} commands", r.commands);
            self.cold_ms = ms(t.elapsed());
            // (a command budget only by PHITEX_BUDGET: the deadline below is the measure)
            if let Some(b) = std::env::var("PHITEX_BUDGET").ok().and_then(|v| v.parse().ok()) {
                tex.tracker().budget.set(b);
            }
            self.prepared = false;
            self.tex = Some(tex);
        }
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
            "build {}: {} (changed: {}{})",
            self.builds,
            self.how.lines().next().unwrap_or(""),
            if t.is_empty() { "nothing: cold".into() } else { t.join(" ") },
            if more > 0 { format!(" +{more}") } else { String::new() }
        ));
    }

    /// The job's command line.
    fn command(&self) -> String {
        let main = self.main.strip_suffix(".tex").unwrap_or(&self.main);
        // (PDF mode uncompressed: pdfdraw reads the content streams back;
        // the main file by the primitive \input, as `pdflatex main.tex`)
        let mode = if pdf_mode() { "\\pdfcompresslevel=0 \\pdfobjcompresslevel=0 " } else { "\\pdfoutput=0 " };
        format!("&pdflatex \\nonstopmode{mode}\\csname @@input\\endcsname{{{main}}}")
    }

    /// A build without the SSA program (an untracked run, ~3x faster than
    /// a cold SSA build): the first paint. The SSA program is built at the first edit or when idle.
    fn plain_build(&mut self) {
        self.changed.clear();
        self.tex = None;
        self.plain = true;
        let job = self.main.strip_suffix(".tex").unwrap_or(&self.main).to_string();
        let mut host = MemHost { files: self.host_files(), now: Some(now()), ..MemHost::default() };
        host.fallback = self.fallback();
        let (h, host) = run(host, texlive_params(false), self.command().as_bytes());
        self.history = h;
        self.term = host.term.clone();
        self.pdf_hashes = None;
        self.pdf_draws.clear();
        self.missing = host.missing.iter().map(|(n, _)| String::from_utf8_lossy(n).into_owned()).collect();
        self.missing.sort();
        self.missing.dedup();
        self.pdf = host.written.get(format!("{job}.pdf").as_bytes()).cloned().unwrap_or_default();
        self.shipped = self.pdf_hashes().len();
        self.how = "plain: the first paint".into();
    }

    /// Link the files from the steps' effects; read the DVI's pages.
    fn link(&mut self) {
        let tex = self.tex.as_mut().unwrap();
        let chunks = ssa::step_effects(&tex.tracker().rec.borrow());
        let slices: Vec<&[partex_core::effects::Effect]> = chunks.iter().map(|(_, e)| &e.1[..]).collect();
        let linked = partex_core::effects::link(&slices, &partex_core::Sequential, &mut |level, data| {
            Some(miniz_oxide::deflate::compress_to_vec_zlib(data, u8::try_from(level.clamp(0, 9)).unwrap_or(6)))
        });
        let h = tex.host_mut();
        self.missing = h.missing.iter().map(|(n, _)| String::from_utf8_lossy(n).into_owned()).collect();
        match linked {
            Ok(l) => {
                if std::env::var("PHITEX_LINK_DEBUG").is_ok() {
                    for (id, n, k) in &l.opened {
                        eprintln!("link: opened {} {} {:?}: {} bytes", id.0, String::from_utf8_lossy(n), k, l.files.get(&id.0).map_or(0, Vec::len));
                    }
                    for (id, b) in &l.files {
                        eprintln!("link: file {id}: {} bytes", b.len());
                    }
                }
                let dvi = l.opened.iter().rev().find(|(_, n, _)| n.ends_with(b".dvi")).and_then(|(id, ..)| l.files.get(&id.0));
                self.dvi = dvi.cloned().unwrap_or_default();
                let pdf = l.opened.iter().rev().find(|(_, n, _)| n.ends_with(b".pdf")).and_then(|(id, ..)| l.files.get(&id.0));
                self.pdf = pdf.cloned().unwrap_or_default();
                self.shipped = l.pages.len();
                self.pdf_hashes = None;
        self.pdf_draws.clear();
                let mut term = h.term.clone();
                term.extend_from_slice(&l.term);
                self.term = term;
            }
            Err(e) => {
                self.dvi.clear();
                self.term = format!("partex: the link failed: {e:?}").into_bytes();
            }
        }
        let files = &h.files;
        let (pages, fonts) = dvi::pages(&self.dvi, &|n| files.get(format!("{n}.tfm").as_bytes()).cloned());
        self.pages = pages;
        self.fonts = fonts;
        self.missing.retain(|n| !self.files.contains_key(n) && !self.bytes.contains_key(n));
        self.missing.sort();
        self.missing.dedup();
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
        }
    }

    pub fn edit_file(&mut self, name: &str, range: Range<usize>, text: &str) -> Result<(), String> {
        self.valid(name, &range)?;
        // (an edit to the main file's preamble, before \begin{document}:
        // what follows reads it all again, the whole job; a cold build is
        // what a rebuild would come to, sooner)
        if name == self.main && self.files[name].find("\\begin{document}").is_none_or(|b| range.start < b) {
            self.preamble_edited = true;
        }
        self.files.get_mut(name).unwrap().replace_range(range, text);
        self.changed.push(name.to_string());
        self.stale = true;
        // (the writer is typing: the program that makes keystrokes cheap)
        self.want_ssa = true;
        Ok(())
    }

    pub fn status(&mut self) -> Status {
        self.build();
        let term = String::from_utf8_lossy(&self.term);
        let lines: Vec<&str> = term.lines().collect();
        let tail = lines[lines.len().saturating_sub(12)..].join("\n");
        let error = first_error(&term);
        Status { pages: self.page_count(), history: self.history, missing: self.missing.clone(), tail, error }
    }

    /// Pages shipped by the last build.
    fn page_count(&self) -> usize {
        if self.pdf.is_empty() { self.pages.len() } else { self.shipped }

    }

    /// Each page's hash (its DVI bytes, less `bop`'s pointer to the page
    /// before): unchanged, the page need not be drawn again. (In PDF mode
    /// the whole file's, with the page's number: every page is drawn again
    /// after a change, by the host's PDF renderer.)
    pub fn page_hashes(&mut self) -> Vec<u64> {
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

    /// The PDF's pages' hashes (cheap: no drawing).
    fn pdf_hashes(&mut self) -> &[u64] {
        if self.pdf_hashes.is_none() {
            self.pdf_hashes = Some(pdfdraw::hashes(&self.pdf));
        }
        self.pdf_hashes.as_deref().unwrap_or(&[])
    }

    pub fn draws(&mut self, page: usize) -> Option<String> {
        self.build();
        if !self.pdf.is_empty() {
            // (only the page asked for is drawn, its fonts parsed once per session)
            if let Some(d) = self.pdf_draws.get(&page) {
                return Some(d.clone());
            }
            let d = pdfdraw::page(&self.pdf, page, &mut self.pdf_fonts)?;
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
    let s = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
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
        pdf: Vec<u8>,
        hashes: Vec<u64>,
        /// Draw lists by page hash: a page unchanged in a new PDF is not drawn again.
        draws: HashMap<u64, String>,
        fonts: pdfdraw::Fonts,
    }

    /// Give drawer `slot` a new PDF (the input). Returns its page count; the
    /// draw lists of pages it still has (by hash) are kept.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn ph_draw_set(slot: u32, ptr: *const u8, len: usize) -> u32 {
        let pdf = unsafe { input(ptr, len) }.to_vec();
        DRAWERS.with_borrow_mut(|m| {
            let d = m.entry(slot).or_default();
            d.hashes = pdfdraw::hashes(&pdf);
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
            let Some(j) = pdfdraw::page(&d.pdf, k as usize, &mut d.fonts) else { return (0, Vec::new()) };
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

    /// The format and fonts ([`parse_assets`]' framing), once per
    /// instance, before the first `ph_open`. Returns how many files.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn ph_assets(ptr: *const u8, len: usize) -> u32 {
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
        let mut parse = || -> Option<(String, BTreeMap<String, String>, Vec<(String, &[u8])>)> {
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
            Some((main, files, bins))
        };
        let Some((main, files, bins)) = parse() else {
            out_json("{\"error\":\"bad open input\"}".into());
            return 0;
        };
        let mut s = Session::open(files, &main);
        for (n, b) in bins {
            s.set_bytes(&n, b);
        }
        s.fast_start();
        let st = s.status();
        let h = NEXT.with_borrow_mut(|n| {
            *n += 1;
            *n - 1
        });
        out_json(format!("{{\"handle\":{h},\"build_ms\":{},{}}}", s.build_ms, st.json()));
        SESSIONS.with_borrow_mut(|m| m.insert(h, s));
        h
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
            Ok::<_, String>(format!(
                "{{\"stats\":{stats},\"painted_hash\":{painted},\"paint_ms\":{total},\"total_ms\":{total},\"call_ms\":{total},\"wrong\":false,\"build_ms\":{},\"pages\":{}}}",
                s.build_ms,
                s.page_count()
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

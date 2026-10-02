//! The PhiTeX core for the browser: a raw C ABI over `phitex_ssa::Doc`,
//! built for `wasm32-wasip1` (so `std::time::Instant`, which PhiTeX's
//! `Doc::edit_view` and `prof` call, has a clock: the host's WASI shim).
//!
//! Every document lives behind a handle, never in a bare global, so that a
//! multithreaded build (`wasm32-wasip1-threads`) can keep one `Doc` per
//! thread, or move one whole, without changing the ABI.
//!
//! Calls exchange bytes through linear memory: the host `ph_alloc`s an
//! input buffer, and reads a call's output (JSON, PNG or PDF) from
//! `ph_out_ptr` / `ph_out_len` until the next call. Input framing (all
//! little-endian): `u32` = 4 bytes, `str` = `u32` length + UTF-8 bytes.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::ops::Range;
use std::collections::HashMap;
use std::rc::{Rc, Weak};
use std::time::Instant;

use phitex_layout::{pdf, png};
use phitex_ssa::ir::{Def, Program};
use phitex_ssa::material::{BoxNode, Fonts};
use phitex_ssa::pack::Draw;
use phitex_ssa::{Doc, EditStats, Files, Format};

/// The project's files as they are now: what the `Doc` reads a file from
/// the first time it is asked for, and what a fresh build is made from.
/// And the names the `Doc` asked for that none has (`\\usepackage{x}`'s
/// `x.sty`, ...): the host may find them elsewhere (TeX Live) and
/// `set_file` them.
#[derive(Clone, Default)]
struct Mirror(
    Rc<RefCell<BTreeMap<String, String>>>,
    Rc<RefCell<BTreeSet<String>>>,
);

impl Files for Mirror {
    fn read(&self, name: &str) -> Option<String> {
        let t = self.0.borrow().get(name).cloned().or_else(|| bundled(name));
        if t.is_none() {
            self.1.borrow_mut().insert(name.to_string());
        }
        t
    }

    /// A font's TFM file: the project's text files never are one, so it
    /// is from [`FONTS`] (there is no disk to look on in the browser).
    fn read_bytes(&self, name: &str) -> Option<Vec<u8>> {
        FONTS.iter().find(|(n, _)| *n == name).map(|(_, b)| b.to_vec())
    }
}

/// Knuth's `plain.tex` and the `hyphen.tex` it inputs (TeX Live's,
/// unmodified), for a project that has none of its own.
fn bundled(name: &str) -> Option<String> {
    match name {
        "plain.tex" => Some(include_str!("../tex/plain.tex").into()),
        "hyphen.tex" => Some(include_str!("../tex/hyphen.tex").into()),
        _ => None,
    }
}

thread_local! {
    /// Plain TeX's format: `\input plain`, as `tex` has it preloaded.
    static PLAIN: Format = Doc::project(Mirror::default(), "plain.tex").format();
}

/// A document as `tex` runs it: from plain TeX's format.
fn plain_doc(files: Mirror, main: &str) -> Doc {
    PLAIN.with(|f| Doc::project_from(files, main, f))
}

/// The Computer Modern fonts PhiTeX carries (its `phitex-tex/fixtures/fonts`).
const FONTS: &[(&str, &[u8])] = &[
    ("cmbx10.tfm", include_bytes!("../fonts/cmbx10.tfm")),
    ("cmex10.tfm", include_bytes!("../fonts/cmex10.tfm")),
    ("cmmi10.tfm", include_bytes!("../fonts/cmmi10.tfm")),
    ("cmmi5.tfm", include_bytes!("../fonts/cmmi5.tfm")),
    ("cmmi7.tfm", include_bytes!("../fonts/cmmi7.tfm")),
    ("cmr10.tfm", include_bytes!("../fonts/cmr10.tfm")),
    ("cmr5.tfm", include_bytes!("../fonts/cmr5.tfm")),
    ("cmr7.tfm", include_bytes!("../fonts/cmr7.tfm")),
    ("cmsl10.tfm", include_bytes!("../fonts/cmsl10.tfm")),
    ("cmsy10.tfm", include_bytes!("../fonts/cmsy10.tfm")),
    ("cmsy5.tfm", include_bytes!("../fonts/cmsy5.tfm")),
    ("cmsy7.tfm", include_bytes!("../fonts/cmsy7.tfm")),
    ("cmti10.tfm", include_bytes!("../fonts/cmti10.tfm")),
    ("cmtt10.tfm", include_bytes!("../fonts/cmtt10.tfm")),
];

pub struct Session {
    doc: Doc,
    files: Mirror,
    main: String,
    /// Each shipped page's PDF content stream, by its box's id.
    streams: BTreeMap<u64, Rc<Vec<u8>>>,
    /// Page boxes' ids ([`Session::id`]), by address.
    ids: HashMap<usize, (Weak<BoxNode>, u64)>,
    next_id: u64,
}

#[derive(Debug)]
pub struct Status {
    pub pages: usize,
    /// Values pending: text not read (out of fuel, or cut short).
    pub pending: usize,
    /// Control sequences used undefined (`\\documentclass`, ...): PhiTeX
    /// ignores them, so their output is missing. Distinct, sorted.
    pub undefined: Vec<String>,
    /// Files read and not found (a package not in the project). Sorted.
    pub missing: Vec<String>,
}

impl Status {
    fn json(&self) -> String {
        let names: Vec<String> = self.undefined.iter().take(12).map(|n| esc(n)).collect();
        format!(
            "\"pages\":{},\"pending\":{},\"undefined\":{},\"undefined_names\":[{}],\"missing\":[{}]",
            self.pages,
            self.pending,
            self.undefined.len(),
            names.join(","),
            self.missing.iter().map(|n| esc(n)).collect::<Vec<_>>().join(",")
        )
    }
}

impl Session {
    #[must_use]
    /// (`_fuel`: PhiTeX's default, 10^5 steps a chunk, is what a document
    /// started from a format gets; the ABI keeps the argument.)
    pub fn open(files: BTreeMap<String, String>, main: &str, _fuel: u32) -> Session {
        let files = Mirror(Rc::new(RefCell::new(files)), Rc::default());
        let doc = plain_doc(files.clone(), main);
        Session {
            doc,
            files,
            main: main.to_string(),
            streams: BTreeMap::new(),
            ids: HashMap::new(),
            next_id: 1,
        }
    }

    /// A page box's id: the same while it is the same box (a page the Doc
    /// kept), a new one for a new box. (Boxes have no hash; the `Weak`
    /// keeps the address from being reused while its entry lives.)
    fn id(&mut self, b: &Rc<BoxNode>) -> u64 {
        let key = Rc::as_ptr(b) as usize;
        if let Some((w, id)) = self.ids.get(&key)
            && w.upgrade().is_some_and(|x| Rc::ptr_eq(&x, b))
        {
            return *id;
        }
        let id = self.next_id;
        self.next_id += 1;
        if self.ids.len() > 256 {
            self.ids.retain(|_, (w, _)| w.strong_count() > 0);
        }
        self.ids.insert(key, (Rc::downgrade(b), id));
        id
    }

    /// The shipped pages' ids.
    pub fn page_ids(&mut self) -> Vec<u64> {
        self.doc.ships().iter().map(|b| self.id(b)).collect()
    }

    /// `range` must be within `name` and on character boundaries: PhiTeX
    /// panics otherwise, and a panic aborts the whole wasm instance.
    fn valid(&self, name: &str, range: &Range<usize>) -> Result<(), String> {
        let files = self.files.0.borrow();
        let Some(t) = files.get(name) else {
            return Err(format!("no file {name}"));
        };
        if range.start > range.end || range.end > t.len() {
            return Err(format!(
                "range {range:?} outside {name} ({} bytes)",
                t.len()
            ));
        }
        if !t.is_char_boundary(range.start) || !t.is_char_boundary(range.end) {
            return Err(format!("range {range:?} not on UTF-8 boundaries in {name}"));
        }
        Ok(())
    }

    fn mirror(&self, name: &str, range: Range<usize>, text: &str) {
        if let Some(t) = self.files.0.borrow_mut().get_mut(name) {
            t.replace_range(range, text);
        }
    }

    /// A file of the project, new or replaced whole.
    pub fn set_file(&mut self, name: &str, text: &str) {
        let old = self.files.0.borrow().get(name).cloned();
        match old {
            Some(old) => {
                // (the Doc edits it: the mirror is updated after, so a Doc
                // that has not read it yet reads the old text first)
                self.doc.edit_file(name, 0..old.len(), text);
                self.mirror(name, 0..old.len(), text);
            }
            None => {
                self.files.1.borrow_mut().remove(name);
                self.files
                    .0
                    .borrow_mut()
                    .insert(name.to_string(), text.to_string());
                // A file the Doc looked for and found missing is never looked
                // for again (no PhiTeX API invalidates it: see REPORT.md), so a
                // new file costs a rebuild. Rare: files are added, not typed.
                self.doc = plain_doc(self.files.clone(), &self.main);
            }
        }
    }

    pub fn edit_file(
        &mut self,
        name: &str,
        range: Range<usize>,
        text: &str,
    ) -> Result<EditStats, String> {
        self.valid(name, &range)?;
        if self.refill(name, &range, text) {
            return Ok(self.doc.edit_file(name, 0..0, ""));
        }
        let s = self.doc.edit_file(name, range.clone(), text);
        self.mirror(name, range, text);
        Ok(s)
    }

    pub fn edit_view(
        &mut self,
        name: &str,
        range: Range<usize>,
        text: &str,
        page: usize,
    ) -> Result<phitex_ssa::View, String> {
        self.valid(name, &range)?;
        if self.refill(name, &range, text) {
            return Ok(self.doc.edit_view(name, 0..0, "", page));
        }
        let v = self.doc.edit_view(name, range.clone(), text, page);
        self.mirror(name, range, text);
        Ok(v)
    }

    /// Text typed into an empty file: PhiTeX never sees it (the Doc keeps
    /// no chunk of an empty file to edit, so it stays 0 values: every
    /// keystroke after deleting everything is lost). Rebuilt instead, as
    /// for a new file; the caller then asks the Doc for a no-op edit's
    /// stats and view. True if so.
    fn refill(&mut self, name: &str, range: &Range<usize>, text: &str) -> bool {
        let empty = self.files.0.borrow().get(name).is_some_and(String::is_empty);
        if !empty || text.is_empty() {
            return false;
        }
        self.mirror(name, range.clone(), text);
        self.doc = plain_doc(self.files.clone(), &self.main);
        true
    }

    #[must_use]
    pub fn status(&self) -> Status {
        let p = self.doc.program();
        Status {
            pages: self.doc.ships().len(),
            pending: pending(&p),
            undefined: undefined(&p),
            missing: self.files.1.borrow().iter().cloned().collect(),
        }
    }

    #[must_use]
    pub fn png(&self, page: usize, dpi: u32) -> Option<Vec<u8>> {
        self.doc.page_box(page).map(|b| png::page(&b, &self.doc.fonts(), dpi))
    }

    /// The PDF, each page's stream drawn only if its box is new.
    pub fn pdf(&mut self) -> Vec<u8> {
        let ships = self.doc.ships();
        let ids: Vec<u64> = ships.iter().map(|b| self.id(b)).collect();
        let fonts = self.doc.fonts();
        let streams: Vec<Rc<Vec<u8>>> = ships
            .iter()
            .zip(&ids)
            .map(|(b, id)| {
                self.streams
                    .entry(*id)
                    .or_insert_with(|| Rc::new(pdf::content(b, &fonts)))
                    .clone()
            })
            .collect();
        drop(fonts);
        let keep: std::collections::BTreeSet<u64> = ids.into_iter().collect();
        self.streams.retain(|h, _| keep.contains(h));
        pdf::write(&streams)
    }

    /// PhiTeX's invariant: the incremental program equals a fresh build of
    /// the same files. `None` if it holds, else where they part.
    #[must_use]
    pub fn check(&self) -> Option<String> {
        let files = Mirror(Rc::new(RefCell::new(self.files.0.borrow().clone())), Rc::default());
        let fresh = plain_doc(files, &self.main).program();
        let inc = self.doc.program();
        if fresh == inc {
            return None;
        }
        let i = fresh
            .values
            .iter()
            .zip(&inc.values)
            .position(|(a, b)| a != b);
        Some(match i {
            Some(i) => format!(
                "value %{i} differs: fresh `{}` vs incremental `{}`",
                fresh.values[i].shows, inc.values[i].shows
            ),
            None if fresh.values.len() != inc.values.len() => {
                format!(
                    "{} values fresh vs {} incremental",
                    fresh.values.len(),
                    inc.values.len()
                )
            }
            None => "same values, different source text".to_string(),
        })
    }

    #[must_use]
    pub fn text(&self, name: &str) -> Option<String> {
        self.files.read(name)
    }
}

/// A shipped page as its draw list, JSON, in PDF points (bp) from the top
/// left: `{"w","h","f": [font names], "t": [[x, y, size, font, text,
/// width]], "r": [[x, y, w, h]]}`. What the PDF draws, for the host to
/// paint as vector (a few KB, where PhiTeX's PNG is ~0.9 MB of grey boxes
/// a glyph). PhiTeX draws a character at a time; runs of them (same font
/// and baseline, each where the last ended, give or take a kern) are one
/// text, `width` wide as TeX set it, in the base font the PDF uses.
#[must_use]
pub fn draws_json(b: &BoxNode, fonts: &Fonts) -> String {
    #[allow(clippy::cast_precision_loss)]
    let bp = |x: i64| (x as f64 / 65536.0 * 72.0 / 72.27 * 100.0).round() / 100.0;
    let mut names: Vec<&str> = Vec::new();
    let (mut t, mut r) = (String::new(), String::new());
    // (the run being gathered: start x, y, font, text, where it ends)
    let mut run: Option<(i64, i64, u16, String, i64)> = None;
    let flush = |run: &mut Option<(i64, i64, u16, String, i64)>, t: &mut String, names: &mut Vec<&str>| {
        let Some((x, y, font, text, end)) = run.take() else { return };
        if text.is_empty() {
            return;
        }
        let f = fonts.get(font.into());
        let base = base_font(&f.name);
        let k = names.iter().position(|n| *n == base).unwrap_or_else(|| {
            names.push(base);
            names.len() - 1
        });
        let _ = write!(
            t,
            "{}[{},{},{},{k},{},{}]",
            if t.is_empty() { "" } else { "," },
            bp(x),
            bp(y),
            bp(i64::from(f.size)),
            esc(&text),
            bp(end - x)
        );
    };
    for d in pdf::draws(b, fonts) {
        match d {
            Draw::Char { x, y, font, ch } => {
                let (x, y) = (i64::from(x), i64::from(y));
                let f = fonts.get(font);
                let w = i64::from(f.char_info(ch).width);
                let fid: u16 = font.into();
                let joins = run.as_ref().is_some_and(|(_, ry, rf, _, end)| {
                    *ry == y && *rf == fid && (x - end).abs() <= i64::from(f.size) / 8
                });
                if !joins {
                    flush(&mut run, &mut t, &mut names);
                    run = Some((x, y, fid, String::new(), x));
                }
                let run = run.as_mut().unwrap();
                run.3.push_str(&glyph(ch));
                run.4 = x + w;
            }
            Draw::Rule {
                x,
                y,
                width,
                height,
            } => {
                let _ = write!(
                    r,
                    "{}[{},{},{},{}]",
                    if r.is_empty() { "" } else { "," },
                    bp(i64::from(x)),
                    bp(i64::from(y)),
                    bp(i64::from(width)),
                    bp(i64::from(height))
                );
            }
        }
    }
    flush(&mut run, &mut t, &mut names);
    let f: Vec<String> = names.iter().map(|f| esc(f)).collect();
    format!(
        "{{\"w\":{},\"h\":{},\"f\":[{}],\"t\":[{t}],\"r\":[{r}]}}",
        pdf::PAGE_WIDTH,
        pdf::PAGE_HEIGHT,
        f.join(",")
    )
}

/// The PDF base font PhiTeX's PDF draws TeX font `name` in (as
/// `phitex_layout::pdf` picks it).
fn base_font(name: &str) -> &'static str {
    if name.starts_with("cmbx") || name.starts_with("cmb") {
        "Times-Bold"
    } else if name.starts_with("cmti") || name.starts_with("cmsl") || name.starts_with("cmmi") {
        "Times-Italic"
    } else if name.starts_with("cmtt") {
        "Courier"
    } else {
        "Times-Roman"
    }
}

/// An OT1 character as text (its ligatures, dashes and quotes spelled
/// out, as `phitex_layout::pdf` does).
fn glyph(ch: u8) -> String {
    match ch {
        11 => "ff".into(),
        12 => "fi".into(),
        13 => "fl".into(),
        14 => "ffi".into(),
        15 => "ffl".into(),
        b'"' => "\u{201d}".into(),
        b'\\' => "\u{201c}".into(),
        b'{' => "\u{2013}".into(),
        b'|' => "\u{2014}".into(),
        b'<' | b'>' | b'_' | b'}' | b'~' => String::new(),
        33..=126 => char::from(ch).to_string(),
        _ => String::new(),
    }
}

/// How many values are pending: text not read (unsupported, or out of fuel).
#[must_use]
pub fn pending(p: &Program) -> usize {
    p.values
        .iter()
        .filter(|v| matches!(v.def, Def::Pending { .. }))
        .count()
}

/// The control sequences `p` uses undefined.
#[must_use]
pub fn undefined(p: &Program) -> Vec<String> {
    let set: std::collections::BTreeSet<&str> = p
        .values
        .iter()
        .filter_map(|v| match &v.def {
            Def::Const(c) => c.strip_prefix("undefined "),
            _ => None,
        })
        .collect();
    set.into_iter().map(str::to_string).collect()
}

// ---- the C ABI ------------------------------------------------------------

thread_local! {
    static SESSIONS: RefCell<BTreeMap<u32, Session>> = RefCell::default();
    static NEXT: RefCell<u32> = const { RefCell::new(1) };
    static OUT: RefCell<Vec<u8>> = RefCell::default();
}

fn out(bytes: Vec<u8>) {
    OUT.with(|o| *o.borrow_mut() = bytes);
}

fn out_json(s: String) {
    out(s.into_bytes());
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(o, "\\u{:04x}", c as u32);
            }
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn u32(&mut self) -> Option<u32> {
        let (a, b) = self.0.split_at_checked(4)?;
        self.0 = b;
        Some(u32::from_le_bytes(a.try_into().ok()?))
    }
    fn str(&mut self) -> Option<&'a str> {
        let n = self.u32()? as usize;
        let (a, b) = self.0.split_at_checked(n)?;
        self.0 = b;
        std::str::from_utf8(a).ok()
    }
}

/// # Safety
/// The host passes a buffer it got from `ph_alloc` with this length.
unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        return &[];
    }
    // SAFETY: the host's contract above.
    unsafe { std::slice::from_raw_parts(ptr, len) }
}

fn with<T>(h: u32, f: impl FnOnce(&mut Session) -> T) -> Option<T> {
    SESSIONS.with(|s| s.borrow_mut().get_mut(&h).map(f))
}

fn stats_json(s: &EditStats) -> String {
    format!(
        "{{\"rebuilt\":{},\"reused\":{},\"passes\":{},\"loop_rebuilt\":{},\"pages_changed\":{},\"aux_changed\":{},\"externs_changed\":{}}}",
        s.rebuilt,
        s.reused,
        s.passes,
        s.loop_rebuilt,
        s.pages_changed,
        s.aux_changed,
        s.externs_changed
    )
}

fn ms(d: std::time::Duration) -> f64 {
    d.as_secs_f64() * 1e3
}

#[unsafe(no_mangle)]
pub extern "C" fn ph_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`, `len` from `ph_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ph_free(ptr: *mut u8, len: usize) {
    // SAFETY: allocated by ph_alloc with capacity len.max(1).
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
}

#[unsafe(no_mangle)]
pub extern "C" fn ph_out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn ph_out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

/// Open a project: `u32 fuel, str main, u32 n, (str name, str text) × n`.
/// Returns a handle (0: bad input); out: status JSON.
///
/// # Safety
/// See [`input`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ph_open(ptr: *const u8, len: usize) -> u32 {
    let mut r = Reader(unsafe { input(ptr, len) });
    let mut parse = || -> Option<(u32, String, BTreeMap<String, String>)> {
        let fuel = r.u32()?;
        let main = r.str()?.to_string();
        let n = r.u32()?;
        let mut files = BTreeMap::new();
        for _ in 0..n {
            let name = r.str()?.to_string();
            files.insert(name, r.str()?.to_string());
        }
        Some((fuel, main, files))
    };
    let Some((fuel, main, files)) = parse() else {
        out_json("{\"error\":\"bad open input\"}".into());
        return 0;
    };
    let t = Instant::now();
    let s = Session::open(files, &main, fuel);
    let build = ms(t.elapsed());
    let st = s.status();
    let h = NEXT.with(|n| {
        let mut n = n.borrow_mut();
        *n += 1;
        *n - 1
    });
    SESSIONS.with(|m| m.borrow_mut().insert(h, s));
    out_json(format!(
        "{{\"handle\":{h},\"build_ms\":{build},{}}}",
        st.json()
    ));
    h
}

#[unsafe(no_mangle)]
pub extern "C" fn ph_close(h: u32) {
    SESSIONS.with(|m| m.borrow_mut().remove(&h));
}

/// Edit: `str name, u32 start, u32 end, str text` (byte offsets). With
/// `page` = u32::MAX, `Doc::edit_file`; else `Doc::edit_view` from that
/// page, whose painted page is then drawn (read with `ph_png_last`): as a
/// PNG at `dpi`, or with `dpi` 0 as its draw list ([`draws_json`]). Out:
/// JSON. Returns 1 if the edit was applied.
///
/// # Safety
/// See [`input`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ph_edit(h: u32, ptr: *const u8, len: usize, page: u32, dpi: u32) -> u32 {
    let mut r = Reader(unsafe { input(ptr, len) });
    let (Some(name), Some(a), Some(b), Some(text)) = (r.str(), r.u32(), r.u32(), r.str()) else {
        out_json("{\"error\":\"bad edit input\"}".into());
        return 0;
    };
    let range = a as usize..b as usize;
    let res = with(h, |s| {
        let t = Instant::now();
        let json = if page == u32::MAX {
            let st = s.edit_file(name, range, text)?;
            let total = ms(t.elapsed());
            format!("{{\"stats\":{},\"total_ms\":{total}", stats_json(&st))
        } else {
            let v = s.edit_view(name, range, text, page as usize)?;
            let painted_id = v.painted.as_ref().map(|b| s.id(b));
            let fonts = s.doc.fonts();
            let paint_png = v.painted.as_ref().map(|b| {
                if dpi == 0 {
                    draws_json(b, &fonts).into_bytes()
                } else {
                    png::page(b, &fonts, dpi)
                }
            });
            drop(fonts);
            LAST_PNG.with(|p| *p.borrow_mut() = paint_png);
            format!(
                "{{\"stats\":{},\"painted_hash\":{},\"paint_ms\":{},\"total_ms\":{},\"call_ms\":{},\"wrong\":{}",
                stats_json(&v.stats),
                painted_id.map_or("null".to_string(), |id| format!("\"{id:016x}\"")),
                ms(v.paint),
                ms(v.total),
                ms(t.elapsed()),
                v.wrong
            )
        };
        // (the status is `ph_status`'s: it flattens the program, O(document))
        Ok::<_, String>(format!("{json},\"pages\":{}}}", s.doc.ships().len()))
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
            out_json("{\"error\":\"no such handle\"}".into());
            0
        }
    }
}

thread_local! {
    static LAST_PNG: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
}

/// The page `ph_edit` painted first, as a PNG or draw list (out; empty if none).
#[unsafe(no_mangle)]
pub extern "C" fn ph_png_last() {
    out(LAST_PNG.with(|p| p.borrow_mut().take()).unwrap_or_default());
}

/// The status (pages, pending, undefined), and how long it took: it
/// flattens the whole program (`Doc::program`), so the host asks for it
/// when idle, not on every edit. Out: JSON.
#[unsafe(no_mangle)]
pub extern "C" fn ph_status(h: u32) {
    let j = with(h, |s| {
        let t = Instant::now();
        let st = s.status();
        format!("{{{},\"ms\":{}}}", st.json(), ms(t.elapsed()))
    });
    out_json(j.unwrap_or_else(|| "{\"error\":\"no such handle\"}".into()));
}

/// Set a file whole (`str name, str text`), new or not. Out: status JSON.
///
/// # Safety
/// See [`input`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ph_set_file(h: u32, ptr: *const u8, len: usize) -> u32 {
    let mut r = Reader(unsafe { input(ptr, len) });
    let (Some(name), Some(text)) = (r.str(), r.str()) else {
        return 0;
    };
    let ok = with(h, |s| {
        s.set_file(name, text);
        let st = s.status();
        out_json(format!("{{{}}}", st.json()));
    });
    u32::from(ok.is_some())
}

/// Page `page` as a PNG at `dpi`, or with `dpi` 0 its draw list (out;
/// empty if there is no such page).
#[unsafe(no_mangle)]
pub extern "C" fn ph_png(h: u32, page: u32, dpi: u32) {
    let o = with(h, |s| {
        let b = s.doc.page_box(page as usize)?;
        let fonts = s.doc.fonts();
        Some(if dpi == 0 {
            draws_json(&b, &fonts).into_bytes()
        } else {
            png::page(&b, &fonts, dpi)
        })
    });
    out(o.flatten().unwrap_or_default());
}

/// The shipped pages, each as its box's hash (out: JSON `{"pages":
/// ["<hex>", ...]}`): a page whose hash is unchanged need not be drawn
/// again.
#[unsafe(no_mangle)]
pub extern "C" fn ph_pages(h: u32) {
    let j = with(h, |s| {
        let hs: Vec<String> = s.page_ids().iter().map(|id| format!("\"{id:016x}\"")).collect();
        format!("{{\"pages\":[{}]}}", hs.join(","))
    });
    out_json(j.unwrap_or_else(|| "{\"error\":\"no such handle\"}".into()));
}

/// The whole PDF (out).
#[unsafe(no_mangle)]
pub extern "C" fn ph_pdf(h: u32) {
    out(with(h, Session::pdf).unwrap_or_default());
}

/// The invariant check against a fresh build. Out: JSON.
#[unsafe(no_mangle)]
pub extern "C" fn ph_check(h: u32) {
    let j = with(h, |s| {
        let t = Instant::now();
        let r = s.check();
        let d = ms(t.elapsed());
        match r {
            None => format!("{{\"ok\":true,\"ms\":{d}}}"),
            Some(e) => format!("{{\"ok\":false,\"ms\":{d},\"mismatch\":{}}}", esc(&e)),
        }
    });
    out_json(j.unwrap_or_else(|| "{\"error\":\"no such handle\"}".into()));
}

/// A file's text as the core has it (out; for the host's own check).
///
/// # Safety
/// See [`input`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ph_text(h: u32, ptr: *const u8, len: usize) {
    let mut r = Reader(unsafe { input(ptr, len) });
    let t = r.str().and_then(|n| with(h, |s| s.text(n)).flatten());
    out(t.unwrap_or_default().into_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> BTreeMap<String, String> {
        let mut m = BTreeMap::new();
        m.insert("main.tex".into(), "\\font\\rm=Times-Roman at 10pt \\rm\nH\u{e9}llo w\u{f6}rld.\n\n\\input part\n\n\\bye\n".into());
        m.insert("part.tex".into(), "A part.\n\n".into());
        m
    }

    #[test]
    fn edits_match_fresh() {
        let mut s = Session::open(doc(), "main.tex", 100_000);
        assert!(s.status().pages >= 1);
        assert!(s.status().undefined.is_empty());
        let at = s.text("main.tex").unwrap().find("w\u{f6}").unwrap();
        s.edit_file("main.tex", at..at, "\u{1f600} ").unwrap();
        s.edit_view("part.tex", 0..1, "One", 0).unwrap();
        assert_eq!(s.check(), None);
        assert!(s.edit_file("main.tex", at + 5..at + 6, "x").is_ok()); // (the w after "😀 ")
        assert!(s.edit_file("main.tex", at + 1..at + 2, "x").is_err()); // (inside the emoji));
        let bad = s.text("main.tex").unwrap().find('\u{e9}').unwrap() + 1;
        assert!(s.edit_file("main.tex", bad..bad, "x").is_err());
        assert_eq!(s.check(), None);
        assert!(s.pdf().starts_with(b"%PDF"));
        assert!(s.png(0, 36).unwrap().starts_with(b"\x89PNG"));
        let d = draws_json(&s.doc.page_box(0).unwrap(), &s.doc.fonts());
        assert!(
            d.contains("\"Times-Roman\"") && d.contains("\"t\":[["),
            "{d}"
        );
    }

    #[test]
    fn missing_files_are_reported_until_set() {
        let mut m = BTreeMap::new();
        m.insert("main.tex".into(), "\\input pkg\nHi.\n\\bye\n".into());
        let mut s = Session::open(m, "main.tex", 100_000);
        assert!(s.status().missing.iter().any(|n| n.starts_with("pkg")), "{:?}", s.status().missing);
        s.set_file("pkg.tex", "Pkg.\n");
        assert!(!s.status().missing.contains(&"pkg.tex".to_string()));
        assert_eq!(s.check(), None);
    }

    #[test]
    fn delete_all_then_retype() {
        let t = "Hi there.\n\\bye\n";
        let mut m = BTreeMap::new();
        m.insert("main.tex".into(), t.to_string());
        let mut s = Session::open(m, "main.tex", 100_000);
        assert_eq!(s.status().pages, 1);
        s.edit_view("main.tex", 0..t.len(), "", 0).unwrap();
        for (i, c) in t.char_indices() {
            s.edit_view("main.tex", i..i, &c.to_string(), 0).unwrap();
        }
        assert_eq!(s.text("main.tex").unwrap(), t);
        assert_eq!(s.check(), None);
        assert_eq!(s.status().pages, 1);
        // (and a project opened with an empty main)
        let mut m = BTreeMap::new();
        m.insert("main.tex".into(), String::new());
        let mut s = Session::open(m, "main.tex", 100_000);
        s.edit_file("main.tex", 0..0, t).unwrap();
        assert_eq!(s.check(), None);
        assert_eq!(s.status().pages, 1);
    }

    #[test]
    fn latex_is_undefined() {
        let mut m = BTreeMap::new();
        m.insert(
            "main.tex".into(),
            "\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n".into(),
        );
        let s = Session::open(m, "main.tex", 100_000);
        // (PhiTeX drops an undefined \\documentclass without a trace in the
        // program: REPORT.md, patch 2; the extension's warning is a source
        // heuristic until then)
        assert!(s.status().undefined.is_empty());
        assert_eq!(s.status().pages, 1);
    }

    #[test]
    fn new_file_is_read() {
        let mut m = doc();
        m.remove("part.tex");
        let mut s = Session::open(m, "main.tex", 100_000);
        s.set_file("part.tex", "Late part.\n\n");
        assert_eq!(s.check(), None);
    }
}

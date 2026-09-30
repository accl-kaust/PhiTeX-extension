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
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::ops::Range;
use std::rc::Rc;
use std::time::Instant;

use phitex_layout::{pdf, png};
use phitex_ssa::ir::{Def, Program};
use phitex_ssa::material::BoxVal;
use phitex_ssa::pack::Draw;
use phitex_ssa::{Doc, EditStats, Files};

/// The project's files as they are now: what the `Doc` reads a file from
/// the first time it is asked for, and what a fresh build is made from.
#[derive(Clone, Default)]
struct Mirror(Rc<RefCell<BTreeMap<String, String>>>);

impl Files for Mirror {
    fn read(&self, name: &str) -> Option<String> {
        self.0.borrow().get(name).cloned()
    }
}

pub struct Session {
    doc: Doc,
    files: Mirror,
    main: String,
    fuel: u32,
    /// Each shipped page's PDF content stream, by its box's hash.
    streams: BTreeMap<u64, Rc<Vec<u8>>>,
}

#[derive(Debug)]
pub struct Status {
    pub pages: usize,
    /// Values pending: text not read (out of fuel, or cut short).
    pub pending: usize,
    /// Control sequences used undefined (`\\documentclass`, ...): PhiTeX
    /// ignores them, so their output is missing. Distinct, sorted.
    pub undefined: Vec<String>,
}

impl Status {
    fn json(&self) -> String {
        let names: Vec<String> = self.undefined.iter().take(12).map(|n| esc(n)).collect();
        format!(
            "\"pages\":{},\"pending\":{},\"undefined\":{},\"undefined_names\":[{}]",
            self.pages,
            self.pending,
            self.undefined.len(),
            names.join(",")
        )
    }
}

impl Session {
    #[must_use]
    pub fn open(files: BTreeMap<String, String>, main: &str, fuel: u32) -> Session {
        let files = Mirror(Rc::new(RefCell::new(files)));
        let doc = Doc::project_with_fuel(files.clone(), main, fuel);
        Session {
            doc,
            files,
            main: main.to_string(),
            fuel,
            streams: BTreeMap::new(),
        }
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
                self.files
                    .0
                    .borrow_mut()
                    .insert(name.to_string(), text.to_string());
                // A file the Doc looked for and found missing is never looked
                // for again (no PhiTeX API invalidates it: see REPORT.md), so a
                // new file costs a rebuild. Rare: files are added, not typed.
                self.doc = Doc::project_with_fuel(self.files.clone(), &self.main, self.fuel);
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
        let v = self.doc.edit_view(name, range.clone(), text, page);
        self.mirror(name, range, text);
        Ok(v)
    }

    #[must_use]
    pub fn status(&self) -> Status {
        let p = self.doc.program();
        Status {
            pages: self.doc.ships().len(),
            pending: pending(&p),
            undefined: undefined(&p),
        }
    }

    #[must_use]
    pub fn png(&self, page: usize, dpi: u32) -> Option<Vec<u8>> {
        self.doc.page_box(page).map(|b| png::page(&b, dpi))
    }

    /// The PDF, each page's stream drawn only if its box is new.
    pub fn pdf(&mut self) -> Vec<u8> {
        let ships = self.doc.ships();
        let streams: Vec<Rc<Vec<u8>>> = ships
            .iter()
            .map(|b| {
                self.streams
                    .entry(b.hash)
                    .or_insert_with(|| Rc::new(pdf::content(b)))
                    .clone()
            })
            .collect();
        let keep: std::collections::BTreeSet<u64> = ships.iter().map(|b| b.hash).collect();
        self.streams.retain(|h, _| keep.contains(h));
        pdf::write(&streams)
    }

    /// PhiTeX's invariant: the incremental program equals a fresh build of
    /// the same files. `None` if it holds, else where they part.
    #[must_use]
    pub fn check(&self) -> Option<String> {
        let files = Mirror(Rc::new(RefCell::new(self.files.0.borrow().clone())));
        let fresh = Doc::project_with_fuel(files, &self.main, self.fuel).program();
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
/// left: `{"w","h","f": [font names], "t": [[x, y, size, font, text]], "r":
/// [[x, y, w, h]]}`. What the PDF draws, for the host to paint as vector
/// (a few KB, where PhiTeX's PNG is ~0.9 MB of grey boxes a glyph).
#[must_use]
pub fn draws_json(b: &BoxVal) -> String {
    #[allow(clippy::cast_precision_loss)]
    let bp = |x: i64| (x as f64 / 65536.0 * 72.0 / 72.27 * 100.0).round() / 100.0;
    let mut fonts: Vec<Box<str>> = Vec::new();
    let (mut t, mut r) = (String::new(), String::new());
    for d in pdf::draws(b) {
        match d {
            Draw::Text { x, y, font, text } => {
                let k = fonts
                    .iter()
                    .position(|f| *f == font.name)
                    .unwrap_or_else(|| {
                        fonts.push(font.name.clone());
                        fonts.len() - 1
                    });
                let _ = write!(
                    t,
                    "{}[{},{},{},{k},{}]",
                    if t.is_empty() { "" } else { "," },
                    bp(x),
                    bp(y),
                    bp(font.size),
                    esc(&text)
                );
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
                    bp(x),
                    bp(y),
                    bp(width),
                    bp(height)
                );
            }
        }
    }
    let f: Vec<String> = fonts.iter().map(|f| esc(f)).collect();
    format!(
        "{{\"w\":{},\"h\":{},\"f\":[{}],\"t\":[{t}],\"r\":[{r}]}}",
        pdf::PAGE_WIDTH,
        pdf::PAGE_HEIGHT,
        f.join(",")
    )
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
            let paint_png = v.painted.as_ref().map(|b| {
                if dpi == 0 {
                    draws_json(b).into_bytes()
                } else {
                    png::page(b, dpi)
                }
            });
            LAST_PNG.with(|p| *p.borrow_mut() = paint_png);
            format!(
                "{{\"stats\":{},\"paint_ms\":{},\"total_ms\":{},\"call_ms\":{},\"wrong\":{}",
                stats_json(&v.stats),
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
    let b = with(h, |s| s.doc.page_box(page as usize)).flatten();
    out(b
        .map(|b| {
            if dpi == 0 {
                draws_json(&b).into_bytes()
            } else {
                png::page(&b, dpi)
            }
        })
        .unwrap_or_default());
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
        let d = draws_json(&s.doc.page_box(0).unwrap());
        assert!(
            d.contains("\"Times-Roman\"") && d.contains("\"t\":[["),
            "{d}"
        );
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

//! XeTeX (xelatex): its fonts, its PDF and its pages' glyphs.
//!
//! - Fonts: the engine finds a font by name in the font index (an asset,
//!   `fontindex.pxfi`, `FileKind::FontIndex`), then reads it by TeX Live's
//!   absolute path (`/usr/share/texmf-dist/fonts/...`). Shelf keys fonts by
//!   the path inside TeX Live, so the prefix is stripped to fetch. A font
//!   asked for by file name (`[lmroman10-regular.otf]`) is found by its
//!   base name in the index's paths, as kpathsea would.
//! - The PDF: XeTeX writes XDV to the `.pdf` it opens (`FileKind::XdvPipe`);
//!   the link's XDV is made a PDF here, in process, with the engine's
//!   xdvipdfmx, uncompressed and without object streams (`-z0 -V4`, as
//!   pdfdraw reads PDFs back), keeping each page's glyph runs.
//! - The pages: pdfdraw draws the PDF's paths and its Type 1 text (TFM
//!   fonts, math without unicode-math); the native fonts' glyphs are drawn
//!   from the glyph runs, their outlines read here with skrifa.
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use partex_xdvipdfmx::api::{Options, Session, split_xdv};
use partex_xdvipdfmx::api::GlyphRun;
use partex_xdvipdfmx::io::{Files, Format};

use crate::shelf;

/// TeX Live's tree, as the font index and the XDV name its fonts.
pub const TL: &[u8] = b"/usr/share/texmf-dist/";
/// The font index's name among the assets.
pub const INDEX: &[u8] = b"fontindex.pxfi";

/// `name` inside TeX Live (the key Shelf has it by), if it is in it.
pub fn rel(name: &[u8]) -> &[u8] {
    name.strip_prefix(TL).unwrap_or(name)
}

thread_local! {
    /// The last conversion's costs (for the build log): the session's start, the pages, the end, the lookups.
    pub static COST: RefCell<String> = RefCell::new(String::new());
    static LOOKUPS: RefCell<(u32, u32, f64)> = const { RefCell::new((0, 0, 0.0)) };
    /// Font files by base name (from the index's paths, first wins), inside TeX Live.
    static BY_BASE: RefCell<HashMap<Vec<u8>, Vec<u8>>> = RefCell::new(HashMap::new());
}

/// The index's paths (its format's first part: `"PXFI" u16 version, u32 n, (u16 len, bytes) × n`, big-endian).
fn index_paths(b: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    if b.len() < 10 || &b[..4] != b"PXFI" {
        return out;
    }
    let n = u32::from_be_bytes([b[6], b[7], b[8], b[9]]) as usize;
    let mut i = 10;
    for _ in 0..n {
        let Some(l) = b.get(i..i + 2).map(|l| usize::from(u16::from_be_bytes([l[0], l[1]]))) else { break };
        let Some(p) = b.get(i + 2..i + 2 + l) else { break };
        out.push(p);
        i += 2 + l;
    }
    out
}

/// Learn the font files' base names from the index (when the assets arrive).
pub fn learn_index(b: &[u8]) {
    BY_BASE.with_borrow_mut(|m| {
        for p in index_paths(b) {
            let r = rel(p);
            let base = r.rsplit(|&c| c == b'/').next().unwrap_or(r);
            m.entry(base.to_vec()).or_insert_with(|| r.to_vec());
        }
    });
}

/// A font file asked for by base name: its path inside TeX Live.
pub fn by_base(name: &[u8]) -> Option<Vec<u8>> {
    BY_BASE.with_borrow(|m| m.get(name).cloned())
}

/// What the names to try for `name` are: as given, inside TeX Live, and
/// (a font's base name) its path.
pub fn keys(name: &[u8]) -> Vec<Vec<u8>> {
    let mut k = vec![name.to_vec()];
    if rel(name) != name {
        k.push(rel(name).to_vec());
    }
    if !name.contains(&b'/')
        && let Some(p) = by_base(name)
    {
        k.push(p);
    }
    k
}

/// xdvipdfmx's files: the host's (the project's, the assets, what was
/// fetched), then Shelf's.
/// (shared: the session reads the fonts' outlines from what it read)
pub type Read = std::rc::Rc<RefCell<BTreeMap<Vec<u8>, Arc<[u8]>>>>;

/// The host's files as xdvipdfmx sees them: set again for each conversion
/// (a started xdvipdfmx goes on with the files of the build it converts).
pub type Live = std::rc::Rc<RefCell<BTreeMap<Vec<u8>, Arc<[u8]>>>>;

struct DpxFiles {
    files: Live,
    read: Read,
    shelf: shelf::Cache,
}

/// `name`'s key and bytes: the host's files, what was read before, or (the
/// browser) Shelf's, resolved for XeTeX and kpathsea format `format`
/// (shelf::find; "": a path, or any file of that name).
pub fn get(files: &BTreeMap<Vec<u8>, Arc<[u8]>>, read: &Read, cache: &shelf::Cache, name: &[u8], format: &str) -> Option<(Vec<u8>, Arc<[u8]>)> {
    for k in keys(name) {
        if let Some(b) = files.get(&k).cloned().or_else(|| read.borrow().get(&k).cloned()) {
            return Some((k, b));
        }
    }
    if !shelf::available() {
        return None;
    }
    let (k, b) = shelf::find(cache, name, format, "xetex", &|k| files.get(k).cloned().or_else(|| read.borrow().get(k).cloned()))?;
    read.borrow_mut().entry(k.clone()).or_insert_with(|| b.clone());
    Some((k, b))
}

/// kpathsea's format (as Shelf's `search` names it) of an xdvipdfmx lookup.
fn dpx_format(f: Format) -> &'static str {
    match f {
        Format::Fontmap => "map",
        Format::Type1 => "type1",
        Format::TrueType => "truetype",
        Format::OpenType => "opentype",
        Format::Cmap => "cmap",
        Format::Sfd => "sfd",
        Format::Enc => "enc",
        Format::Tfm => "tfm",
        Format::Vf => "vf",
        Format::Pict | Format::Tex => "tex",
        _ => "",
    }
}

impl DpxFiles {
    fn get(&mut self, name: &[u8], format: &str) -> Option<(Vec<u8>, Arc<[u8]>)> {
        let t = crate::clock_ns();
        let b = get(&self.files.borrow(), &self.read, &self.shelf, name, format);
        LOOKUPS.with_borrow_mut(|l| {
            l.0 += 1;
            l.1 += u32::from(b.is_none());
            l.2 += (crate::clock_ns() - t) as f64 / 1e6;
        });
        let (k, b) = b?;
        self.read.borrow_mut().entry(name.to_vec()).or_insert_with(|| b.clone());
        Some((k, b))
    }
}

impl Files for DpxFiles {
    fn find(&mut self, name: &[u8], format: Format, _progname: &[u8]) -> Option<Vec<u8>> {
        let ext: &[u8] = match format {
            Format::Fontmap => b".map",
            Format::Type1 => b".pfb",
            Format::TrueType => b".ttf",
            Format::OpenType => b".otf",
            Format::Enc => b".enc",
            Format::Tfm => b".tfm",
            Format::Vf => b".vf",
            Format::Sfd => b".sfd",
            _ => b"",
        };
        let mut tries = vec![name.to_vec()];
        if !ext.is_empty() && !name.ends_with(ext) {
            let mut n = name.to_vec();
            n.extend_from_slice(ext);
            tries.insert(0, n);
        }
        // (the file's key: its texmf path from Shelf, which `read` then takes as is)
        let fmt = dpx_format(format);
        tries.into_iter().find_map(|n| self.get(&n, fmt).map(|(k, _)| k))
    }
    fn read(&mut self, path: &[u8]) -> Option<Arc<[u8]>> {
        self.get(path, "").map(|(_, b)| b)
    }
}

/// A started xdvipdfmx (its configuration and font maps read, ~180 ms in
/// wasm), kept to go on from for the next XDV with the same preamble:
/// what it was started for, and the files it reads.
pub type Started = Option<(Vec<u8>, Live, Session)>;

/// The PDF xelatex makes of `xdv` (`job`.pdf), and each page's glyph runs.
/// A fatal driver error (`Err`) leaves no PDF, as xelatex's pipe makes none.
pub fn to_pdf(xdv: &[u8], job: &[u8], files: BTreeMap<Vec<u8>, Arc<[u8]>>, read: &Read, cache: &shelf::Cache, now: i64, started: &mut Started) -> partex_xdvipdfmx::ctx::Result<(Vec<u8>, Vec<Vec<GlyphRun>>)> {
    // (an XDV the job did not finish, a fatal error's, has no postamble
    // and its 223s: no PDF, as xelatex's pipe makes none of it)
    if xdv.len() < 16 || 15 + usize::from(xdv[14]) > xdv.len() || xdv.last() != Some(&223) {
        return Ok((Vec::new(), Vec::new()));
    }
    let (pre, pages) = split_xdv(xdv);
    if pages.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let options = Options {
        pdf_filename: Some(job.to_vec()),
        // (uncompressed, no object streams: pdfdraw reads the PDF back)
        args: vec![b"-q".to_vec(), b"-E".to_vec(), b"-z0".to_vec(), b"-V4".to_vec()],
        now,
        ..Options::default()
    };
    let deflate: partex_xdvipdfmx::obj::Deflate = Box::new(|level, data| miniz_oxide::deflate::compress_to_vec_zlib(data, u8::try_from(level.clamp(0, 9)).unwrap_or(6)));
    LOOKUPS.with_borrow_mut(|l| *l = (0, 0, 0.0));
    let ms = |a: u64, b: u64| (b - a) as f64 / 1e6;
    let t0 = crate::clock_ns();
    let mut s = match started {
        Some((p, live, s)) if p[..] == xdv[..pre] => {
            *live.borrow_mut() = files;
            s.snapshot()
        }
        _ => {
            let live = Live::new(RefCell::new(files));
            let s = Session::new(options, Box::new(DpxFiles { files: live.clone(), read: read.clone(), shelf: cache.clone() }), deflate, &xdv[..pre])?;
            let copy = s.snapshot();
            *started = Some((xdv[..pre].to_vec(), live, s));
            copy
        }
    };
    let t1 = crate::clock_ns();
    let mut out = Vec::new();
    let mut runs = Vec::new();
    for (a, b) in pages {
        let p = s.page(&xdv[a..b])?;
        out.extend(p.pdf);
        runs.push(p.glyph_runs);
    }
    let t2 = crate::clock_ns();
    out.extend(s.finish()?);
    let t3 = crate::clock_ns();
    let (n, miss, lms) = LOOKUPS.with_borrow(|l| *l);
    COST.with_borrow_mut(|c| *c = format!("start {:.1} ms, pages {:.1} ms, end {:.1} ms; {n} lookups ({miss} missed) {lms:.1} ms", ms(t0, t1), ms(t1, t2), ms(t2, t3)));
    Ok((out, runs))
}

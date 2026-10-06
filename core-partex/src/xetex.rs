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
use std::fmt::Write as _;
use std::sync::Arc;

use partex_xdvipdfmx::api::{Options, Session, split_xdv};
use partex_xdvipdfmx::api::{GlyphRun, GlyphSource};
use partex_xdvipdfmx::io::{Files, Format};

use crate::{esc, shelf};

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

/// A font program read with skrifa, for its outlines and its characters.
pub struct Face {
    data: Arc<[u8]>,
    index: u32,
    /// Glyph → the character its cmap maps to it (the first), for the text.
    chars: HashMap<u16, char>,
    upem: f32,
}

impl Face {
    fn new(data: Arc<[u8]>, index: u32) -> Option<Face> {
        use skrifa::MetadataProvider;
        use skrifa::raw::TableProvider;
        let f = skrifa::FontRef::from_index(&data, index).ok()?;
        let upem = f.head().map_or(1000.0, |h| f32::from(h.units_per_em()));
        let mut chars = HashMap::new();
        for (c, g) in f.charmap().mappings() {
            if let (Ok(g), Some(c)) = (u16::try_from(g.to_u32()), char::from_u32(c)) {
                chars.entry(g).or_insert(c);
            }
        }
        Some(Face { data, index, chars, upem })
    }

    /// Glyph `gid`'s advance, in ems.
    fn advance(&self, gid: u16) -> f64 {
        use skrifa::MetadataProvider;
        use skrifa::instance::{LocationRef, Size};
        let Ok(f) = skrifa::FontRef::from_index(&self.data, self.index) else { return 0.5 };
        let a = f.glyph_metrics(Size::unscaled(), LocationRef::default()).advance_width(skrifa::GlyphId::new(u32::from(gid))).unwrap_or(500.0);
        f64::from(a / self.upem)
    }

    /// Glyph `gid`'s outline as SVG path data in 1/1000 em, y up.
    fn path(&self, gid: u16) -> Option<String> {
        use skrifa::MetadataProvider;
        use skrifa::instance::{LocationRef, Size};
        use skrifa::outline::{DrawSettings, OutlinePen};
        struct Pen(String, f32);
        impl OutlinePen for Pen {
            fn move_to(&mut self, x: f32, y: f32) {
                let k = self.1;
                let _ = write!(self.0, "M{:.0} {:.0}", x * k, y * k);
            }
            fn line_to(&mut self, x: f32, y: f32) {
                let k = self.1;
                let _ = write!(self.0, "L{:.0} {:.0}", x * k, y * k);
            }
            fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
                let k = self.1;
                let _ = write!(self.0, "Q{:.0} {:.0} {:.0} {:.0}", x1 * k, y1 * k, x * k, y * k);
            }
            fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
                let k = self.1;
                let _ = write!(self.0, "C{:.0} {:.0} {:.0} {:.0} {:.0} {:.0}", x1 * k, y1 * k, x2 * k, y2 * k, x * k, y * k);
            }
            fn close(&mut self) {
                self.0.push('Z');
            }
        }
        let f = skrifa::FontRef::from_index(&self.data, self.index).ok()?;
        let g = f.outline_glyphs().get(skrifa::GlyphId::new(u32::from(gid)))?;
        let mut pen = Pen(String::new(), 1000.0 / self.upem);
        g.draw(DrawSettings::unhinted(Size::unscaled(), LocationRef::default()), &mut pen).ok()?;
        Some(pen.0)
    }
}

/// A font program read for its outlines: an OpenType/TrueType face
/// (skrifa), or a Type 1 font (a TFM font's, from its map entry).
pub enum Prog {
    Otf(Face),
    T1(crate::type1::Type1),
}

/// Font programs read, by (file, face index), kept across builds (`None`: unreadable).
pub type Faces = HashMap<(Vec<u8>, u32), Option<Prog>>;

/// What the glyph runs add to a page's draw list: the outline fonts' ids
/// (`F`), the outlines (`g`, `"fr:glyph"`), and the runs (`t`: the glyphs,
/// and their text for selecting), `fr` counted from `f0`.
#[derive(Default)]
pub struct Extra {
    pub fonts: Vec<String>,
    pub g: String,
    pub t: String,
}

/// A run's font program (file, face) and its glyph: a gid, or a Type 1
/// code and name. `None`: drawn some other way (a CMap's composite font).
fn glyph_of(s: &GlyphSource) -> Option<((&[u8], u32), u16, Option<&[u8]>)> {
    match s {
        GlyphSource::Native { font_file, face_index, gid } | GlyphSource::TrueType { font_file, face_index, gid } | GlyphSource::OpenType { font_file, face_index, gid } => {
            Some(((font_file, *face_index), *gid, None))
        }
        GlyphSource::Type1 { font_file, glyph_name, code } => Some(((font_file, u32::MAX), u16::from(*code), Some(glyph_name))),
        GlyphSource::Other { .. } => None,
    }
}

/// The draw list's additions for a page's glyph runs, page height `h`
/// (bp; the runs' y is up from the bottom), font refs from `f0`. A run
/// whose transform (`ctm`'s linear part times `tm`) is not the plain
/// `size` scale is drawn alone with its matrix (rotated, slanted,
/// extended text); the others in runs along a baseline.
pub fn extra(runs: &[GlyphRun], h: f64, f0: usize, faces: &mut Faces, bytes: &mut dyn FnMut(&[u8]) -> Option<Arc<[u8]>>) -> Extra {
    let mut e = Extra::default();
    let mut ids: HashMap<(Vec<u8>, u32), usize> = HashMap::new();
    let mut drawn: std::collections::HashSet<(usize, u16)> = std::collections::HashSet::new();
    let r2 = |v: f64| (v * 100.0).round() / 100.0;
    let r5 = |v: f64| (v * 1e5).round() / 1e5;
    // (a run's linear map from ems to the page, y up: L·size·Tm)
    let lin = |r: &GlyphRun| {
        let [a, b, c, d, _, _] = r.ctm;
        let [t0, t1, t2, t3] = r.tm;
        let k = r.size;
        [k * (a * t0 + c * t1), k * (b * t0 + d * t1), k * (a * t2 + c * t3), k * (b * t2 + d * t3)]
    };
    let plain = |r: &GlyphRun| {
        let m = lin(r);
        (m[0] - r.size).abs() < 1e-6 && m[1].abs() < 1e-6 && m[2].abs() < 1e-6 && (m[3] - r.size).abs() < 1e-6
    };
    let colour = |r: &GlyphRun| if r.rgba >> 8 == 0 { String::new() } else { format!(",{}", esc(&format!("#{:06x}", r.rgba >> 8))) };
    // (a font program's ref, read once)
    let mut fref = |e: &mut Extra, file: &[u8], face: u32| -> usize {
        *ids.entry((file.to_vec(), face)).or_insert_with(|| {
            let base = String::from_utf8_lossy(rel(file)).rsplit('/').next().unwrap_or("").to_string();
            let id: String = format!("x{}_{}", base, if face == u32::MAX { "t1".into() } else { face.to_string() }).chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
            e.fonts.push(id);
            f0 + e.fonts.len() - 1
        })
    };
    let mut i = 0;
    while i < runs.len() {
        let r0 = &runs[i];
        let Some(((file0, face0), _, _)) = glyph_of(&r0.source) else {
            i += 1;
            continue;
        };
        let fr = fref(&mut e, file0, face0);
        let prog = faces.entry((file0.to_vec(), face0)).or_insert_with(|| {
            let b = bytes(file0)?;
            if face0 == u32::MAX { crate::type1::Type1::from_file(&b).map(Prog::T1) } else { Face::new(b, face0).map(Prog::Otf) }
        });
        // (outline and advance (ems) of a run's glyph)
        let mut outline = |e: &mut Extra, g: u16, name: Option<&[u8]>| -> f64 {
            let Some(p) = prog.as_ref() else { return 0.5 };
            match p {
                Prog::Otf(f) => {
                    if drawn.insert((fr, g))
                        && let Some(d) = f.path(g)
                    {
                        let _ = write!(e.g, "{}\"{fr}:{g}\":{}", if e.g.is_empty() { "" } else { "," }, esc(&d));
                    }
                    f.advance(g)
                }
                Prog::T1(t) => {
                    let n = String::from_utf8_lossy(name.unwrap_or(b".notdef"));
                    if drawn.insert((fr, g))
                        && let Some(d) = t.path(&n)
                    {
                        let _ = write!(e.g, "{}\"{fr}:{g}\":{}", if e.g.is_empty() { "" } else { "," }, esc(&d));
                    }
                    t.width(&n).unwrap_or(500.0) / 1000.0
                }
            }
        };
        // (a transformed glyph: alone, with its matrix in SVG's terms,
        // y down, outlines in 1/1000 em)
        if !plain(r0) {
            let (_, g, name) = glyph_of(&r0.source).unwrap_or(((&[], 0), 0, None));
            outline(&mut e, g, name);
            let m = lin(r0);
            let _ = write!(
                e.t,
                "{}[-1,{},{},{},\"\",{fr},[{g}],{},[{},{},{},{}]]",
                if e.t.is_empty() { "" } else { "," },
                r2(r0.size),
                r2(h - r0.y),
                esc(&r2(r0.x).to_string()),
                if r0.rgba >> 8 == 0 { "null".to_string() } else { esc(&format!("#{:06x}", r0.rgba >> 8)) },
                r5(m[0] / 1000.0),
                r5(-m[1] / 1000.0),
                r5(m[2] / 1000.0),
                r5(-m[3] / 1000.0)
            );
            i += 1;
            continue;
        }
        let mut j = i;
        let (mut xs, mut codes, mut txt, mut txs) = (String::new(), String::new(), String::new(), String::new());
        // (where the glyph before ended: a gap wider than a fifth of the
        // size is a word space, which TeX sets as glue, not a glyph)
        let mut end: Option<f64> = None;
        // (a cluster whose ActualText was taken: its other glyphs add no text)
        let mut cluster_done: Option<u32> = None;
        while j < runs.len() {
            let r = &runs[j];
            let Some(((file, face), g, name)) = glyph_of(&r.source) else { break };
            if file != file0 || face != face0 || (r.size - r0.size).abs() > 1e-6 || (r.y - r0.y).abs() > 1e-3 || r.rgba != r0.rgba || !plain(r) {
                break;
            }
            let _ = write!(xs, "{}{}", if xs.is_empty() { "" } else { " " }, r2(r.x));
            let _ = write!(codes, "{}{g}", if codes.is_empty() { "" } else { "," });
            let adv = outline(&mut e, g, name);
            if let Some(e) = end
                && r.x - e > 0.2 * r.size
            {
                txt.push(' ');
                let _ = write!(txs, " {}", r2(e));
            }
            if cluster_done != Some(r.cluster)
                && let Some(t) = &r.text
            {
                let n = t.chars().count().max(1);
                for (k, c) in t.chars().enumerate() {
                    txt.push(c);
                    let _ = write!(txs, "{}{}", if txs.is_empty() { "" } else { " " }, r2(r.x + adv * r.size * k as f64 / n as f64));
                }
                if r.actual_text {
                    cluster_done = Some(r.cluster);
                }
            }
            end = Some(r.x + adv * r.size);
            j += 1;
        }
        let _ = write!(e.t, "{}[-1,{},{},{},\"\",{fr},[{codes}]{}]", if e.t.is_empty() { "" } else { "," }, r2(r0.size), r2(h - r0.y), esc(&xs), colour(r0));
        // (the text over the glyphs, invisible: for selecting and finding)
        if !txt.is_empty() {
            let _ = write!(e.t, ",[0,{},{},{},{},1]", r2(r0.size), r2(h - r0.y), esc(&txs), esc(&txt));
        }
        i = j.max(i + 1);
    }
    e
}

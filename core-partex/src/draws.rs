//! A shipped page ([`Page`], partex's page IR) as the panel's draw list:
//! JSON in PDF points (bp) from the page's top left, `{"w","h","f": [font
//! names], "t": [[x, y, size, font, text, width]], "r": [[x, y, w, h]]}`,
//! the same as `core/`'s. Positions are tex.web's `hlist_out` /
//! `vlist_out` (§619, §629) over the IR, with the DVI origin one inch in
//! from the top left (plus `\hoffset`, `\voffset`). Runs of characters
//! (same font and baseline, each where the last ended, give or take a
//! kern) are one text, `width` wide as TeX set it.

use std::fmt::Write as _;

use partex_core::pageir::{Item, LeaderKind, Page};

use crate::esc;

/// US Letter (LaTeX's default), in scaled points: 612 × 792 bp.
const LETTER: (i64, i64) = (40_258_437, 52_099_154);

/// TeX's one inch, in scaled points (as `dvi_h`/`dvi_v` start, §617).
pub const ONE_INCH: i64 = 4_736_287;

#[allow(clippy::cast_precision_loss)]
fn bp(x: i64) -> f64 {
    (x as f64 / 65536.0 * 72.0 / 72.27 * 100.0).round() / 100.0
}

struct Walk<'a> {
    page: &'a Page,
    out: Vec<Draw>,
}

/// What a page draws, in scaled points from the page's top left.
#[derive(Clone)]
pub enum Draw {
    Char { x: i64, y: i64, font: i32, ch: i32, width: i64 },
    Rule { x: i64, y: i64, w: i64, h: i64 },
}

/// A TeX font: its name (`cmr10`) and size, in scaled points.
#[derive(Clone)]
pub struct Font {
    pub name: String,
    pub size: i64,
}

impl Walk<'_> {
    fn head(&self, i: usize) -> (bool, i64, i64, i64, i64, usize) {
        match self.page.items[i] {
            Item::Box { vertical, width, height, depth, shift, len, .. } => {
                (vertical, width.into(), height.into(), depth.into(), shift.into(), len as usize)
            }
            _ => (false, 0, 0, 0, 0, 0),
        }
    }

    /// Box `i` with its reference point at `(h, v)` (an hbox's baseline
    /// left end; a vbox's too, its top `height` above).
    fn list(&mut self, i: usize, h: i64, v: i64) {
        let (vertical, _, height, _, _, len) = self.head(i);
        let items = i + 1..i + 1 + len;
        if vertical {
            self.vlist(items, h, v - height);
        } else {
            self.hlist(items, h, v);
        }
    }

    fn hlist(&mut self, items: std::ops::Range<usize>, mut h: i64, base: i64) {
        let mut i = items.start;
        while i < items.end {
            match self.page.items[i] {
                Item::Char { font, ch, width, raise } => {
                    let w = i64::from(width);
                    self.out.push(Draw::Char { x: h, y: base - i64::from(raise), font, ch, width: w });
                    h += w;
                }
                Item::Move(w) | Item::Edge { width: w, .. } => h += i64::from(w),
                Item::Rule { height, depth, width } => {
                    let (ht, w) = (i64::from(height) + i64::from(depth), i64::from(width));
                    if ht > 0 && w > 0 {
                        self.out.push(Draw::Rule { x: h, y: base + i64::from(depth) - ht, w, h: ht });
                    }
                    h += w;
                }
                Item::Box { .. } => {
                    let (_, width, _, _, shift, len) = self.head(i);
                    self.list(i, h, base + shift);
                    h += width;
                    i += len;
                }
                Item::Leaders { kind, size } => {
                    i += 1;
                    let (_, lw, _, _, shift, len) = self.head(i);
                    let size = i64::from(size);
                    if lw > 0 {
                        // (§626, without the alignment to the enclosing box)
                        let n = size / lw;
                        let mut x = h + if kind == LeaderKind::Aligned { size - n * lw } else { (size - n * lw) / 2 };
                        for _ in 0..n {
                            self.list(i, x, base + shift);
                            x += lw;
                        }
                    }
                    h += size;
                    i += len;
                }
                Item::Missing { .. } | Item::Special { .. } => {}
                Item::Cut => return,
            }
            i += 1;
        }
    }

    fn vlist(&mut self, items: std::ops::Range<usize>, left: i64, top: i64) {
        let mut v = top;
        let mut i = items.start;
        while i < items.end {
            match self.page.items[i] {
                Item::Move(d) => v += i64::from(d),
                Item::Rule { height, depth, width } => {
                    let (ht, w) = (i64::from(height) + i64::from(depth), i64::from(width));
                    if ht > 0 && w > 0 {
                        self.out.push(Draw::Rule { x: left, y: v, w, h: ht });
                    }
                    v += ht;
                }
                Item::Box { .. } => {
                    let (_, _, height, depth, shift, len) = self.head(i);
                    v += height;
                    self.list(i, left + shift, v);
                    v += depth;
                    i += len;
                }
                Item::Leaders { size, .. } => {
                    i += 1;
                    let (.., len) = self.head(i);
                    v += i64::from(size);
                    i += len;
                }
                Item::Char { .. } | Item::Missing { .. } | Item::Edge { .. } | Item::Special { .. } => {}
                Item::Cut => return,
            }
            i += 1;
        }
    }
}

/// The page size a `\special{papersize=W,H}` sets (geometry, hyperref,
/// typearea in DVI mode), in scaled points.
fn papersize(s: &str) -> Option<(i64, i64)> {
    let at = s.rfind("papersize=")?;
    let rest = &s[at + 10..];
    let (w, rest) = rest.split_once(',')?;
    let h: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '.').collect();
    Some((dimen(w.trim())?, dimen(&h)?))
}

#[allow(clippy::cast_possible_truncation)]
fn dimen(s: &str) -> Option<i64> {
    let unit_at = s.find(|c: char| c.is_ascii_alphabetic())?;
    let (n, u) = s.split_at(unit_at);
    let n: f64 = n.parse().ok()?;
    let pt = match u {
        "pt" => 1.0,
        "bp" => 72.27 / 72.0,
        "in" => 72.27,
        "mm" => 72.27 / 25.4,
        "cm" => 72.27 / 2.54,
        _ => return None,
    };
    Some((n * pt * 65536.0).round() as i64)
}

/// The PDF base font the panel paints TeX font `name` in.
fn base_font(name: &str) -> &'static str {
    if name.starts_with("cmbx") || name.starts_with("cmb") {
        "Times-Bold"
    } else if name.starts_with("cmti") || name.starts_with("cmsl") || name.starts_with("cmmi") || name.starts_with("cmit") {
        "Times-Italic"
    } else if name.starts_with("cmtt") || name.starts_with("cmvtt") {
        "Courier"
    } else if name.starts_with("cmss") {
        "Helvetica"
    } else {
        "Times-Roman"
    }
}

/// A character of TeX font `name` as text: OT1's ligatures, dashes and
/// quotes spelled out; the math fonts' letters and a few symbols.
fn glyph(name: &str, ch: i32) -> String {
    let Ok(c) = u8::try_from(ch) else { return String::new() };
    if name.starts_with("cmsy") {
        return match c {
            0 => "\u{2212}",
            1 => "\u{22c5}",
            2 => "\u{d7}",
            3 => "\u{2217}",
            14 => "\u{2218}",
            15 => "\u{2022}",
            20 => "\u{2264}",
            21 => "\u{2265}",
            24 => "\u{223c}",
            25 => "\u{2248}",
            33 => "\u{2192}",
            48 => "\u{2032}",
            49 => "\u{221e}",
            50 => "\u{2208}",
            102 => "{",
            103 => "}",
            106 => "|",
            _ => "",
        }
        .into();
    }
    if name.starts_with("cmex") {
        return match c {
            0 | 16 | 18 | 32 => "(",
            1 | 17 | 19 | 33 => ")",
            82 | 90 => "\u{222b}",
            80 | 88 => "\u{2211}",
            81 | 89 => "\u{220f}",
            _ => "",
        }
        .into();
    }
    if name.starts_with("cmmi") {
        return match c {
            b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z' => char::from(c).to_string(),
            11..=23 => ["α", "β", "γ", "δ", "ε", "ζ", "η", "θ", "ι", "κ", "λ", "μ", "ν"][usize::from(c - 11)].into(),
            24..=33 => ["ξ", "π", "ρ", "σ", "τ", "υ", "φ", "χ", "ψ", "ω"][usize::from(c - 24)].into(),
            58 => ".".into(),
            59 => ",".into(),
            60 => "<".into(),
            61 => "/".into(),
            62 => ">".into(),
            _ => String::new(),
        };
    }
    if name.starts_with("cmtt") {
        return match c {
            13 => "'".into(),
            32..=126 => char::from(c).to_string(),
            _ => String::new(),
        };
    }
    match c {
        11 => "ff".into(),
        12 => "fi".into(),
        13 => "fl".into(),
        14 => "ffi".into(),
        15 => "ffl".into(),
        b'"' => "\u{201d}".into(),
        b'\\' => "\u{201c}".into(),
        b'{' => "\u{2013}".into(),
        b'|' => "\u{2014}".into(),
        b'`' => "\u{2018}".into(),
        b'\'' => "\u{2019}".into(),
        b'<' | b'>' | b'_' | b'}' | b'~' => String::new(),
        33..=126 => char::from(c).to_string(),
        _ => String::new(),
    }
}

/// `page` as the panel's draw list.
#[must_use]
pub fn draws_json(page: &Page) -> String {
    let mut w = Walk { page, out: Vec::new() };
    if !page.items.is_empty() {
        let (_, _, height, ..) = w.head(0);
        let (h0, v0) = (ONE_INCH + i64::from(page.h_offset), ONE_INCH + i64::from(page.v_offset));
        // (§640: the box's top at the origin, its reference point `height` below)
        w.list(0, h0, v0 + height);
    }
    let fonts = page
        .fonts
        .iter()
        .map(|d| (d.font, Font { name: String::from_utf8_lossy(&d.name).into_owned(), size: i64::from(d.size) }))
        .collect();
    json(&w.out, &fonts, &String::from_utf8_lossy(&page.specials), 0)
}

/// Draws as the panel's draw list; `origin` is added to both coordinates
/// (a DVI file's are from the one-inch origin: [`ONE_INCH`]).
#[must_use]
pub fn json(draws: &[Draw], fonts: &std::collections::BTreeMap<i32, Font>, specials: &str, origin: i64) -> String {
    let (pw, ph) = papersize(specials).unwrap_or(LETTER);
    let font = |f: i32| fonts.get(&f);
    let mut names: Vec<&str> = Vec::new();
    let (mut t, mut r) = (String::new(), String::new());
    // (the run being gathered: start x, y, font, text, where it ends)
    let mut run: Option<(i64, i64, i32, String, i64)> = None;
    let mut flush = |run: &mut Option<(i64, i64, i32, String, i64)>, t: &mut String| {
        let Some((x, y, f, text, end)) = run.take() else { return };
        let Some(d) = font(f).filter(|_| !text.is_empty()) else { return };
        let base = base_font(&d.name);
        let k = names.iter().position(|n| *n == base).unwrap_or_else(|| {
            names.push(base);
            names.len() - 1
        });
        let _ = write!(
            t,
            "{}[{},{},{},{k},{},{}]",
            if t.is_empty() { "" } else { "," },
            bp(x + origin),
            bp(y + origin),
            bp(d.size),
            esc(&text),
            bp(end - x)
        );
    };
    for d in draws {
        match *d {
            Draw::Char { x, y, font: f, ch, width } => {
                let size = font(f).map_or(655_360, |d| d.size);
                let joins = run.as_ref().is_some_and(|(_, ry, rf, _, end)| *ry == y && *rf == f && (x - end).abs() <= size / 8);
                if !joins {
                    flush(&mut run, &mut t);
                    run = Some((x, y, f, String::new(), x));
                }
                let name = font(f).map(|d| d.name.as_str()).unwrap_or_default();
                let run = run.as_mut().unwrap();
                run.3.push_str(&glyph(name, ch));
                run.4 = x + width;
            }
            Draw::Rule { x, y, w, h } => {
                let _ = write!(r, "{}[{},{},{},{}]", if r.is_empty() { "" } else { "," }, bp(x + origin), bp(y + origin), bp(w), bp(h));
            }
        }
    }
    flush(&mut run, &mut t);
    let f: Vec<String> = names.iter().map(|f| esc(f)).collect();
    format!("{{\"w\":{},\"h\":{},\"f\":[{}],\"t\":[{t}],\"r\":[{r}]}}", bp(pw), bp(ph), f.join(","))
}

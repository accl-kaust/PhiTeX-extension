//! A DVI file's pages as draws (characters and rules at their positions),
//! for the panel's draw list. The file is what the link wrote, so a page is
//! right after any rebuild, whichever steps ran again. Characters advance by
//! their TFM widths (the fonts' metrics are among the host's files).

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::draws::{Draw, Font};

/// A font's character widths, in its size's scaled points.
fn tfm_widths(tfm: &[u8], size: i64) -> Option<BTreeMap<i32, i64>> {
    let h = |i: usize| -> Option<usize> { Some(usize::from(u16::from_be_bytes([*tfm.get(2 * i)?, *tfm.get(2 * i + 1)?]))) };
    let (lh, bc, ec, nw) = (h(1)?, h(2)?, h(3)?, h(4)?);
    let info = 4 * (6 + lh);
    let widths = info + 4 * (ec + 1).saturating_sub(bc);
    let word = |at: usize| -> Option<i64> { Some(i64::from(i32::from_be_bytes(tfm.get(at..at + 4)?.try_into().ok()?))) };
    let mut m = BTreeMap::new();
    for c in bc..=ec {
        let wi = usize::from(*tfm.get(info + 4 * (c - bc))?);
        if wi == 0 || wi >= nw {
            continue;
        }
        // (a fix_word times the size: §571's scaling, in 64-bit)
        let w = word(widths + 4 * wi)? * size >> 20;
        m.insert(i32::try_from(c).ok()?, w);
    }
    Some(m)
}

/// One page: its draws, the fonts they name, its specials' text.
pub struct DviPage {
    pub draws: Vec<Draw>,
    pub specials: String,
    /// The page's bytes from `bop` to `eop` (its hash).
    pub bytes: Range,
}

pub type Range = std::ops::Range<usize>;

/// The pages of `dvi`, and the fonts by DVI number. `tfm` finds a font's
/// metrics by name.
pub fn pages(dvi: &[u8], tfm: &dyn Fn(&str) -> Option<Arc<[u8]>>) -> (Vec<DviPage>, BTreeMap<i32, Font>) {
    let mut fonts: BTreeMap<i32, Font> = BTreeMap::new();
    let mut widths: BTreeMap<i32, BTreeMap<i32, i64>> = BTreeMap::new();
    let mut out = Vec::new();
    let mut p = 0usize;
    let u = |p: &mut usize, n: usize| -> i64 {
        let mut v: i64 = 0;
        for k in 0..n {
            v = (v << 8) | i64::from(*dvi.get(*p + k).unwrap_or(&0));
        }
        *p += n;
        v
    };
    let s = |p: &mut usize, n: usize| -> i64 {
        let v = u(p, n);
        let bits = 8 * n as u32;
        if v >= 1 << (bits - 1) { v - (1 << bits) } else { v }
    };
    // (state: h, v, w, x, y, z; the stack; the current font)
    let (mut h, mut v, mut w, mut x, mut y, mut z) = (0i64, 0i64, 0i64, 0i64, 0i64, 0i64);
    let mut stack: Vec<[i64; 6]> = Vec::new();
    let mut f = 0i32;
    let mut page: Option<(DviPage, usize)> = None;
    while p < dvi.len() {
        let at = p;
        let op = dvi[p];
        p += 1;
        let set = |c: i64, advance: bool, h: &mut i64, page: &mut Option<(DviPage, usize)>| {
            let ch = i32::try_from(c).unwrap_or(0);
            let wd = widths.get(&f).and_then(|m| m.get(&ch)).copied().unwrap_or(0);
            if let Some((pg, _)) = page {
                pg.draws.push(Draw::Char { x: *h, y: v, font: f, ch, width: wd });
            }
            if advance {
                *h += wd;
            }
        };
        match op {
            0..=127 => set(i64::from(op), true, &mut h, &mut page),
            128..=131 => {
                let c = u(&mut p, usize::from(op - 127));
                set(c, true, &mut h, &mut page);
            }
            133..=136 => {
                let c = u(&mut p, usize::from(op - 132));
                set(c, false, &mut h, &mut page);
            }
            132 | 137 => {
                let (a, b) = (s(&mut p, 4), s(&mut p, 4));
                if a > 0 && b > 0 && let Some((pg, _)) = &mut page {
                    pg.draws.push(Draw::Rule { x: h, y: v - a, w: b, h: a });
                }
                if op == 132 {
                    h += b;
                }
            }
            138 => {}
            139 => {
                p += 44;
                (h, v, w, x, y, z) = (0, 0, 0, 0, 0, 0);
                stack.clear();
                page = Some((DviPage { draws: Vec::new(), specials: String::new(), bytes: at..at }, at));
            }
            140 => {
                if let Some((mut pg, start)) = page.take() {
                    pg.bytes = start..p;
                    out.push(pg);
                }
            }
            141 => stack.push([h, v, w, x, y, z]),
            142 => {
                if let Some(t) = stack.pop() {
                    [h, v, w, x, y, z] = t;
                }
            }
            143..=146 => h += s(&mut p, usize::from(op - 142)),
            147 => h += w,
            148..=151 => {
                w = s(&mut p, usize::from(op - 147));
                h += w;
            }
            152 => h += x,
            153..=156 => {
                x = s(&mut p, usize::from(op - 152));
                h += x;
            }
            157..=160 => v += s(&mut p, usize::from(op - 156)),
            161 => v += y,
            162..=165 => {
                y = s(&mut p, usize::from(op - 161));
                v += y;
            }
            166 => v += z,
            167..=170 => {
                z = s(&mut p, usize::from(op - 166));
                v += z;
            }
            171..=234 => f = i32::from(op - 171),
            235..=238 => f = i32::try_from(u(&mut p, usize::from(op - 234))).unwrap_or(0),
            239..=242 => {
                let k = usize::try_from(u(&mut p, usize::from(op - 238))).unwrap_or(0);
                let b = dvi.get(p..p + k).unwrap_or(&[]);
                if let Some((pg, _)) = &mut page {
                    pg.specials.push_str(&String::from_utf8_lossy(b));
                    pg.specials.push('\n');
                }
                p += k;
            }
            243..=246 => {
                let k = i32::try_from(u(&mut p, usize::from(op - 242))).unwrap_or(0);
                p += 4; // (checksum)
                let size = s(&mut p, 4);
                p += 4; // (design size)
                let (a, l) = (usize::from(dvi[p]), usize::from(dvi[p + 1]));
                p += 2;
                let name = String::from_utf8_lossy(dvi.get(p + a..p + a + l).unwrap_or(&[])).into_owned();
                p += a + l;
                if !widths.contains_key(&k)
                    && let Some(m) = tfm(&name).and_then(|t| tfm_widths(&t, size))
                {
                    widths.insert(k, m);
                }
                fonts.insert(k, Font { name, size });
            }
            247 => {
                p += 14;
                let k = usize::from(dvi[p - 1]);
                p += k;
            }
            // (post, post_post: the pages are done)
            _ => break,
        }
    }
    (out, fonts)
}

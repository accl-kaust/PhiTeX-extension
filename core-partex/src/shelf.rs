//! Shelf, from inside the job (wasm): a file TeX asks for and the host lacks
//! is resolved by the worker to its texmf path (`phitex.resolve`: as
//! kpathsea would for the session's engine and the file's format, by
//! Shelf's release.json `search`; the extension's resolve.ts) and fetched
//! there and then (`phitex.fetch`: the path's pack and the packs its loading
//! reads with that engine, a synchronous request), so the job never stops at
//! a file TeX Live has, as pdflatex on a full TeX Live doesn't. Files are
//! kept by path, and each name's path, for every later build of the
//! session: a name is resolved once, a pack fetched once.
//!
//! `resolve` takes `engine TAB format TAB name` and answers the key (a
//! texmf path, or a name of the extension's bundled texmf/); `fetch` takes
//! `engine TAB key` and answers the packs as Shelf serves them, framed:
//! `u32 n, (u32 len, gzip bytes) × n` (or a pack not gzipped: a bundled
//! file); a pack is the gzip of `u32 n, (u32 len, path, u32 len, bytes) × n`
//! (little-endian). Both copied by `fetch_copy`.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use partex_core::host::FileKind;

/// The files fetched (every file of every pack, by path), and each name's
/// path (`engine TAB format TAB name` → path; None: Shelf has none).
#[derive(Default)]
pub struct Store {
    files: HashMap<Vec<u8>, Arc<[u8]>>,
    names: HashMap<Vec<u8>, Option<Vec<u8>>>,
}

pub type Cache = Rc<RefCell<Store>>;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "phitex")]
unsafe extern "C" {
    fn resolve(q: *const u8, len: usize) -> u32;
    fn fetch(q: *const u8, len: usize) -> u32;
    fn fetch_copy(dst: *mut u8);
}

/// kpathsea's format of a file kind, as Shelf's `search` names them ("":
/// none, any path with the name).
#[must_use]
pub fn format(kind: FileKind) -> &'static str {
    match kind {
        FileKind::Tex | FileKind::Pict => "tex",
        FileKind::Tfm => "tfm",
        FileKind::FontMap => "map",
        FileKind::Type1 => "type1",
        FileKind::Enc => "enc",
        FileKind::Vf => "vf",
        FileKind::TrueType => "truetype",
        FileKind::OpenType => "opentype",
        FileKind::MiscFonts => "misc",
        FileKind::Bst => "bst",
        FileKind::Bib => "bib",
        FileKind::Ist => "ist",
        _ => "",
    }
}

/// `name`'s key and bytes for `engine` (Shelf's: pdftex, xetex) and
/// `format`: resolved by the worker (once a name), then `have`'s (the
/// host's files: a project's prefetched packages, by path), the packs
/// fetched before, or fetched now.
pub fn find(cache: &Cache, name: &[u8], format: &str, engine: &str, have: &dyn Fn(&[u8]) -> Option<Arc<[u8]>>) -> Option<(Vec<u8>, Arc<[u8]>)> {
    let mut q = format!("{engine}\t{format}\t").into_bytes();
    q.extend_from_slice(name);
    let known = cache.borrow().names.get(&q).cloned();
    let key = match known {
        Some(k) => k?,
        None => {
            let k = call(|p, l| unsafe_resolve(p, l), &q);
            cache.borrow_mut().names.insert(q, k.clone());
            k?
        }
    };
    if let Some(b) = have(&key).or_else(|| cache.borrow().files.get(&key).cloned()) {
        return Some((key, b));
    }
    let mut q = format!("{engine}\t").into_bytes();
    q.extend_from_slice(&key);
    let framed = call(|p, l| unsafe_fetch(p, l), &q)?;
    let mut c = cache.borrow_mut();
    for f in frames(&framed) {
        // (a pack as Shelf serves it, gzip; or the worker's own, a bundled file, as is)
        let Some(pack) = (if f.starts_with(&[0x1f, 0x8b]) { gunzip(f) } else { Some(f.to_vec()) }) else { continue };
        for (n, b) in unpack(&pack) {
            c.files.entry(n).or_insert_with(|| Arc::from(b));
        }
    }
    let b = c.files.get(&key).cloned()?;
    Some((key, b))
}

#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)]
fn unsafe_resolve(p: *const u8, l: usize) -> u32 {
    unsafe { resolve(p, l) }
}
#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)]
fn unsafe_fetch(p: *const u8, l: usize) -> u32 {
    unsafe { fetch(p, l) }
}
#[cfg(not(target_arch = "wasm32"))]
fn unsafe_resolve(_: *const u8, _: usize) -> u32 {
    0
}
#[cfg(not(target_arch = "wasm32"))]
fn unsafe_fetch(_: *const u8, _: usize) -> u32 {
    0
}

/// An import's answer to `q` (0: none), copied by `fetch_copy`.
fn call(f: impl Fn(*const u8, usize) -> u32, q: &[u8]) -> Option<Vec<u8>> {
    let n = f(q.as_ptr(), q.len()) as usize;
    if n == 0 {
        return None;
    }
    let mut b = vec![0u8; n];
    copy(&mut b);
    Some(b)
}

#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)]
fn copy(b: &mut [u8]) {
    unsafe { fetch_copy(b.as_mut_ptr()) };
}
#[cfg(not(target_arch = "wasm32"))]
fn copy(_: &mut [u8]) {}

/// Whether this host can fetch (the extension's worker: wasm).
pub fn available() -> bool {
    cfg!(target_arch = "wasm32")
}


fn u32le(b: &[u8], at: usize) -> Option<usize> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?) as usize)
}

/// The worker's frames: each a pack's gzip bytes.
fn frames(b: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let Some(n) = u32le(b, 0) else { return out };
    let mut at = 4;
    for _ in 0..n {
        let Some(len) = u32le(b, at) else { break };
        let Some(f) = b.get(at + 4..at + 4 + len) else { break };
        out.push(f);
        at += 4 + len;
    }
    out
}

/// A pack's files.
fn unpack(b: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut out = Vec::new();
    let Some(n) = u32le(b, 0) else { return out };
    let mut at = 4;
    for _ in 0..n {
        let Some(nl) = u32le(b, at) else { break };
        let Some(name) = b.get(at + 4..at + 4 + nl) else { break };
        at += 4 + nl;
        let Some(bl) = u32le(b, at) else { break };
        let Some(bytes) = b.get(at + 4..at + 4 + bl) else { break };
        at += 4 + bl;
        out.push((name.to_vec(), bytes.to_vec()));
    }
    out
}

/// A gzip member's data (RFC 1952): the header's optional fields skipped,
/// the deflate stream inflated.
fn gunzip(b: &[u8]) -> Option<Vec<u8>> {
    if b.get(..3)? != [0x1f, 0x8b, 8] {
        return None;
    }
    let flg = b[3];
    let mut at = 10;
    if flg & 4 != 0 {
        at += 2 + u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?) as usize;
    }
    for bit in [8, 16] {
        if flg & bit != 0 {
            at += b.get(at..)?.iter().position(|&c| c == 0)? + 1;
        }
    }
    if flg & 2 != 0 {
        at += 2;
    }
    miniz_oxide::inflate::decompress_to_vec(b.get(at..)?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pack_round_trips() {
        let mut pack = 2u32.to_le_bytes().to_vec();
        for (n, b) in [("a.sty", "x"), ("b.tfm", "yz")] {
            pack.extend((n.len() as u32).to_le_bytes());
            pack.extend(n.as_bytes());
            pack.extend((b.len() as u32).to_le_bytes());
            pack.extend(b.as_bytes());
        }
        // (a gzip member: header, raw deflate, trailer)
        let mut gz = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255];
        gz.extend(miniz_oxide::deflate::compress_to_vec(&pack, 6));
        gz.extend([0; 8]);
        let mut framed = 1u32.to_le_bytes().to_vec();
        framed.extend((gz.len() as u32).to_le_bytes());
        framed.extend(&gz);
        let files: Vec<_> = frames(&framed).into_iter().flat_map(|f| unpack(&gunzip(f).unwrap())).collect();
        assert_eq!(files, vec![(b"a.sty".to_vec(), b"x".to_vec()), (b"b.tfm".to_vec(), b"yz".to_vec())]);
    }
}

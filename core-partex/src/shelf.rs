//! Shelf, from inside the job (wasm): a file TeX asks for and the host lacks
//! is fetched there and then, through the worker (`phitex.fetch`: the name's
//! pack and the packs its loading reads, by Shelf's index, each once, a
//! synchronous request), so the job never stops at a file TeX Live has, as
//! pdflatex on a full TeX Live doesn't. What the packs hold is kept for every
//! later build of the session.
//!
//! The worker answers with the packs as Shelf serves them, framed:
//! `u32 n, (u32 len, gzip bytes) × n` (or a pack not gzipped: the
//! extension's bundled files); a pack is the gzip of
//! `u32 n, (u32 len, name, u32 len, bytes) × n` (little-endian).
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// Every file of every pack fetched, by name.
pub type Cache = Rc<RefCell<HashMap<Vec<u8>, Vec<u8>>>>;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "phitex")]
unsafe extern "C" {
    /// The packs for `name` not given yet: their framed length, 0 if none
    /// (Shelf has no such name, or every pack was given), the bytes then
    /// copied by `fetch_copy`.
    fn fetch(name: *const u8, len: usize) -> u32;
    fn fetch_copy(dst: *mut u8);
}

/// Whether this host can fetch (the extension's worker: wasm).
pub fn available() -> bool {
    cfg!(target_arch = "wasm32")
}

/// `name`'s bytes: from the packs fetched before, or fetched now.
pub fn get(cache: &Cache, name: &[u8]) -> Option<Vec<u8>> {
    if let Some(b) = cache.borrow().get(name) {
        return Some(b.clone());
    }
    let framed = fetch_framed(name)?;
    let mut c = cache.borrow_mut();
    for f in frames(&framed) {
        // (a pack as Shelf serves it, gzip; or the worker's own, a bundled file, as is)
        let pack = if f.starts_with(&[0x1f, 0x8b]) { gunzip(f)? } else { f.to_vec() };
        for (n, b) in unpack(&pack) {
            c.entry(n).or_insert(b);
        }
    }
    c.get(name).cloned()
}

#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)]
fn fetch_framed(name: &[u8]) -> Option<Vec<u8>> {
    let n = unsafe { fetch(name.as_ptr(), name.len()) } as usize;
    if n == 0 {
        return None;
    }
    let mut b = vec![0u8; n];
    unsafe { fetch_copy(b.as_mut_ptr()) };
    Some(b)
}

#[cfg(not(target_arch = "wasm32"))]
fn fetch_framed(_: &[u8]) -> Option<Vec<u8>> {
    None
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

//! `\write18`, from inside the job (wasm): the command the engine allowed
//! (restricted shell escape, TeX Live's list: in practice `latexminted`) is
//! run by the worker, in Pyodide (the engine's tools/minted-pyodide:
//! latexminted and Pygments over an in-memory directory), and what it made
//! comes back to the build. As Shelf's `fetch`, two imports, no call back
//! into the module while it runs:
//!
//! - `system_run(cmd, files)`: the files the command may read, framed
//!   `u32 n, (u32 len, name, u32 len, bytes) × n`; the length of what it
//!   did, then copied by `system_copy`: `i32 status`, the files it made or
//!   changed (framed), the names it removed (framed, no bytes).
//!
//! The worker loads the runner only for a project that uses minted
//! (`ph_set_system`); else this host runs no commands, as before.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Whether the worker has a runner loaded (`ph_set_system`).
pub static ON: AtomicBool = AtomicBool::new(false);

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "phitex")]
unsafe extern "C" {
    fn system_run(cmd: *const u8, cmd_len: usize, files: *const u8, files_len: usize) -> u32;
    fn system_copy(dst: *mut u8);
}

/// Whether commands run here.
pub fn on() -> bool {
    cfg!(target_arch = "wasm32") && ON.load(Ordering::Relaxed)
}

fn frame(files: &BTreeMap<&[u8], &[u8]>) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&u32::try_from(files.len()).unwrap_or(0).to_le_bytes());
    for (n, b) in files {
        out.extend_from_slice(&u32::try_from(n.len()).unwrap_or(0).to_le_bytes());
        out.extend_from_slice(n);
        out.extend_from_slice(&u32::try_from(b.len()).unwrap_or(0).to_le_bytes());
        out.extend_from_slice(b);
    }
    out
}

/// One framed list from `b`, and what follows it.
fn unframe(mut b: &[u8]) -> Option<(Vec<(Vec<u8>, Arc<[u8]>)>, &[u8])> {
    fn u32_(b: &mut &[u8]) -> Option<usize> {
        let (a, rest) = b.split_at_checked(4)?;
        *b = rest;
        Some(u32::from_le_bytes(a.try_into().ok()?) as usize)
    }
    let n = u32_(&mut b)?;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let k = u32_(&mut b)?;
        let (name, rest) = b.split_at_checked(k)?;
        b = rest;
        let l = u32_(&mut b)?;
        let (bytes, rest) = b.split_at_checked(l)?;
        b = rest;
        out.push((name.to_vec(), Arc::from(bytes)));
    }
    Some((out, b))
}

/// Run `command` over `files`: its status, the files it made or changed, the names it removed.
pub fn run(command: &[u8], files: &BTreeMap<&[u8], &[u8]>) -> Option<(i32, Vec<(Vec<u8>, Arc<[u8]>)>, Vec<Vec<u8>>)> {
    let out = call(command, &frame(files))?;
    let status = i32::from_le_bytes(out.get(..4)?.try_into().ok()?);
    let (wrote, rest) = unframe(&out[4..])?;
    let (removed, _) = unframe(rest)?;
    Some((status, wrote, removed.into_iter().map(|(n, _)| n).collect()))
}

#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)]
fn call(command: &[u8], framed: &[u8]) -> Option<Vec<u8>> {
    let n = unsafe { system_run(command.as_ptr(), command.len(), framed.as_ptr(), framed.len()) } as usize;
    let mut out = vec![0u8; n];
    unsafe { system_copy(out.as_mut_ptr()) };
    Some(out)
}

#[cfg(not(target_arch = "wasm32"))]
fn call(_command: &[u8], _framed: &[u8]) -> Option<Vec<u8>> {
    None
}

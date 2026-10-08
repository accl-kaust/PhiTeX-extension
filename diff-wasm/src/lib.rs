//! phitex-diff for the browser: `ph_diff` reads a JSON request from the
//! buffer the host filled (`ph_alloc`), and leaves a JSON reply for
//! `ph_out`. Request: `{"old": {path: text}, "new": {path: text}, "main":
//! "main.tex", "markup": latexdiff's --type ("underline", "cfont", …),
//! "subtype": its --subtype ("safe", "color", "marker", …), "add_color",
//! "del_color": an xcolor name or "#RRGGBB"}`.
//! Reply: `{"tex": "…", "changes": [{kind, old: {file, start, end}, new:
//! {…}, old_text, new_text, section, out: [start, end]}]}`, or
//! `{"error": "…"}`. Offsets are UTF-8 bytes, as phitex-diff gives them.

use std::collections::BTreeMap;

use phitex_diff::{ChangeKind, Color, Markup, Options, Subtype, diff};
use serde_json::{Value, json};

static mut OUT: Vec<u8> = Vec::new();

/// `n` bytes for the host to write a request into.
#[unsafe(no_mangle)]
pub extern "C" fn ph_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Give back what `ph_alloc` gave.
///
/// # Safety
/// `p` and `n` as `ph_alloc` gave them.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ph_free(p: *mut u8, n: usize) {
    drop(unsafe { Vec::from_raw_parts(p, 0, n) });
}

fn files(v: &Value) -> BTreeMap<String, String> {
    v.as_object()
        .map(|o| o.iter().filter_map(|(k, t)| Some((k.clone(), t.as_str()?.to_owned()))).collect())
        .unwrap_or_default()
}

fn answer(req: &[u8]) -> Value {
    let Ok(r) = serde_json::from_slice::<Value>(req) else {
        return json!({ "error": "bad request" });
    };
    // (latexdiff's names, any case; a color an xcolor name or #RRGGBB, checked: nothing else reaches the preamble)
    let color = |k: &str| match r[k].as_str() {
        None | Some("") => Ok(None),
        Some(c) => Color::parse(c).map(Some),
    };
    let (add_color, del_color) = match (color("add_color"), color("del_color")) {
        (Ok(a), Ok(d)) => (a, d),
        (Err(e), _) | (_, Err(e)) => return json!({ "error": format!("color: {e}") }),
    };
    let opts = Options {
        markup: r["markup"].as_str().and_then(Markup::parse).unwrap_or_default(),
        subtype: r["subtype"].as_str().and_then(Subtype::parse).unwrap_or_default(),
        add_color,
        del_color,
        ..Options::default()
    };
    let main = r["main"].as_str().unwrap_or("main.tex");
    match diff(&files(&r["old"]), &files(&r["new"]), main, &opts) {
        Err(e) => json!({ "error": e.to_string() }),
        Ok(d) => json!({
            "tex": d.tex,
            "changes": d.changes.iter().map(|c| json!({
                "kind": match c.kind { ChangeKind::Add => "add", ChangeKind::Del => "del", ChangeKind::Change => "change" },
                "old": { "file": c.old.file, "start": c.old.start, "end": c.old.end },
                "new": { "file": c.new.file, "start": c.new.start, "end": c.new.end },
                "old_text": c.old_text,
                "new_text": c.new_text,
                "section": c.section,
                "out": [c.out.start, c.out.end],
            })).collect::<Vec<_>>(),
        }),
    }
}

/// Diff the request in `[p, p + n)` (which this frees); the reply's length (read it with `ph_out`).
///
/// # Safety
/// `p` and `n` as `ph_alloc` gave them, the request written in.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ph_diff(p: *mut u8, n: usize) -> usize {
    let req = unsafe { Vec::from_raw_parts(p, n, n) };
    let out = serde_json::to_vec(&answer(&req)).unwrap_or_default();
    // (one reply at a time: the host copies it out before the next call)
    unsafe {
        OUT = out;
        (*std::ptr::addr_of!(OUT)).len()
    }
}

/// Where the last reply is.
#[unsafe(no_mangle)]
pub extern "C" fn ph_out() -> *const u8 {
    unsafe { (*std::ptr::addr_of!(OUT)).as_ptr() }
}

//! Make the preview's LaTeX format with the engine the extension runs.
//!
//!     mkfmt OUT_DIR DIR...     # files from each DIR (flat), then kpsewhich
//!
//! Writes OUT_DIR/pdflatex.fmt, pdflatex.log, and USED.tsv: every file the
//! job read, and where it came from (what the extension must carry).
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;

use phitex_overleaf_partex::{MemHost, run, texlive_params};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (out, dirs) = args.split_first().expect("usage: mkfmt OUT_DIR DIR...");
    let dirs: Vec<PathBuf> = dirs.iter().map(PathBuf::from).collect();
    let used = Rc::new(RefCell::new(Vec::<(String, String)>::new()));
    let u = used.clone();
    let mut host = MemHost::default();
    host.fallback = Some(Box::new(move |name: &[u8]| {
        let n = String::from_utf8_lossy(name).into_owned();
        for d in &dirs {
            if let Ok(b) = std::fs::read(d.join(&n)) {
                u.borrow_mut().push((n, d.display().to_string()));
                return Some(b);
            }
        }
        let o = Command::new("kpsewhich").arg("-engine=pdftex").arg(&n).output().ok()?;
        let p = String::from_utf8(o.stdout).ok()?.trim().to_owned();
        if p.is_empty() {
            return None;
        }
        let b = std::fs::read(&p).ok()?;
        u.borrow_mut().push((n, p));
        Some(b)
    }));
    let t = std::time::Instant::now();
    let (hist, h) = run(host, texlive_params(true), b"pdflatex.ini");
    eprintln!("history {hist}, {:.1} s", t.elapsed().as_secs_f64());
    std::io::Write::write_all(&mut std::io::stderr(), &h.term).unwrap();
    let out = Path::new(out);
    std::fs::create_dir_all(out).unwrap();
    for (name, bytes) in &h.written {
        std::fs::write(out.join(String::from_utf8_lossy(name).as_ref()), bytes).unwrap();
    }
    let rows: String = used.borrow().iter().map(|(n, w)| format!("{n}\t{w}\n")).collect();
    std::fs::write(out.join("USED.tsv"), rows).unwrap();
    std::process::exit(if h.written.contains_key(&b"pdflatex.fmt"[..]) { 0 } else { 1 });
}

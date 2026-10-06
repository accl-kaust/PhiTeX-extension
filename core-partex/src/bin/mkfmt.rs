//! Make the preview's LaTeX format with the engine the extension runs.
//!
//!     mkfmt OUT_DIR DIR...     # files from each DIR (flat), then kpsewhich
//!     MKFMT_XETEX=INDEX mkfmt OUT_DIR DIR...   # xelatex.fmt, XeTeX's, with its font index
//!
//! Writes OUT_DIR/pdflatex.fmt (xelatex.fmt), its log, and USED.tsv: every
//! file the job read, and where it came from (what the extension must carry).
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;

use phitex_overleaf_partex::{MemHost, engine_params, run};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (out, dirs) = args.split_first().expect("usage: mkfmt OUT_DIR DIR...");
    let dirs: Vec<PathBuf> = dirs.iter().map(PathBuf::from).collect();
    let used = Rc::new(RefCell::new(Vec::<(String, String)>::new()));
    let u = used.clone();
    // (XeTeX: the font index, by MKFMT_XETEX)
    let index = std::env::var("MKFMT_XETEX").ok();
    let xetex = index.is_some();
    let engine = if xetex { "-engine=xetex" } else { "-engine=pdftex" };
    let mut host = MemHost::default();
    host.fallback = Some(Box::new(move |name: &[u8]| {
        if name == phitex_overleaf_partex::xetex::INDEX {
            return std::fs::read(index.as_ref()?).ok();
        }
        // (a font by its path inside TeX Live)
        if name.starts_with(b"fonts/") {
            return std::fs::read(Path::new("/usr/share/texmf-dist").join(String::from_utf8_lossy(name).as_ref())).ok();
        }
        let n = String::from_utf8_lossy(name).into_owned();
        for d in &dirs {
            if let Ok(b) = std::fs::read(d.join(&n)) {
                u.borrow_mut().push((n, d.display().to_string()));
                return Some(b);
            }
        }
        let o = Command::new("kpsewhich").arg(engine).arg(&n).output().ok()?;
        let p = String::from_utf8(o.stdout).ok()?.trim().to_owned();
        if p.is_empty() {
            return None;
        }
        let b = std::fs::read(&p).ok()?;
        u.borrow_mut().push((n, p));
        Some(b)
    }));
    let t = std::time::Instant::now();
    let (fmt, ini): (&[u8], &[u8]) = if xetex { (b"xelatex.fmt", b"xelatex.ini") } else { (b"pdflatex.fmt", b"pdflatex.ini") };
    let (hist, h) = run(host, engine_params(xetex, true), ini);
    eprintln!("history {hist}, {:.1} s", t.elapsed().as_secs_f64());
    std::io::Write::write_all(&mut std::io::stderr(), &h.term).unwrap();
    let out = Path::new(out);
    std::fs::create_dir_all(out).unwrap();
    for (name, bytes) in &h.written {
        std::fs::write(out.join(String::from_utf8_lossy(name).as_ref()), bytes).unwrap();
    }
    let rows: String = used.borrow().iter().map(|(n, w)| format!("{n}\t{w}\n")).collect();
    std::fs::write(out.join("USED.tsv"), rows).unwrap();
    std::process::exit(if h.written.contains_key(fmt) { 0 } else { 1 });
}

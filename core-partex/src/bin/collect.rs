//! A project as one directory: every file a build of it reads (from a flat
//! copy of TeX Live), with the project's own, so the build needs no fetch:
//!
//!     collect FMT FLAT_DIR PROJECT_DIR MAIN OUT_DIR
//!
//! (For a repro: `runproj FMT OUT_DIR MAIN` then builds it in one go.)
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use phitex_overleaf_partex::{MemHost, run, texlive_params};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (flat, proj, main, out) = (PathBuf::from(&a[1]), PathBuf::from(&a[2]), &a[3], PathBuf::from(&a[4]));
    let mut host = MemHost::default();
    host.files.insert(b"pdflatex.fmt".to_vec(), Arc::from(std::fs::read(&a[0]).unwrap()));
    for e in std::fs::read_dir(&proj).unwrap().flatten() {
        host.files.insert(e.file_name().to_string_lossy().into_owned().into_bytes(), Arc::from(std::fs::read(e.path()).unwrap()));
    }
    let read = Rc::new(RefCell::new(BTreeSet::<String>::new()));
    let r = read.clone();
    let dir = flat.clone();
    host.fallback = Some(Box::new(move |n: &[u8]| {
        let n = std::str::from_utf8(n).ok()?;
        let b = std::fs::read(dir.join(n)).ok()?;
        r.borrow_mut().insert(n.to_string());
        Some(b)
    }));
    let stem = main.strip_suffix(".tex").unwrap_or(main);
    // (PHITEX_PDF=1: what a PDF-mode build reads)
    let mode = if std::env::var("PHITEX_PDF").is_ok_and(|v| v == "1") { "" } else { "\\pdfoutput=0 " };
    let (h, host) = run(host, texlive_params(false), format!("&pdflatex \\nonstopmode{mode}\\input{{{stem}}}").as_bytes());
    std::fs::create_dir_all(&out).unwrap();
    if let Some(pdf) = host.written.iter().find(|(n, _)| n.ends_with(b".pdf")) {
        std::fs::write(out.join("_out.pdf"), pdf.1).unwrap();
    }
    for e in std::fs::read_dir(&proj).unwrap().flatten() {
        std::fs::copy(e.path(), out.join(e.file_name())).unwrap();
    }
    for n in read.borrow().iter() {
        std::fs::copy(flat.join(n), out.join(n)).unwrap();
    }
    let term = String::from_utf8_lossy(&host.term);
    println!("{}", term.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"));
    println!("history {h}, {} pages; {} files from TeX Live into {}", host.pages.len(), read.borrow().len(), out.display());
}

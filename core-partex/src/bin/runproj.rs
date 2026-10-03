//! Profile a project's startup as the extension does it, natively:
//!
//!     runproj FMT DIR MAIN [TEXMF...]
//!
//! DIR's files are the project; a name the job finds missing is looked
//! for in each TEXMF (flat, as Shelf serves them), then kpsewhich, and the
//! job is built again, as the extension's package loop does. Prints each
//! build's time and what it asked for, then the terminal's last lines.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use phitex_overleaf_partex::{Session, add_assets};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (fmt, dir, main, texmf) = (&a[0], Path::new(&a[1]), &a[2], &a[3..]);
    let mut assets = BTreeMap::new();
    assets.insert(b"pdflatex.fmt".to_vec(), Arc::from(std::fs::read(fmt).unwrap()));
    for d in ["cm", "amsfonts", "latex-fonts"] {
        add_dir(&mut assets, &PathBuf::from(format!("/usr/share/texmf-dist/fonts/tfm/public/{d}")));
    }
    add_dir(&mut assets, Path::new("/usr/share/texmf-dist/fonts/tfm/jknappen/ec"));
    add_assets(assets);
    let (mut files, mut binary) = (BTreeMap::new(), Vec::new());
    // (the project's folders too: names relative to DIR, as Overleaf's paths)
    let o = Command::new("find").arg(dir).args(["-type", "f"]).output().unwrap();
    for p in String::from_utf8(o.stdout).unwrap().lines() {
        let n = Path::new(p).strip_prefix(dir).unwrap().to_string_lossy().into_owned();
        match std::fs::read_to_string(p) {
            Ok(t) if !n.ends_with(".tfm") && !n.ends_with(".vf") => {
                files.insert(n, t);
            }
            _ => binary.push((n, std::fs::read(p).unwrap())),
        }
    }
    let t0 = std::time::Instant::now();
    let mut s = Session::open(files, main);
    // (PHITEX_FLAT=dir: read missing names from a flat TeX Live, as if the core had it all)
    if let Ok(d) = std::env::var("PHITEX_FLAT") {
        s.fallback_dir = Some(PathBuf::from(d));
    }
    for (n, b) in &binary {
        s.set_bytes(n, b);
    }
    let mut asked = BTreeSet::new();
    loop {
        let st = s.status();
        let want: Vec<String> = st.missing.iter().filter(|n| asked.insert((*n).clone())).cloned().collect();
        let rss = std::fs::read_to_string("/proc/self/status").ok().and_then(|t| t.lines().find(|l| l.starts_with("VmRSS")).map(|l| l.split_whitespace().nth(1).unwrap_or("?").to_string())).unwrap_or_default();
        println!("build {}: {:.0} ms ({}), history {}, pages {}, rss {} MB, missing {:?}", s.builds, s.build_ms, s.how, st.history, st.pages, rss.parse::<u64>().unwrap_or(0) / 1024, st.missing);
        if want.is_empty() {
            break;
        }
        for n in want {
            match find(texmf, &n) {
                Some(b) => match String::from_utf8(b) {
                    Ok(t) if !n.ends_with(".tfm") && !n.ends_with(".vf") => s.set_file(&n, &t),
                    Ok(t) => s.set_bytes(&n, t.as_bytes()),
                    Err(e) => s.set_bytes(&n, e.as_bytes()),
                },
                None => println!("  {n}: not found"),
            }
        }
    }
    println!("startup: {:.0} ms in {} builds", t0.elapsed().as_secs_f64() * 1e3, s.builds);
    // (as the worker's idle step: the incremental program built, so edits rebuild)
    let t = std::time::Instant::now();
    while s.prepare() {}
    println!("prepare: {:.0} ms ({})", t.elapsed().as_secs_f64() * 1e3, s.how);
    // (PHITEX_EDITS="file|old|new;...": each edit, rebuilt and timed)
    for e in std::env::var("PHITEX_EDITS").unwrap_or_default().split(';').filter(|e| !e.is_empty()) {
        let mut it = e.splitn(3, '|');
        let (Some(f), Some(old), Some(new)) = (it.next(), it.next(), it.next()) else { continue };
        let Some(at) = s.text(f).and_then(|t| t.find(old)) else {
            println!("edit {e:?}: not found");
            continue;
        };
        s.edit_file(f, at..at + old.len(), new).unwrap();
        let t = std::time::Instant::now();
        let st = s.status();
        println!("edit {f}: {old:?} -> {new:?}: {:.1} ms ({}), history {}, pages {}", t.elapsed().as_secs_f64() * 1e3, s.how, st.history, st.pages);
    }
    if !s.pdf.is_empty() {
        std::fs::write("target/runproj.pdf", &s.pdf).unwrap();
        println!("target/runproj.pdf: {} bytes", s.pdf.len());
    }
    let term = s.term();
    let lines: Vec<&str> = term.lines().collect();
    println!("--- terminal (last 40 lines)\n{}", lines[lines.len().saturating_sub(40)..].join("\n"));
}

fn add_dir(m: &mut BTreeMap<Vec<u8>, Arc<[u8]>>, d: &Path) {
    let o = Command::new("find").arg(d).args(["-name", "*.tfm"]).output().unwrap();
    for p in String::from_utf8(o.stdout).unwrap().lines() {
        let n = Path::new(p).file_name().unwrap().to_string_lossy().into_owned().into_bytes();
        m.entry(n).or_insert_with(|| Arc::from(std::fs::read(p).unwrap()));
    }
}

fn find(texmf: &[String], name: &str) -> Option<Vec<u8>> {
    for d in texmf {
        if let Ok(t) = std::fs::read(Path::new(d).join(name)) {
            return Some(t);
        }
    }
    if std::env::var("PHITEX_NO_KPSE").is_ok() {
        return None;
    }
    let o = Command::new("kpsewhich").arg(name).output().ok()?;
    let p = String::from_utf8(o.stdout).ok()?;
    std::fs::read(p.trim()).ok()
}

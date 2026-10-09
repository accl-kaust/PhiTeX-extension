//! Time to page 1, natively, as the extension's open makes it:
//!
//!     firstpage FMT DIR MAIN plain|ssa [TEXMF...]
//!
//! The project's missing files are found first (TEXMF, then kpsewhich), so
//! the build measured has every file (the extension's warm open). Then the
//! open is made twice in fresh sessions, each 3 times, alternating:
//! - blocking: `ph_open` as today (page 1 when the whole build is in);
//! - streamed: `stream_begin`, then `stream_step` slices of 20 ms; page 1
//!   when its stream is shipped and drawn.
//!
//! The two builds' PDFs must be the same bytes, and a whole page's hash
//! shown while streaming must be the finished PDF's.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;

use phitex_overleaf_partex::{Session, add_assets};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (fmt, dir, main, mode, texmf) = (&a[0], Path::new(&a[1]), &a[2], &a[3], &a[4..]);
    let ssa = mode == "ssa";
    let name = dir.canonicalize().unwrap().file_name().unwrap().to_string_lossy().into_owned();
    let mut assets = BTreeMap::new();
    assets.insert(b"pdflatex.fmt".to_vec(), Arc::from(std::fs::read(fmt).unwrap()));
    for d in ["cm", "amsfonts", "latex-fonts"] {
        add_dir(&mut assets, &PathBuf::from(format!("/usr/share/texmf-dist/fonts/tfm/public/{d}")));
    }
    add_dir(&mut assets, Path::new("/usr/share/texmf-dist/fonts/tfm/jknappen/ec"));
    add_assets(assets);
    let (mut files, mut binary) = (BTreeMap::new(), Vec::new());
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
    // (every file the job reads: found by plain builds, as the package loop)
    let mut extra: Vec<(String, Vec<u8>)> = Vec::new();
    {
        let mut s = Session::open(files.clone(), main);
        for (n, b) in &binary {
            s.set_bytes(n, b);
        }
        s.plain_only(true);
        let mut asked = BTreeSet::new();
        loop {
            let st = s.status();
            let want: Vec<String> = st.missing.iter().filter(|n| asked.insert((*n).clone())).cloned().collect();
            if std::env::var("FIRSTPAGE_TERM").is_ok() {
                eprintln!("discovery: {} pages, history {}, missing {:?}", st.pages, st.history, st.missing);
            }
            if want.is_empty() {
                eprintln!("{}: {} pages, history {}, {} files found", dir.display(), st.pages, st.history, extra.len());
                break;
            }
            for n in want {
                if let Some(b) = find(texmf, &n) {
                    give(&mut s, &n, &b);
                    extra.push((n, b));
                } else if std::env::var("FIRSTPAGE_TERM").is_ok() {
                    eprintln!("not found: {n}");
                }
            }
        }
    }
    // (and what a fresh session lacks: discovery's later builds read the
    // .aux the earlier ones wrote, a fresh one none, its undefined
    // references set in other fonts)
    for _ in 0..20 {
        let mut s = Session::open(files.clone(), main);
        for (n, b) in &binary {
            s.set_bytes(n, b);
        }
        for (n, b) in &extra {
            give(&mut s, n, b);
        }
        s.plain_only(true);
        let st = s.status();
        let have: std::collections::BTreeSet<&str> = extra.iter().map(|(n, _)| n.as_str()).collect();
        let more: Vec<(String, Vec<u8>)> = st.missing.iter().filter(|n| !have.contains(n.as_str())).filter_map(|n| Some((n.clone(), find(texmf, n)?))).collect();
        if more.is_empty() {
            eprintln!("fresh: {} pages, history {}", st.pages, st.history);
            break;
        }
        extra.extend(more);
    }
    let session = || {
        let mut s = Session::open(files.clone(), main);
        for (n, b) in &binary {
            s.set_bytes(n, b);
        }
        for (n, b) in &extra {
            give(&mut s, n, b);
        }
        if !ssa {
            s.plain_only(true);
        }
        s
    };
    let mut rows = Vec::new();
    let rounds = std::env::var("FIRSTPAGE_ROUNDS").ok().and_then(|v| v.parse().ok()).unwrap_or(3);
    for round in 0..rounds {
        // blocking
        let mut s = session();
        let t = Instant::now();
        let st = s.status();
        let built = ms(t);
        let d = s.draws(0).unwrap_or_default();
        let page1 = ms(t);
        let pdf_a = s.pdf.clone();
        let hashes_a = s.page_hashes();
        let log_a: Vec<String> = s.builds_log().to_vec();
        if (pdf_a.is_empty() || std::env::var("FIRSTPAGE_TERM").is_ok()) && round == 0 {
            let t = s.term();
            eprintln!("no PDF ({} bytes, history {}); the terminal ends:\n{}", pdf_a.len(), st.history, &t[t.len().saturating_sub(1500)..]);
        }
        drop(s);
        // streamed
        let mut s = session();
        let t = Instant::now();
        s.stream_begin();
        let mut first = None;
        let mut shown: Vec<u64> = Vec::new();
        let mut slices = 0;
        loop {
            let more = s.stream_step(20.0);
            slices += 1;
            if more && first.is_none() && !s.page_hashes().is_empty() {
                let d1 = s.draws(0);
                if d1.is_some() {
                    first = Some((ms(t), d1.as_ref().map_or(0, String::len)));
                    if round == 0 && std::env::var("FIRSTPAGE_DUMP").is_ok() {
                        std::fs::write("../../../stream-p1.json", d1.unwrap()).unwrap();
                        std::fs::write("../../../final-p1.json", &d).unwrap();
                        eprintln!("page 1 shown hash {:016x}, final {:016x}", s.page_hashes()[0], hashes_a[0]);
                    }
                }
            }
            if more {
                shown = s.page_hashes();
            }
            if !more {
                break;
            }
        }
        let j = s.stream_json(1);
        let total = ms(t);
        let (first_ms, first_len) = first.unwrap_or((total, 0));
        let pdf_b = s.pdf.clone();
        let hashes_b = s.page_hashes();
        let same = pdf_a == pdf_b;
        if !same && std::env::var("FIRSTPAGE_DIFF").is_ok() {
            std::fs::write("../../../a.pdf", &pdf_a).unwrap();
            std::fs::write("../../../b.pdf", &pdf_b).unwrap();
        }
        if std::env::var("FIRSTPAGE_LOG").is_ok() {
            eprintln!("--- blocking log:\n{}\n--- streamed log:\n{}", log_a.join("\n"), s.builds_log().join("\n"));
        }
        let kept = shown.iter().zip(&hashes_b).filter(|(a, b)| a == b).count();
        let first_page_ms = j.split("\"first_page_ms\":").nth(1).and_then(|r| r.split(',').next()).unwrap_or("?").to_string();
        println!(
            "{} {mode} round {round}: blocking: built {built:.0} ms, page 1 drawn {page1:.0} ms ({} pages, {} B); streamed: page 1 shipped {first_page_ms} ms, drawn {first_ms:.0} ms ({first_len} B), built {total:.0} ms in {slices} slices; PDF {}; hashes shown before done kept: {kept}/{}; pages {}",
            name,
            st.pages,
            d.len(),
            if same { "identical" } else { "DIFFERENT" },
            shown.len(),
            hashes_a.len()
        );
        if std::env::var("FIRSTPAGE_LOG").is_ok() {
            break;
        }
        assert_eq!(hashes_a, hashes_b, "page hashes differ");
        rows.push((page1, first_ms, built, total, same));
    }
    let med = |f: &dyn Fn(&(f64, f64, f64, f64, bool)) -> f64| {
        let mut v: Vec<f64> = rows.iter().map(f).collect();
        v.sort_by(f64::total_cmp);
        v[v.len() / 2]
    };
    println!(
        "SUMMARY {} {mode}: page 1 blocking {:.0} ms -> streamed {:.0} ms; build {:.0} -> {:.0} ms; PDF identical: {}",
        name,
        med(&|r| r.0),
        med(&|r| r.1),
        med(&|r| r.2),
        med(&|r| r.3),
        rows.iter().all(|r| r.4)
    );
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

fn give(s: &mut Session, n: &str, b: &[u8]) {
    match std::str::from_utf8(b) {
        Ok(t) if !n.ends_with(".tfm") && !n.ends_with(".vf") && !n.ends_with(".pfb") => s.set_file(n, t),
        _ => s.set_bytes(n, b),
    }
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
    let o = Command::new("kpsewhich").arg(name).output().ok()?;
    let p = String::from_utf8(o.stdout).ok()?;
    std::fs::read(p.trim()).ok()
}

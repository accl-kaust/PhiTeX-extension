//! A LaTeX project through the session, as the extension drives it: open,
//! fetch what the job found missing (texmf/, then kpsewhich, standing in
//! for Shelf), build again. Needs `target/fmt/pdflatex.fmt` (mkfmt).
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use phitex_overleaf_partex::{Session, add_assets};

fn assets() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let fmt = std::fs::read(root.join("target/fmt/pdflatex.fmt")).expect("run mkfmt first");
    let mut m = BTreeMap::new();
    m.insert(b"pdflatex.fmt".to_vec(), Arc::from(fmt));
    for d in ["cm", "amsfonts", "latex-fonts"] {
        let o = Command::new("find").arg(format!("/usr/share/texmf-dist/fonts/tfm/public/{d}")).args(["-name", "*.tfm"]).output().unwrap();
        for p in String::from_utf8(o.stdout).unwrap().lines() {
            let n = Path::new(p).file_name().unwrap().to_string_lossy().into_owned().into_bytes();
            m.entry(n).or_insert_with(|| Arc::from(std::fs::read(p).unwrap()));
        }
    }
    add_assets(m);
}

fn find(name: &str) -> Option<Vec<u8>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../texmf");
    if let Ok(t) = std::fs::read(root.join(name)) {
        return Some(t);
    }
    let o = Command::new("kpsewhich").arg(name).output().ok()?;
    let p = String::from_utf8(o.stdout).ok()?;
    std::fs::read(p.trim()).ok()
}

/// A found file into the session: text, or bytes (fonts, a package not in UTF-8).
fn give(s: &mut Session, n: &str, b: Vec<u8>) {
    match String::from_utf8(b) {
        Ok(t) if !n.ends_with(".tfm") && !n.ends_with(".vf") && !n.ends_with(".pfb") => s.set_file(n, &t),
        Ok(t) => s.set_bytes(n, t.as_bytes()),
        Err(e) => s.set_bytes(n, e.as_bytes()),
    }
}

#[test]
fn article_with_packages() {
    assets();
    let mut files = BTreeMap::new();
    files.insert(
        "main.tex".to_string(),
        "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\\section{Intro}\nHello, world. $x^2$\n\\end{document}\n".to_string(),
    );
    let mut s = Session::open(files, "main.tex");
    let mut asked = std::collections::BTreeSet::new();
    for _ in 0..20 {
        let st = s.status();
        let want: Vec<String> = st.missing.iter().filter(|n| asked.insert((*n).clone())).cloned().collect();
        if want.is_empty() {
            break;
        }
        for n in want {
            if let Some(b) = find(&n) {
                give(&mut s, &n, b);
            }
        }
    }
    let st = s.status();
    assert_eq!(st.pages, 1, "{st:?}");
    let d = s.draws(0).unwrap();
    assert!(d.contains("Intro") && d.contains("Hello,"), "{d}");
    eprintln!("{} builds, last {:.0} ms; {d}", s.builds, s.build_ms);
    eprintln!("{}", s.how);
    // (as the extension does when idle: the SSA program before the first edit)
    s.prepare();
    // edits, rebuilt in place: each the page a fresh build makes
    for (from, to) in [("world", "there"), ("Intro", "Introduction"), ("$x^2$", "$x^2 + y^2$")] {
        let at = s.text("main.tex").unwrap().find(from).unwrap();
        s.edit_file("main.tex", at..at + from.len(), to).unwrap();
        let got = s.draws(0).unwrap();
        eprintln!("{}: {:.1} ms", s.how, s.build_ms);
        let mut files = BTreeMap::new();
        for n in ["main.tex"].into_iter().chain(asked.iter().map(String::as_str)) {
            if let Some(t) = s.text(n) {
                files.insert(n.to_string(), t);
            }
        }
        let mut fresh = Session::open(files, "main.tex");
        for n in &asked {
            if let Some(b) = s.bytes(n) {
                fresh.set_bytes(n, &b);
            }
        }
        fresh.status();
        assert_eq!(got, fresh.draws(0).unwrap(), "after {from} -> {to}");
        // (the PDF a download gives: whole, as the fresh job's is)
        let tail = |p: &[u8]| String::from_utf8_lossy(&p[p.len().saturating_sub(40)..]).into_owned();
        assert!(tail(&fresh.pdf).contains("%%EOF"), "fresh: {}", tail(&fresh.pdf));
        assert!(tail(&s.pdf).contains("%%EOF"), "after {from} -> {to}: {} bytes (fresh {}), ends {:?}", s.pdf.len(), fresh.pdf.len(), tail(&s.pdf));
        // (not the .aux: a fresh job reads none and the rebuilt one read the
        // last, so LaTeX writes \gdef\@abspage@last only in the first, as a
        // second pdflatex run would not)
    }
    assert!(s.draws(0).unwrap().contains("there."));
}

/// A longer document: a rebuild against a cold plain build (`--ignored`).
#[test]
#[ignore]
fn long_document_timing() {
    assets();
    let mut body = String::from("\\documentclass{article}\n\\begin{document}\n");
    for k in 0..40 {
        body.push_str(&format!("\\section{{Section {k}}}\n"));
        for p in 0..4 {
            body.push_str(&format!("Paragraph {p} of section {k}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.\n\n"));
        }
    }
    body.push_str("\\end{document}\n");
    let mut files = BTreeMap::new();
    files.insert("main.tex".to_string(), body);
    let mut s = Session::open(files, "main.tex");
    let mut asked = std::collections::BTreeSet::new();
    loop {
        let want: Vec<String> = s.status().missing.iter().filter(|n| asked.insert((*n).clone())).cloned().collect();
        if want.is_empty() {
            break;
        }
        for n in want {
            if let Some(b) = find(&n) {
                give(&mut s, &n, b);
            }
        }
    }
    eprintln!("{} pages; {}: {:.0} ms; written {:?}", s.status().pages, s.how, s.build_ms, s.written());

    for k in [30, 5] {
        let from = format!("Paragraph 2 of section {k}.");
        let at = s.text("main.tex").unwrap().find(&from).unwrap();
        s.edit_file("main.tex", at..at + 9, "Paragraf").unwrap();
        s.status();
        eprintln!("edit in section {k}: {}: {:.1} ms; written {:?}", s.how, s.build_ms, s.written());

    }
}

/// A project dir's main.tex (PHITEX_PROJECT), an edit, then the PDF whole (`--ignored`).
#[test]
#[ignore]
fn pdf_whole_after_edit() {
    assets();
    let dir = std::env::var("PHITEX_PROJECT").expect("PHITEX_PROJECT");
    let mut files = BTreeMap::new();
    files.insert("main.tex".to_string(), std::fs::read_to_string(Path::new(&dir).join("main.tex")).unwrap());
    let mut s = Session::open(files, "main.tex");
    // (PHITEX_FLAT: a flat TeX Live, as if the host had it all)
    let flat = std::env::var("PHITEX_FLAT").ok();
    let mut asked = std::collections::BTreeSet::new();
    for _ in 0..400 {
        let st = s.status();
        let want: Vec<String> = st.missing.iter().filter(|n| asked.insert((*n).clone())).cloned().collect();
        if want.is_empty() {
            break;
        }
        for n in want {
            let b = flat.as_ref().and_then(|d| std::fs::read(Path::new(d).join(&n)).ok()).or_else(|| find(&n));
            if let Some(b) = b {
                give(&mut s, &n, b);
            }
        }
        // (as the extension: after discovery's names are given, go)
        s.go();
    }
    let st = s.status();
    eprintln!("pages {} missing {:?} {:?}", st.pages, st.missing, st.error);
    // (idle, as the worker: the SSA program, then the rebuilds prepared)
    while s.prepare() {}
    let tail = |p: &[u8]| String::from_utf8_lossy(&p[p.len().saturating_sub(40)..]).into_owned();
    eprintln!("{}: {} bytes, ends {:?}", s.how, s.pdf.len(), tail(&s.pdf));
    let at = s.text("main.tex").unwrap().find("Every writer").unwrap();
    s.edit_file("main.tex", at..at, "Hello. ").unwrap();
    s.status();
    eprintln!("{}: {} bytes, ends {:?}", s.how.lines().next().unwrap(), s.pdf.len(), tail(&s.pdf));
    for l in s.builds_log() {
        eprintln!("log: {}", &l[..l.len().min(120)]);
    }
    assert!(tail(&s.pdf).contains("%%EOF"));
}

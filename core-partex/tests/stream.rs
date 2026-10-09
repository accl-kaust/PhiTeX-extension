//! A build streamed (`stream.rs`): the open in slices gives the blocking
//! open's PDF, pages shown before it is done keep their hash when done (a
//! document without links), and an edit meanwhile is never lost. Needs
//! `target/fmt/pdflatex.fmt` (mkfmt), as session.rs.
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

fn give(s: &mut Session, n: &str, b: &[u8]) {
    match std::str::from_utf8(b) {
        Ok(t) if !n.ends_with(".tfm") && !n.ends_with(".vf") && !n.ends_with(".pfb") => s.set_file(n, t),
        _ => s.set_bytes(n, b),
    }
}

/// Every page's draw list, joined.
fn all(s: &mut Session) -> String {
    let n = s.status().pages;
    (0..n).filter_map(|k| s.draws(k)).collect()
}

/// Pages of text, a table of contents (a second trip in SSA mode).
fn doc() -> String {
    let mut d = String::from("\\documentclass{article}\n\\begin{document}\n\\tableofcontents\n");
    for k in 0..12 {
        d.push_str(&format!("\\section{{Part {k}}}\nThe text of part {k}, long enough to fill a few lines of a page: lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n\n"));
    }
    d.push_str("\\end{document}\n");
    d
}

/// The files the document reads, found by plain builds.
fn found() -> Vec<(String, Vec<u8>)> {
    let mut s = session(&[], true);
    let mut asked = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    loop {
        let want: Vec<String> = s.status().missing.iter().filter(|n| asked.insert((*n).clone())).cloned().collect();
        if want.is_empty() {
            return out;
        }
        for n in want {
            if let Some(b) = find(&n) {
                give(&mut s, &n, &b);
                out.push((n, b));
            }
        }
    }
}

fn session(found: &[(String, Vec<u8>)], plain: bool) -> Session {
    let mut files = BTreeMap::new();
    files.insert("main.tex".to_string(), doc());
    let mut s = Session::open(files, "main.tex");
    for (n, b) in found {
        give(&mut s, n, b);
    }
    if plain {
        s.plain_only(true);
    }
    s
}

/// The build streamed to its end; the hashes shown at each step.
fn stream(s: &mut Session) -> Vec<Vec<u64>> {
    s.stream_begin();
    let mut shown = Vec::new();
    while s.stream_step(1.0) {
        shown.push(s.page_hashes());
    }
    let j = s.stream_json(1);
    assert!(j.contains("\"done\":true"), "{j}");
    shown
}

#[test]
fn a_streamed_open_is_the_open() {
    assets();
    let f = found();
    for plain in [true, false] {
        let mut a = session(&f, plain);
        a.status();
        let mut b = session(&f, plain);
        let shown = stream(&mut b);
        assert!(shown.len() > 2, "{} steps", shown.len());
        assert!(a.pdf == b.pdf, "plain {plain}: the streamed PDF differs");
        let fin = b.page_hashes();
        assert_eq!(fin, a.page_hashes(), "plain {plain}");
        assert!(fin.len() >= 2, "plain {plain}: {} pages", fin.len());
        // (no links, one font a page: every page shown keeps its hash)
        let last = shown.last().unwrap();
        if plain {
            assert_eq!(last, &fin, "plain: pages shown before done");
        }
        // (and a page shown was drawn from its stream)
        assert!(shown.iter().any(|h| !h.is_empty()));
    }
}

#[test]
fn a_page_is_drawn_while_the_build_runs() {
    assets();
    let f = found();
    let mut s = session(&f, true);
    s.stream_begin();
    let mut drawn = None;
    while s.stream_step(1.0) {
        if drawn.is_none() && !s.page_hashes().is_empty() {
            drawn = s.draws(0);
        }
    }
    s.stream_json(1);
    let d = drawn.expect("page 1 drawn before the build was done");
    assert!(d.contains("Contents"), "{}", &d[..d.len().min(400)]);
    // (as the finished PDF's page draws it, but for the fonts' names)
    let fin = s.draws(0).unwrap();
    let text = |d: &str| d.split("\"t\":").nth(1).map(str::to_string);
    assert_eq!(text(&d), text(&fin));
}

#[test]
fn an_edit_while_streaming_is_not_lost() {
    assets();
    let f = found();
    for plain in [true, false] {
        let mut s = session(&f, plain);
        s.stream_begin();
        let mut edited = false;
        while s.stream_step(1.0) {
            if !edited && !s.page_hashes().is_empty() {
                let at = s.text("main.tex").unwrap().find("part 3,").unwrap();
                s.edit_file("main.tex", at..at + 4, "PART").unwrap();
                edited = true;
            }
        }
        s.stream_json(1);
        assert!(edited);
        // (the edit built after the build: what a fresh build of it draws)
        let got = all(&mut s);
        let mut fresh = session(&f, plain);
        let at = fresh.text("main.tex").unwrap().find("part 3,").unwrap();
        fresh.edit_file("main.tex", at..at + 4, "PART").unwrap();
        let mut fresh2 = Session::open([("main.tex".to_string(), fresh.text("main.tex").unwrap())].into(), "main.tex");
        for (n, b) in &f {
            give(&mut fresh2, n, b);
        }
        if plain {
            fresh2.plain_only(true);
        }
        let want = all(&mut fresh2);
        assert!(got.contains("PART"), "plain {plain}: the edit is lost");
        let at = want.find("ART").or_else(|| want.find("art 3")).unwrap_or(0);
        assert!(want.contains("PART"), "fresh: {}", &want[at.saturating_sub(200)..(at + 200).min(want.len())]);
    }
}

/// An edit while the trips settle stops them; its rebuild takes their work.
#[test]
fn an_edit_while_settling_stops_the_settle() {
    assets();
    let f = found();
    let mut s = session(&f, false);
    s.stream_begin();
    let mut edited = false;
    while s.stream_step(1.0) {
        if !edited && s.stream_json(1).contains("\"settling\"") {
            let at = s.text("main.tex").unwrap().find("part 3,").unwrap();
            s.edit_file("main.tex", at..at + 4, "PART").unwrap();
            edited = true;
            // (the settle stopped: no build streams now)
            assert!(!s.streaming());
        }
    }
    assert!(edited, "no settling phase");
    let got = all(&mut s);
    assert!(got.contains("PART"), "the edit is lost");
    // (and the trips that follow, on idle: as a fresh build)
    while s.prepare() {}
    let mut fresh = Session::open([("main.tex".to_string(), s.text("main.tex").unwrap())].into(), "main.tex");
    for (n, b) in &f {
        give(&mut fresh, n, b);
    }
    let n = fresh.status().pages;
    assert_eq!(s.status().pages, n);
    for k in 0..n {
        assert_eq!(s.draws(k), fresh.draws(k), "page {}: settled after the edit, not a fresh build's", k + 1);
    }
}

/// A form not `\immediate` is shipped after the page that draws it (at its
/// first use, after the page object): the page, hashed before the form
/// came, is hashed again with it, and keeps its PDF page's hash.
#[test]
fn a_form_shipped_after_its_page() {
    assets();
    let f = found();
    let mut files = BTreeMap::new();
    let d = doc().replace(
        "\\tableofcontents\n",
        "\\setbox0\\hbox{FORM}\\pdfxform0 \\edef\\f{\\the\\pdflastxform}\\noindent\\pdfrefxform\\f\\par\n",
    );
    files.insert("main.tex".to_string(), d);
    let mut s = Session::open(files.clone(), "main.tex");
    for (n, b) in &f {
        give(&mut s, n, b);
    }
    s.plain_only(true);
    s.stream_begin();
    let mut last = Vec::new();
    while s.stream_step(1.0) {
        last = s.page_hashes();
    }
    s.stream_json(1);
    let fin = s.page_hashes();
    assert!(!fin.is_empty());
    assert_eq!(last.first(), fin.first(), "page 1 kept the hash it had without its form");
    assert!(s.draws(0).unwrap().contains("FORM"));
}

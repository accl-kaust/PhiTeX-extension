//! What loading a package reads, for Shelf's index: for each name, one job
//! (`\documentclass{article}\usepackage{X}` for a .sty, `\documentclass{X}`
//! for a .cls) on the preview's engine and format, its files read straight
//! from a flat directory of TeX Live's files (no fetch loop: a file is
//! there or not), and the names it read printed:
//!
//!     trace-deps FMT FLAT_DIR NAME...    # prints  NAME <TAB> file,file,...
//!
//! A line per name as soon as it is done (Shelf's build runs batches with a
//! timeout, so a job that never ends costs its batch, not the build).
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use phitex_overleaf_partex::{MemHost, run, texlive_params};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let fmt: Arc<[u8]> = Arc::from(std::fs::read(&a[0]).expect("FMT"));
    let flat = PathBuf::from(&a[1]);
    let mut out = std::io::stdout().lock();
    for name in &a[2..] {
        let Some((stem, kind)) = name.rsplit_once('.') else { continue };
        // (a body that uses the shapes a paper does: the fonts a package
        // brings are read then, so they arrive with it, not one build each)
        let body = "\\begin{document}\\section{S}x \\textbf{b} \\textit{i} \\emph{e} \\textsc{s} \\texttt{t} \\textsf{f} \\textbf{\\textit{bi}} {\\small s}{\\footnotesize f}{\\large l} $x^2+\\alpha\\sum_{i=1}^n\\int f\\to\\mathbb{R}$ \\[\\sum_i x_i\\]\\end{document}\n";
        let job = match kind {
            "sty" => format!("\\documentclass{{article}}\\usepackage{{{stem}}}{body}"),
            "cls" => format!("\\documentclass{{{stem}}}{body}"),
            _ => continue,
        };
        let read = Rc::new(RefCell::new(BTreeSet::<String>::new()));
        let mut host = MemHost::default();
        host.files.insert(b"pdflatex.fmt".to_vec(), fmt.clone());
        host.files.insert(b"phitexdepsjob.tex".to_vec(), Arc::from(job.as_bytes()));
        let (r, dir) = (read.clone(), flat.clone());
        host.fallback = Some(Box::new(move |n: &[u8]| {
            let n = std::str::from_utf8(n).ok()?;
            if n.contains('/') || n.starts_with('.') {
                return None;
            }
            let b = std::fs::read(dir.join(n)).ok()?;
            r.borrow_mut().insert(n.to_string());
            Some(b)
        }));
        // (a PDF-mode build, as the preview's: it also reads the fonts'
        // .vf, .pfb and .enc; PHITEX_DVI=1 for DVI)
        let cmd: &[u8] = if std::env::var("PHITEX_DVI").is_ok_and(|v| v == "1") {
            b"&pdflatex \\nonstopmode\\pdfoutput=0 \\input{phitexdepsjob}"
        } else {
            b"&pdflatex \\nonstopmode\\input{phitexdepsjob}"
        };
        let _ = run(host, texlive_params(false), cmd);
        let files: Vec<String> = read.borrow().iter().cloned().collect();
        let _ = writeln!(out, "{name}\t{}", files.join(","));
        let _ = out.flush();
    }
}

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
//!
//! XeTeX's (Shelf's xetex column) when FMT is an `xelatex.fmt`: the job runs
//! on XeTeX, its fonts found by name in the font index beside FMT
//! (`fontindex.pxfi`, the engine's otf-index) and read by TeX Live's path,
//! served from FLAT_DIR by base name (the flat directory is XeTeX's
//! resolution: Shelf's build makes it); the TECkit mappings (fonts/misc,
//! not on Shelf: the extension's XeTeX assets carry them) from this
//! machine's TeX Live. Its XDV is not made a PDF: what xdvipdfmx reads
//! (Type 1 fonts of TFM text) is not in the column.
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use phitex_overleaf_partex::{MemHost, add_assets, engine_params, run, xetex};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let fmt: Arc<[u8]> = Arc::from(std::fs::read(&a[0]).expect("FMT"));
    let flat = PathBuf::from(&a[1]);
    let xe = a[0].ends_with("xelatex.fmt");
    if xe {
        // (the font index: by name lookups, and the base names of its fonts)
        let ix = std::path::Path::new(&a[0]).with_file_name("fontindex.pxfi");
        let mut m = std::collections::BTreeMap::new();
        m.insert(xetex::INDEX.to_vec(), Arc::from(std::fs::read(&ix).expect("fontindex.pxfi beside FMT")));
        add_assets(m);
    }
    let (fmt_name, cmd_name): (&[u8], &str) = if xe { (b"xelatex.fmt", "xelatex") } else { (b"pdflatex.fmt", "pdflatex") };
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
        host.files.insert(fmt_name.to_vec(), fmt.clone());
        host.files.insert(b"phitexdepsjob.tex".to_vec(), Arc::from(job.as_bytes()));
        let (r, dir) = (read.clone(), flat.clone());
        host.fallback = Some(Box::new(move |n: &[u8]| {
            let n = std::str::from_utf8(n).ok()?;
            if n.as_bytes() == xetex::INDEX {
                return None;
            }
            // (XeTeX's fonts, by their path: the flat directory has them by base name)
            let n = if xe && n.starts_with("fonts/") { n.rsplit('/').next()? } else { n };
            if n.contains('/') || n.starts_with('.') {
                return None;
            }
            let Ok(b) = std::fs::read(dir.join(n)) else {
                // (TECkit's mappings: TeX Live's, never Shelf's)
                if xe && n.ends_with(".tec") {
                    let o = std::process::Command::new("kpsewhich").arg("-engine=xetex").arg(n).output().ok()?;
                    return std::fs::read(String::from_utf8(o.stdout).ok()?.trim()).ok();
                }
                return None;
            };
            r.borrow_mut().insert(n.to_string());
            Some(b)
        }));
        // (a PDF-mode build, as the preview's: it also reads the fonts'
        // .vf, .pfb and .enc; PHITEX_DVI=1 for DVI)
        let cmd = if !xe && std::env::var("PHITEX_DVI").is_ok_and(|v| v == "1") {
            format!("&{cmd_name} \\nonstopmode\\pdfoutput=0 \\input{{phitexdepsjob}}")
        } else {
            format!("&{cmd_name} \\nonstopmode\\input{{phitexdepsjob}}")
        };
        let _ = run(host, engine_params(xe, false), cmd.as_bytes());
        let files: Vec<String> = read.borrow().iter().cloned().collect();
        let _ = writeln!(out, "{name}\t{}", files.join(","));
        let _ = out.flush();
    }
}

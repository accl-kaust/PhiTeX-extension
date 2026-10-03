//! A PDF's pages as the panel's draw lists (pdfdraw), for testing:
//!     drawpdf FILE.pdf
fn main() {
    let f = std::env::args().nth(1).expect("FILE.pdf");
    let b = std::fs::read(f).unwrap();
    let t = std::time::Instant::now();
    let pages = phitex_overleaf_partex::pdfdraw::pages(&b);
    eprintln!("{} pages in {:.2} ms", pages.len(), t.elapsed().as_secs_f64() * 1e3);
    for (d, h) in pages {
        println!("{h:016x} {d}");
    }
}

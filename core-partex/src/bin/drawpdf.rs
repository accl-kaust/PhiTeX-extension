//! A PDF's pages as the panel's draw lists (phitex-draw), for testing:
//!     drawpdf FILE.pdf
fn main() {
    let f = std::env::args().nth(1).expect("FILE.pdf");
    let b: std::sync::Arc<[u8]> = std::fs::read(f).unwrap().into();
    let t = std::time::Instant::now();
    let pdf = phitex_draw::Pdf::open(&b).expect("a PDF");
    let mut fonts = phitex_draw::Fonts::new();
    let hashes = pdf.hashes();
    let pages: Vec<String> = (0..pdf.page_count()).filter_map(|k| pdf.draw(k, &mut fonts)).collect();
    eprintln!("{} pages in {:.2} ms", pages.len(), t.elapsed().as_secs_f64() * 1e3);
    for (d, h) in pages.iter().zip(hashes) {
        println!("{h:016x} {d}");
    }
}

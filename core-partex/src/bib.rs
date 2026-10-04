//! BibTeX between a build's trips, as latexmk runs it between pdflatex
//! runs: the engine's own BibTeX (`partex-bibtex`, in process, so in wasm
//! too), on each `.aux` the trip wrote that asks for one (`\bibdata`); its
//! `.bbl` is put where the next trip reads it. As the CLI's
//! `bibtex::after_pass`, a run is made again only when its `.aux` changed.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use crate::MemHost;

/// Each `.aux`'s contents at its last BibTeX run: across a session's builds.
pub type Memo = Rc<RefCell<HashMap<Vec<u8>, Arc<[u8]>>>>;

/// The `.bst` and `.bib` files: the project's (and the files the job read),
/// else the host's fallback (Shelf in the extension), as kpathsea finds them.
struct HostFiles<'a> {
    host: &'a mut MemHost,
    auxes: &'a HashMap<Vec<u8>, Arc<[u8]>>,
}

impl HostFiles<'_> {
    fn find(&mut self, name: &[u8]) -> Option<Vec<u8>> {
        if let Some(b) = self.host.files.get(name) {
            return Some(b.to_vec());
        }
        let b = self.host.fallback.as_mut()?(name)?;
        self.host.files.insert(name.to_vec(), Arc::from(&b[..]));
        Some(b)
    }
}

impl partex_bibtex::Files for HostFiles<'_> {
    fn aux(&mut self, name: &[u8]) -> Option<Vec<u8>> {
        self.auxes.get(name).map(|b| b.to_vec()).or_else(|| self.host.files.get(name).map(|b| b.to_vec()))
    }

    fn bst(&mut self, name: &[u8]) -> Option<Vec<u8>> {
        self.find(&[name, b".bst"].concat())
    }

    fn bib(&mut self, name: &[u8]) -> Option<Vec<u8>> {
        if name.ends_with(b".bib") { self.find(name) } else { self.find(&[name, b".bib"].concat()) }
    }
}

/// The tools a build's trips run (`ssa::Trips::tools`): BibTeX on each
/// `.aux` stream that asks for it and changed since its last run.
pub fn tools(memo: Memo) -> impl FnMut(&mut MemHost, &[(Vec<u8>, Arc<[u8]>)]) -> (bool, Vec<String>) {
    move |host, streams| {
        let auxes: HashMap<Vec<u8>, Arc<[u8]>> = streams.iter().filter(|(n, _)| n.ends_with(b".aux")).cloned().collect();
        let mut wrote = false;
        let mut lines = Vec::new();
        for (name, contents) in &auxes {
            if !contents.split(|&c| c == b'\n').any(|l| l.starts_with(b"\\bibdata{")) {
                continue;
            }
            if memo.borrow().get(name).is_some_and(|was| was[..] == contents[..]) {
                continue;
            }
            memo.borrow_mut().insert(name.clone(), contents.clone());
            let base = name.strip_suffix(b".aux").unwrap_or(name).to_vec();
            let out = partex_bibtex::run(&base, &partex_bibtex::Options::default(), &mut HostFiles { host, auxes: &auxes });
            for f in [&out.bbl, &out.blg].into_iter().flatten() {
                host.files.insert(f.name.clone(), Arc::from(&f.contents[..]));
            }
            wrote |= out.bbl.is_some();
            // (its errors and warnings, from the .blg: what it couldn't find)
            let blg = out.blg.as_ref().map(|b| String::from_utf8_lossy(&b.contents).into_owned()).unwrap_or_default();
            let said: Vec<&str> = blg.lines().filter(|l| l.contains("I couldn't") || l.contains("I found no") || l.starts_with("Warning") || l.contains("error message")).take(6).collect();
            lines.push(format!(
                "bibtex {}: history {}{}{}",
                String::from_utf8_lossy(name),
                out.history,
                out.bbl.as_ref().map_or(String::new(), |b| format!(", {} bytes of .bbl", b.contents.len())),
                if said.is_empty() { String::new() } else { format!(": {}", said.join(" | ")) }
            ));
        }
        (wrote, lines)
    }
}

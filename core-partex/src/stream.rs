//! A build in slices (`ph_open` with `stream`, then `ph_step`): the
//! worker gets control back between slices, so each page is drawn as soon
//! as it is shipped, and the tab's requests are answered while the build
//! runs. The build is the one `Session::build` makes, cut where the engine
//! stops anyway (partex's DESIGN 4.10):
//!
//! - plain (the first paint): `Tex::start`, then `resume` every
//!   [`SLICE`] commands (`Tex::set_stop_at`);
//! - SSA: the first trip as `ssa::ColdRun` slices, then the trips that
//!   settle it, each stopped at a step boundary when the slice is over
//!   (`SsaTracker::cancel`: the work left is pending, and the next slice's
//!   `ssa::settle` goes on with it), then the link.
//!
//! Pages shipped so far are drawn from their own PDFs
//! (`partex_core::pagepdf::Shipments`), with the hash the finished PDF's
//! page will have when the stream draws it whole (else a hash no built page
//! has). An edit while the first trip runs waits for it (the worker queues
//! it); one while the trips settle stops them at the next step, and its
//! rebuild goes on with their work.
use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use partex_core::pagepdf::Shipments;
use partex_core::ssa::{self, ColdRun, SsaTracker};
use partex_core::{FileKind, Step, Tex, Untracked};

use crate::{MemHost, Session, clock_ns, esc, ms, native_tools, no_tools, shelf};

/// Commands between two looks at the clock.
const SLICE: u64 = 2048;

/// When the settle's slice is over (`clock_ns`): its cancel's.
static SLICE_END: AtomicU64 = AtomicU64::new(u64::MAX);

/// The settle's cancel: the slice is over.
fn slice_over() -> bool {
    clock_ns() >= SLICE_END.load(Ordering::Relaxed)
}

pub(crate) enum Run {
    /// A plain build's job, `at` where it stopped.
    Plain { tex: Box<Tex<MemHost, Untracked>>, at: Step },
    /// An SSA build's first trip.
    Trip1 { tex: Box<Tex<MemHost, SsaTracker>>, run: Box<ColdRun> },
    /// Its trips that settle the job's files (the engine in `Session::tex`),
    /// `trips` run so far.
    Settle { r: Box<ssa::SsaReport>, run_ms: f64, trips: usize, first: bool },
}

/// A build streamed.
pub(crate) struct Stream {
    run: Option<Run>,
    begun: Instant,
    /// The pages shipped so far, and each one's hash as shown.
    shipped: Shipments,
    /// (each with whether it was whole: a page that was not is hashed
    /// again when forms come, which a page's stream may draw before
    /// they are shipped)
    hashes: Vec<Option<(u64, bool)>>,
    /// When page 1 was shipped (ms from `begun`), and the pages there were
    /// at the end of that slice.
    first_page_ms: Option<f64>,
    pages_at_first: usize,
    /// Draw lists of the pages shipped, by hash.
    draws: std::collections::HashMap<u64, String>,
    /// The names hinted and handed on (`want`), once each.
    wanted: std::collections::BTreeSet<Vec<u8>>,
}

impl Stream {
    /// Whether the build runs its first trip (an edit then waits for it).
    fn typesetting(&self) -> bool {
        !matches!(self.run, Some(Run::Settle { .. }))
    }
}

impl Session {
    /// Begin the build streamed (instead of `build`, at the open).
    pub fn stream_begin(&mut self) {
        if !self.stale {
            return;
        }
        self.stale = false;
        let begun = Instant::now();
        let run = if self.want_ssa && !self.xetex {
            let mut tex = self.cold_tex();
            self.host_streams(tex.host_mut());
            let cmd = self.command();
            let run = ColdRun::start(&mut tex, cmd.as_bytes(), false, 0, false);
            Run::Trip1 { tex: Box::new(tex), run: Box::new(run) }
        } else {
            let mut tex = self.plain_tex();
            if !self.xetex {
                self.host_streams(tex.host_mut());
            }
            tex.set_stop_at(SLICE);
            let at = tex.start(self.command().as_bytes());
            Run::Plain { tex: Box::new(tex), at }
        };
        self.stream = Some(Stream {
            run: Some(run),
            begun,
            shipped: Shipments::default(),
            hashes: Vec::new(),
            first_page_ms: None,
            pages_at_first: 0,
            draws: std::collections::HashMap::new(),
            wanted: std::collections::BTreeSet::new(),
        });
        self.collect();
    }

    /// A host that keeps the pages shipped and the files named ahead.
    fn host_streams(&self, h: &mut MemHost) {
        // (PHITEX_STREAM_NO_TAP: no streams or hints kept, a test's)
        if std::env::var("PHITEX_STREAM_NO_TAP").is_ok() {
            return;
        }
        h.shipments = Some(Shipments::default());
        h.hints = Some(Vec::new());
    }

    /// Whether a streamed build runs.
    #[must_use]
    pub fn streaming(&self) -> bool {
        self.stream.is_some()
    }

    /// Run the streamed build on for `budget_ms`: true while there is more
    /// to do. Its state (JSON) by `stream_json`.
    pub fn stream_step(&mut self, budget_ms: f64) -> bool {
        let Some(st) = self.stream.as_mut() else { return false };
        let end = clock_ns().saturating_add((budget_ms.max(1.0) * 1e6) as u64);
        let mut run = st.run.take();
        loop {
            match &mut run {
                Some(Run::Plain { tex, at }) => match *at {
                    Step::Checkpoint => {
                        tex.set_stop_at(tex.commands() + SLICE);
                        *at = tex.resume();
                    }
                    Step::Finished(h) => {
                        let Some(Run::Plain { mut tex, .. }) = run.take() else { unreachable!() };
                        self.collect_from(tex.host_mut());
                        let t = self.stream.as_ref().map_or_else(Instant::now, |s| s.begun);
                        self.plain_done(&mut tex, h);
                        self.build_ms = ms(t.elapsed());
                        let _ = write!(self.how, "; run {:.1} ms (streamed)", self.build_ms);
                        self.builds += 1;
                        self.history_log.push(format!("build {}: {}", self.builds, self.how));
                    }
                },
                Some(Run::Trip1 { tex, run: cold }) => {
                    if cold.step(tex, SLICE) {
                        let Some(Run::Trip1 { tex, run: cold }) = run.take() else { unreachable!() };
                        let mut tex = *tex;
                        let r = cold.finish(&mut tex);
                        self.collect_from(tex.host_mut());
                        let run_ms = self.stream.as_ref().map_or(0.0, |s| ms(s.begun.elapsed()));
                        // (the engine kept now: the settle's trips run on it,
                        // and an edit while they run rebuilds it)
                        self.prepared = false;
                        self.lk = crate::LinkState::default();
                        self.cold_ms = run_ms;
                        self.tex = Some(tex);
                        run = Some(Run::Settle { r: Box::new(r), run_ms, trips: 0, first: true });
                    }
                }
                Some(Run::Settle { r, trips, first, .. }) => {
                    let native = native_tools();
                    // (the trips a blocking build may take, 12 with the
                    // first, counted across the slices: a trip stopped is
                    // counted once, by the call that ends it)
                    let max = 12usize.saturating_sub(*trips).max(1);
                    let mut t = ssa::Trips { max, tools: &mut no_tools, native: Some(&native), clock: None };
                    let tex = self.tex.as_mut().unwrap();
                    SLICE_END.store(end, Ordering::Relaxed);
                    // (PHITEX_STREAM_SETTLE_WHOLE: the settle not stopped, a test's)
                    if std::env::var("PHITEX_STREAM_SETTLE_WHOLE").is_err() {
                        tex.tracker().cancel.set(Some(slice_over));
                    }
                    let mut s = ssa::settle(tex, false, false, &mut t, if *first { r.commands } else { 0 }, 0);
                    tex.tracker().cancel.set(None);
                    *first = false;
                    *trips += s.trips - usize::from(s.stopped.is_some() && s.trips > 0);
                    self.history_log.extend(std::mem::take(&mut s.tools).into_iter().map(|l| format!("tool: {l}")));
                    let tex = self.tex.as_mut().unwrap();
                    let host = tex.host_mut();
                    if let Some(st) = self.stream.as_mut() {
                        absorb(st, took(host));
                    }
                    if s.stopped.is_some() && s.unsupported.is_none() {
                        // (the slice is over: the trip's work is pending)
                    } else {
                        s.trips = *trips;
                        let Some(Run::Settle { r, run_ms, .. }) = run.take() else { unreachable!() };
                        let t = self.stream.as_ref().map_or_else(Instant::now, |s| s.begun);
                        let mut tex = self.tex.take().unwrap();
                        // (the build is in: its rebuilds ship no streams)
                        quiet(tex.host_mut());
                        if let Some(why) = &s.unsupported {
                            // (a settle the engine cannot make: cold again, at once)
                            self.history_log.push(format!("settle stopped ({why}): cold"));
                            self.stream = None;
                            self.stale = true;
                            self.build();
                            return false;
                        }
                        self.cold_done(tex, &r, &s, t, run_ms);
                        self.built(t);
                    }
                }
                None => {}
            }
            if run.is_none() {
                break;
            }
            if clock_ns() >= end {
                break;
            }
        }
        let more = run.is_some();
        if let Some(st) = self.stream.as_mut() {
            st.run = run;
        }
        self.collect();
        if !more {
            if let Some(st) = &self.stream {
                self.history_log.push(format!(
                    "streamed: page 1 at {} ms ({} pages then), built in {:.0} ms",
                    st.first_page_ms.map_or("-".into(), |m| format!("{m:.0}")),
                    st.pages_at_first,
                    ms(st.begun.elapsed())
                ));
            }
        }
        more
    }

    /// The pages and hints the running build's host has, into the stream.
    fn collect(&mut self) {
        let Some(st) = self.stream.as_mut() else { return };
        let host = match &mut st.run {
            Some(Run::Plain { tex, .. }) => tex.host_mut(),
            Some(Run::Trip1 { tex, .. }) => tex.host_mut(),
            Some(Run::Settle { .. }) => match self.tex.as_mut() {
                Some(t) => t.host_mut(),
                None => return,
            },
            None => return,
        };
        let got = took(host);
        absorb(st, got);
    }

    fn collect_from(&mut self, host: &mut MemHost) {
        if let Some(st) = self.stream.as_mut() {
            absorb(st, took(host));
            host.shipments = None;
        }
    }

    /// The streamed build's state, JSON: running (`done` false) its phase,
    /// pages (their hashes as shown) and the files to fetch ahead; done,
    /// what `ph_open` answers, with when page 1 came.
    pub fn stream_json(&mut self, handle: u32) -> String {
        let want = self.wants();
        let want = want.iter().map(|w| esc(w)).collect::<Vec<_>>().join(",");
        let (first, at_first) = self.stream.as_ref().map_or((None, 0), |st| (st.first_page_ms, st.pages_at_first));
        let first = first.map_or("null".into(), |m| format!("{m:.1}"));
        if let Some(st) = self.stream.as_ref()
            && let Some(run) = &st.run
        {
            let t = ms(st.begun.elapsed());
            let (phase, pass) = match run {
                Run::Settle { trips, .. } => ("settling", trips + 2),
                _ => ("typesetting", 1),
            };
            let hs: Vec<String> = self.stream_hashes().iter().map(|h| format!("\"{h:016x}\"")).collect();
            return format!(
                "{{\"done\":false,\"building\":true,\"handle\":{handle},\"phase\":\"{phase}\",\"pass\":{pass},\"pages\":{},\"hashes\":[{}],\"ms\":{t:.1},\"first_page_ms\":{first},\"want\":[{want}]}}",
                hs.len(),
                hs.join(",")
            );
        }
        self.stream = None;
        let st = self.status();
        let hs: Vec<String> = self.page_hashes().iter().map(|h| format!("\"{h:016x}\"")).collect();
        format!(
            "{{\"done\":true,\"handle\":{handle},\"build_ms\":{},\"how\":{},{},\"hashes\":[{}],\"first_page_ms\":{first},\"pages_at_first\":{at_first},\"want\":[{want}]}}",
            self.build_ms,
            esc(&self.how),
            st.json(),
            hs.join(",")
        )
    }

    /// The pages shipped so far: each one's hash as shown (0: not shipped).
    pub fn stream_hashes(&mut self) -> Vec<u64> {
        let Some(st) = self.stream.as_mut() else { return Vec::new() };
        (0..st.shipped.pages())
            .map(|k| {
                if let Some((h, _)) = st.hashes.get(k).copied().flatten() {
                    return h;
                }
                let (h, whole) = st.shipped.page_pdf(k, &mut |_, _| None).map_or((0, false), |(pdf, whole)| {
                    let h = phitex_draw::Pdf::open(&std::sync::Arc::from(pdf)).and_then(|d| d.hashes().first().copied()).unwrap_or(0);
                    // (a page not drawn whole from its stream: a hash no
                    // built page has, so the PDF's page replaces it)
                    (if whole { h } else { provisional(h) }, whole)
                });
                if st.hashes.len() <= k {
                    st.hashes.resize(k + 1, None);
                }
                st.hashes[k] = Some((h, whole));
                h
            })
            .collect()
    }

    /// Page `k` of the build running, drawn from its own PDF (its fonts'
    /// whole programs read as the build reads them), if it was shipped.
    pub fn stream_draw(&mut self, k: usize) -> Option<String> {
        let h = *self.stream_hashes().get(k)?;
        if h == 0 {
            return None;
        }
        if let Some(d) = self.stream.as_ref()?.draws.get(&h) {
            return Some(d.clone());
        }
        let st = self.stream.as_mut()?;
        let host: &mut MemHost = match &mut st.run {
            Some(Run::Plain { tex, .. }) => tex.host_mut(),
            Some(Run::Trip1 { tex, .. }) => tex.host_mut(),
            _ => self.tex.as_mut()?.host_mut(),
        };
        let mut read = |n: &[u8], kind: FileKind| partex_core::Host::read_file(host, n, kind).map(|f| f.contents);
        let (pdf, _) = st.shipped.page_pdf(k, &mut read)?;
        let d = phitex_draw::Pdf::open(&std::sync::Arc::from(pdf))?.draw(0, &mut self.pdf_fonts)?;
        st.draws.insert(h, d.clone());
        Some(d)
    }

    /// An edit or a file set while the build streams: while it settles,
    /// its trips stop (their work pending: the edit's rebuild goes on with
    /// it, the trips that follow on idle); while its first trip runs, the
    /// edit waits for it (the file is the session's; the build reads its
    /// own copy).
    pub(crate) fn stream_edited(&mut self) {
        let settling = self.stream.as_ref().is_some_and(|s| !s.typesetting());
        if settling {
            self.history_log.push("streamed: the settle stopped by an edit, its work pending".into());
            self.stream = None;
            self.unsettled = true;
            if let Some(t) = self.tex.as_mut() {
                quiet(t.host_mut());
            }
        }
    }

    /// The files named ahead not yet handed on, resolved to what the
    /// worker fetches (`engine TAB key`): those the session has not got.
    fn wants(&mut self) -> Vec<String> {
        let Some(st) = self.stream.as_mut() else { return Vec::new() };
        let host: &mut MemHost = match &mut st.run {
            Some(Run::Plain { tex, .. }) => tex.host_mut(),
            Some(Run::Trip1 { tex, .. }) => tex.host_mut(),
            _ => match self.tex.as_mut() {
                Some(t) => t.host_mut(),
                None => return Vec::new(),
            },
        };
        let hints = host.hints.as_mut().map(std::mem::take).unwrap_or_default();
        let mut out = Vec::new();
        let Some((cache, engine)) = host.shelf.clone() else { return out };
        for (n, kind) in hints {
            if !st.wanted.insert(n.clone()) || host.files.contains_key(&n) {
                continue;
            }
            if let Some(key) = shelf::key(&cache, &n, shelf::format(kind), engine)
                && !host.files.contains_key(&key)
                && !shelf::has(&cache, &key)
            {
                out.push(format!("{engine}\t{}", String::from_utf8_lossy(&key)));
            }
        }
        out
    }
}

/// A host that keeps no more streams or hints.
fn quiet(h: &mut MemHost) {
    h.shipments = None;
    h.shipped_new.clear();
    h.hints = None;
}

/// The pages and forms `host` was shipped since, and which pages.
fn took(host: &mut MemHost) -> Option<(Shipments, Vec<usize>)> {
    let s = host.shipments.as_mut()?;
    Some((std::mem::take(s), std::mem::take(&mut host.shipped_new)))
}

/// Streams shipped (`took`) into `st`.
fn absorb(st: &mut Stream, got: Option<(Shipments, Vec<usize>)>) {
    let Some((got, new)) = got else { return };
    // (a form may come after the page that draws it: the pages not whole
    // are hashed and drawn again, the form with them now)
    if got.forms() > 0 {
        for h in &mut st.hashes {
            if h.is_some_and(|(_, whole)| !whole) {
                *h = None;
            }
        }
    }
    st.shipped.extend(got);
    for k in new {
        if let Some(h) = st.hashes.get_mut(k) {
            *h = None;
        }
        if k == 0 && st.first_page_ms.is_none() {
            st.first_page_ms = Some(ms(st.begun.elapsed()));
        }
    }
    if st.first_page_ms.is_some() && st.pages_at_first == 0 {
        st.pages_at_first = st.shipped.pages();
    }
}

/// A hash no built page has (a page shown before its PDF is in, not drawn
/// whole from its stream).
fn provisional(h: u64) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut s = std::collections::hash_map::DefaultHasher::new();
    (h, "shipped").hash(&mut s);
    s.finish()
}

// The extension's storage as after its onboarding: terms accepted, the
// welcome tip, the tour and the release notes seen, the Instant view on.
// Debug scripts write this before opening a project, so no run clicks
// through "Try it", the terms' checkbox and "Enable", or the tour's "Next":
//   scripts/mock-run.mjs (Chromium), scripts/fx-run.mjs (Firefox).
// They post it to the content script from the mock's page (a hook that
// listens on localhost only, content-main.ts "phitex-dev"), then reload:
// the browsers' automation can't open the extension's own pages.
//
// Keep in step with content-main.ts (TERMS, the keys it reads) and
// popup.ts.

/** The storage keys and values; `version`: the manifest's, for newsSeen. */
export function onboarded(version) {
  return {
    accepted: 1, // (content-main.ts TERMS)
    view: "phitex", // (open projects in ⚡ Instant)
    tipOff: true, // (the welcome tip)
    toured: true, // (the 5-step tour)
    newsSeen: version, // (the release notes for this version)
    dlExplained: true, // (the first-download popover)
  };
}

/** A JavaScript expression for the mock's page: a promise of "onboarded" once written. */
export function onboardScript(version, extra = {}) {
  return `new Promise((ok) => { addEventListener("message", (e) => e.data?.src === "phitex-dev" && e.data.type === "onboarded" && ok("onboarded")); postMessage({ src: "phitex-dev", type: "onboard", storage: ${JSON.stringify({ ...onboarded(version), ...extra })} }, location.origin); setTimeout(() => ok("timeout: no content script?"), 5000); })`;
}

/** A JavaScript expression for the mock's page: a promise of the content script's trace and errors (JSON). */
export function traceScript() {
  return `new Promise((ok) => { addEventListener("message", (e) => e.data?.src === "phitex-dev" && e.data.type === "traced" && ok(e.data.trace)); postMessage({ src: "phitex-dev", type: "trace" }, location.origin); setTimeout(() => ok("timeout: no content script?"), 3000); })`;
}

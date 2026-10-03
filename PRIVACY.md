# Privacy policy: PhiTeX Instant for Overleaf (unofficial)

*Last updated: 3 October 2026*

**PhiTeX Instant collects no data.** Nothing about you or your documents
is sent to the extension's authors or to anyone else.

- **What it reads.** On Overleaf project pages, it reads the project you
  are editing (from the editor, and the project's files from overleaf.com,
  as you, signed in: its text files, and its ZIP for figures) so that its
  engine can typeset it. That happens entirely in your browser.
- **What it sends.** Your documents are never sent anywhere. Besides those
  reads from overleaf.com, it makes one kind of request: for a TeX package
  it doesn't bundle, a plain download of that package from Shelf
  (`shelf-phitex.pages.dev`, static files on Cloudflare Pages), such as
  `…/tl2026/p/tikz.pack`. The request carries only the package's name,
  which comes from TeX Live's public list. It carries no document text, no
  file name of yours, and no identifier or cookie. Like any website,
  Cloudflare sees the request and your IP address. Shelf keeps no logs of
  its own. There are no analytics, no tracking and no remote code.
- **What it stores.** Its own settings, in your browser's extension
  storage: whether it is on, which preview opens, the page view, whether
  tips and the speed chip show, whether you accepted its terms, and the
  panel's layout. The TeX packages it downloaded, in your browser's
  IndexedDB, so they are fetched only once. No document content is stored.
  *Package cache → Clear* in the settings deletes the packages. *Reset
  extension* deletes the settings. Removing the extension deletes both.
- **Third parties.** Cloudflare hosts Shelf, as described above. Overleaf is a separate service with its own
  privacy policy. This extension is unofficial and not affiliated with
  Overleaf.

Questions: Ammar Seliaman, <contact email or issue tracker URL>.

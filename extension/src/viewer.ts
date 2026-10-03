// The pages, continuous: every page stacked in the scroll view, as Overleaf's
// pdf.js viewer shows them. Only the pages near the view are drawn, and a
// page is drawn again only when its box changed (each page's hash, from the
// core). The page most in view is the one an edit paints first.

import type { PageImage } from "./session.ts";
import { patch, type Draws2 } from "./page2.ts";

export interface ViewerHost {
  /** Draw page `k` (the viewer wants it: in view, and not drawn at its hash). */
  need(k: number): void;
  /** The page most in view changed. */
  inView(k: number): void;
  /** A page as markup: the SVG of its draws at `cssWidth`, or null for a PNG. */
  svg(img: PageImage, cssWidth: number): string | null;
  /** CSS pixels per PDF point at the current zoom (1 is 100%). */
  scale(): number;
  /** A double-click at (x, y) on page `k`, in PDF points from its top left. */
  dbl?(k: number, x: number, y: number): void;
  /** A page box's CSS size at `cssWidth` (pdf.js's rounding). */
  box(d: { w: number; h: number }, cssWidth: number): [number, number];
}

interface Slot {
  el: HTMLElement;
  /** The hash the page has now, and the one drawn (null: not drawn). */
  hash: string;
  drawn: string | null;
  img: PageImage | null;
}

/** A US Letter page, in PDF points, until a page says otherwise. */
const LETTER = { w: 612, h: 792 };

export class Viewer {
  private slots: Slot[] = [];
  private size = LETTER;
  private visible = new Set<number>();
  private ratios = new Map<number, number>();
  private current = 0;
  private io: IntersectionObserver;
  private asked = new Set<string>();
  private root: HTMLElement;
  private scroller: HTMLElement;
  private host: ViewerHost;

  constructor(root: HTMLElement, scroller: HTMLElement, host: ViewerHost) {
    this.root = root;
    this.scroller = scroller;
    this.host = host;
    // (a screen above and below: drawn before they scroll in)
    this.io = new IntersectionObserver((es) => this.seen(es), { root: scroller, rootMargin: "100% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] });
    // (a double-click: the source of what is under it, as Overleaf's PDF viewer does)
    root.addEventListener("dblclick", (e) => {
      const el = (e.target as Element).closest<HTMLElement>(".slot");
      if (!el) return;
      const r = el.getBoundingClientRect();
      const k = Number(el.dataset.k);
      host.dbl?.(k, ((e.clientX - r.left) / r.width) * this.size.w, ((e.clientY - r.top) / r.height) * this.size.h);
    });
  }

  /** Highlight `boxes` ([x, y top, w, h], PDF points) on page `k`, scrolled into view, for a moment. */
  mark(k: number, boxes: [number, number, number, number][]): void {
    const s = this.slots[k];
    if (!s || !boxes.length) return;
    for (const m of this.root.querySelectorAll(".mark")) m.remove();
    // (the page it jumps to, drawn now: not when the observer next sees it)
    if (s.drawn !== s.hash && !this.asked.has(`${k}:${s.hash}`)) {
      this.asked.add(`${k}:${s.hash}`);
      this.host.need(k);
    }
    const { w, h } = this.size;
    for (const [x, y, bw, bh] of boxes) {
      const m = document.createElement("div");
      m.className = "mark";
      Object.assign(m.style, { left: `${(x / w) * 100}%`, top: `${(y / h) * 100}%`, width: `${(bw / w) * 100}%`, height: `${(bh / h) * 100}%` });
      s.el.append(m);
    }
    // (the first box in the middle of the view, unless it is in view already)
    const top = s.el.offsetTop + (boxes[0][1] / h) * s.el.offsetHeight;
    const v = this.scroller;
    if (top < v.scrollTop + 20 || top > v.scrollTop + v.clientHeight - 40) v.scrollTo({ top: top - v.clientHeight / 2, behavior: "auto" });
    setTimeout(() => s.el.querySelectorAll(".mark").forEach((m) => m.classList.add("fade")), 1200);
    setTimeout(() => s.el.querySelectorAll(".mark.fade").forEach((m) => m.remove()), 2400);
  }

  get pages(): number {
    return this.slots.length;
  }

  get page(): number {
    return this.current;
  }

  /** The pages there are now, by hash: slots added or removed, changed ones drawn again when seen. */
  layout(hashes: string[]): void {
    while (this.slots.length > hashes.length) {
      const s = this.slots.pop()!;
      this.io.unobserve(s.el);
      s.el.remove();
    }
    for (let k = 0; k < hashes.length; k++) {
      let s = this.slots[k];
      if (!s) {
        const el = document.createElement("div");
        el.className = "slot";
        el.dataset.k = String(k);
        el.setAttribute("aria-label", `Page ${k + 1}`);
        this.root.append(el);
        s = { el, hash: hashes[k], drawn: null, img: null };
        this.slots.push(s);
        this.sizeSlot(s);
        this.io.observe(el);
      }
      s.hash = hashes[k];
    }
    // (asked once a layout: an ask lost, say before the session was up, goes again)
    this.asked.clear();
    this.wantVisible();
  }

  /** Page `k` drawn: `img` at `hash` (the painted page of an edit, or one the viewer asked for). */
  set(k: number, img: PageImage, hash: string | null): void {
    const s = this.slots[k];
    if (!s) return;
    if (hash) this.asked.delete(`${k}:${hash}`);
    if ("draws" in img) this.size = { w: img.draws.w, h: img.draws.h };
    else if ("w" in img && img.w && img.h) this.size = { w: img.w, h: img.h };
    s.img = img;
    s.drawn = hash ?? s.hash;
    this.paint(s);
  }

  /** The format changed: every page is to be drawn again (as it comes into view). */
  invalidate(): void {
    for (const s of this.slots) s.drawn = null;
    this.asked.clear();
    this.wantVisible();
  }

  /** The zoom changed: every drawn page again, at its new size. */
  redraw(): void {
    for (const s of this.slots) {
      this.sizeSlot(s);
      if (s.img) this.paint(s);
    }
  }

  /** Scroll page `k` into view, as Overleaf's page buttons do. */
  goTo(k: number): void {
    const s = this.slots[Math.max(0, Math.min(k, this.slots.length - 1))];
    if (!s) return;
    this.scroller.scrollTo({ top: s.el.offsetTop - 12, behavior: "auto" });
  }

  private sizeSlot(s: Slot): void {
    const [w, h] = this.host.box(this.size, this.size.w * (96 / 72) * this.host.scale());
    s.el.style.width = `${w}px`;
    s.el.style.height = `${h}px`;
  }

  private paint(s: Slot): void {
    if (!s.img) return;
    // (a highlight outlives the page drawn under it: put back after)
    const marks = [...s.el.querySelectorAll(".mark")];
    this.draw(s);
    for (const m of marks) if (!m.isConnected) s.el.append(m);
  }

  private draw(s: Slot): void {
    if (!s.img) return;
    const w = this.size.w * (96 / 72) * this.host.scale();
    this.sizeSlot(s);
    // (v2, from the PDF: updated by parts, not drawn again whole)
    if ("draws" in s.img && (s.img.draws as unknown as Draws2).v === 2) {
      const [bw, bh] = this.host.box(this.size, w);
      patch(s.el, s.img.draws as unknown as Draws2, bw, bh);
      return;
    }
    const markup = this.host.svg(s.img, w);
    if (markup !== null) {
      s.el.innerHTML = markup;
      return;
    }
    if ("canvas" in s.img) {
      // (drawn already: swapped in whole, so the page never blanks)
      s.img.canvas.style.width = "100%";
      s.img.canvas.style.height = "100%";
      if (s.el.firstChild !== s.img.canvas) s.el.replaceChildren(s.img.canvas);
      return;
    }
    if (!("png" in s.img)) return;
    const url = URL.createObjectURL(new Blob([s.img.png as BlobPart], { type: "image/png" }));
    const im = document.createElement("img");
    im.alt = `page ${Number(s.el.dataset.k) + 1}`;
    im.onload = () => URL.revokeObjectURL(url);
    im.src = url;
    s.el.replaceChildren(im);
  }

  private seen(es: IntersectionObserverEntry[]): void {
    for (const e of es) {
      const k = Number((e.target as HTMLElement).dataset.k);
      if (e.isIntersecting) this.visible.add(k);
      else this.visible.delete(k);
      // (how much of it is on screen, not in the margin: the page "in view")
      const r = e.rootBounds;
      const b = e.boundingClientRect;
      const onScreen = r ? Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top)) : 0;
      this.ratios.set(k, onScreen);
    }
    let best = this.current, most = -1;
    for (const k of this.visible) {
      const v = this.ratios.get(k) ?? 0;
      if (v > most) {
        most = v;
        best = k;
      }
    }
    if (best !== this.current && most > 0) {
      this.current = best;
      this.host.inView(best);
    }
    this.wantVisible();
  }

  /** Ask for each visible page not drawn at its hash (once per hash). */
  private wantVisible(): void {
    for (const k of this.visible) {
      const s = this.slots[k];
      if (!s || s.drawn === s.hash) continue;
      const key = `${k}:${s.hash}`;
      if (this.asked.has(key)) continue;
      this.asked.add(key);
      this.host.need(k);
    }
  }
}

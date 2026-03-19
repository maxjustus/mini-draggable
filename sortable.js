// Vanilla JS drag-to-reorder library.
// Uses placeholder + FLIP for correct positioning in any layout
// (lists, grids, flex, variable heights).
//
// Supports cross-container transfer via the `group` option.
//
// Usage:
//   import { sortable } from './sortable.js';
//   const s = sortable(container, {
//     items: '[data-sortable]',
//     handle: '[data-sortable-handle]',
//     group: 'board',
//     onReorder({ from, to }) { ... },
//     onTransfer({ from, to, el, sourceContainer, targetContainer }) { ... },
//   });
//   s.destroy();

/**
 * @typedef {{x: number, y: number}} Point
 * @typedef {{from: number, to: number}} ReorderEvent
 * @typedef {{from: number, to: number, el: HTMLElement, sourceContainer: SortableInstance, targetContainer: SortableInstance}} TransferEvent
 * @typedef {{scrollBy: (x: number, y: number) => void, scrollX: number, scrollY: number, scrollWidth: number, scrollHeight: number, width: number, height: number}} ScrollTarget
 * @typedef {{
 *   items?: string,
 *   handle?: string | null,
 *   disabled?: ((el: HTMLElement) => boolean) | null,
 *   onReorder?: ((event: ReorderEvent) => void) | null,
 *   onTransfer?: ((event: TransferEvent) => void) | null,
 *   group?: string | null,
 *   dragThreshold?: number,
 *   touchClickDelay?: number,
 *   scrollThreshold?: number,
 * }} SortableOptions
 * @typedef {Required<SortableOptions>} Opts
 * @typedef {{el: HTMLElement, opts: Opts, meta: Record<string, any>, destroy: () => void}} SortableInstance
 */

/** @type {Opts} */
const DEFAULTS = {
  items: "[data-sortable]",
  handle: null,
  disabled: (/** @type {HTMLElement} */ el) => el.hasAttribute("data-drag-disabled"),
  onReorder: null,
  onTransfer: null,
  group: null,
  dragThreshold: 5,
  touchClickDelay: 100,
  scrollThreshold: 150,
};

const STYLE_PROPS = /** @type {const} */ (["transform", "transition", "position", "zIndex", "top", "left", "width", "height"]);
const SETTLE_BUFFER_MS = 50;

/** @type {Map<string, Set<SortableInstance>>} */
const groups = new Map();
/** @type {WeakSet<HTMLElement>} */
const initialized = new WeakSet();

/** @param {MouseEvent | TouchEvent} e @returns {Point} */
function pointerPos(e) {
  if ("touches" in e) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  return { x: e.clientX, y: e.clientY };
}

/**
 * @template T
 * @param {T[]} arr
 * @param {number} from
 * @param {number} to
 * @returns {T[]}
 */
export function arrMove(arr, from, to) {
  arr.splice(to, 0, arr.splice(from, 1)[0]);
  return arr;
}

/** @param {number} x @param {number} y @param {HTMLElement} el @returns {boolean} */
function hitTest(x, y, el) {
  const r = el.getBoundingClientRect();
  return x > r.left && x < r.right && y > r.top && y < r.bottom;
}

/** @param {HTMLElement[]} items @returns {Map<HTMLElement, DOMRect>} */
function captureRects(items) {
  /** @type {Map<HTMLElement, DOMRect>} */
  const m = new Map();
  for (const el of items) m.set(el, el.getBoundingClientRect());
  return m;
}

/** @param {HTMLElement} el @returns {number} */
function cssTransitionMs(el) {
  const raw = getComputedStyle(el).transitionDuration;
  return raw ? parseFloat(raw) * 1000 : 0;
}

/** @param {HTMLElement} el @returns {HTMLElement | null} */
function findScrollParent(el) {
  /** @type {HTMLElement | null} */
  let n = el;
  while (n) {
    if (/scroll|auto/.test(getComputedStyle(n).overflow)) return n;
    n = n.parentElement;
  }
  return null;
}

/** @param {HTMLElement | null} el @returns {ScrollTarget} */
function buildScrollTarget(el) {
  if (el) return {
    scrollBy(x, y) { el.scrollTop += y; el.scrollLeft += x; },
    get scrollX() { return el.scrollLeft; },
    get scrollY() { return el.scrollTop; },
    get scrollWidth() { return el.scrollWidth; },
    get scrollHeight() { return el.scrollHeight; },
    get width() { return el.getBoundingClientRect().width; },
    get height() { return el.getBoundingClientRect().height; },
  };

  return {
    scrollBy(x, y) { window.scrollBy(x, y); },
    get scrollX() { return window.scrollX; },
    get scrollY() { return window.scrollY; },
    get scrollWidth() { return document.body.scrollWidth; },
    get scrollHeight() { return document.body.scrollHeight; },
    get width() { return window.innerWidth; },
    get height() { return window.innerHeight; },
  };
}

/** @param {HTMLElement} src @returns {HTMLElement} */
function createPlaceholder(src) {
  const ph = /** @type {HTMLElement} */ (document.createElement(src.tagName));
  ph.className = src.className;
  ph.setAttribute("data-drag-placeholder", "");
  const cs = getComputedStyle(src);
  ph.style.cssText = [
    `width:${cs.width}`, `height:${cs.height}`,
    `min-width:${cs.minWidth}`, `min-height:${cs.minHeight}`,
    `margin:${cs.margin}`, `padding:${cs.padding}`, `box-sizing:${cs.boxSizing}`,
    `grid-column:${cs.gridColumn}`, `grid-row:${cs.gridRow}`, `grid-area:${cs.gridArea}`,
    `flex-grow:${cs.flexGrow}`, `flex-shrink:${cs.flexShrink}`, `flex-basis:${cs.flexBasis}`,
    `align-self:${cs.alignSelf}`,
    "pointer-events:none",
  ].join(";");
  ph.textContent = "";
  return ph;
}

/** @param {HTMLElement[]} items @param {Map<HTMLElement, DOMRect>} before @param {Set<HTMLElement>} animating */
function flip(items, before, animating) {
  for (const child of items) {
    const first = before.get(child);
    if (!first) continue;
    const last = child.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (dx === 0 && dy === 0) continue;

    child.style.transition = "none";
    child.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    child.getClientRects();
    child.style.transition = "";
    child.style.transform = "none";

    animating.add(child);
    const done = () => animating.delete(child);
    child.addEventListener("transitionend", done, { once: true });
    setTimeout(done, cssTransitionMs(child) + SETTLE_BUFFER_MS);
  }
}

/** @param {HTMLElement} container @param {number} firstHeight */
function flipHeight(container, firstHeight) {
  const lastHeight = container.getBoundingClientRect().height;
  if (firstHeight === lastHeight) return;
  container.style.height = `${firstHeight}px`;
  container.style.transition = "none";
  container.getClientRects();
  container.style.transition = "";
  container.style.height = `${lastHeight}px`;
  const cleanup = () => { container.style.height = ""; container.style.transition = ""; };
  container.addEventListener("transitionend", cleanup, { once: true });
  setTimeout(cleanup, cssTransitionMs(container) + SETTLE_BUFFER_MS);
}

// Safari workaround: toggling will-change forces a compositing layer
// rebuild to fix hit-test desync after scroll + transform.
/** @param {HTMLElement} container @param {string} selector */
function repaint(container, selector) {
  const items = /** @type {NodeListOf<HTMLElement>} */ (container.querySelectorAll(selector));
  for (const c of items) c.style.willChange = "transform";
  requestAnimationFrame(() => { for (const c of items) c.style.willChange = ""; });
}

/** @param {HTMLElement} el @param {DOMRect} box */
function liftElement(el, box) {
  Object.assign(el.style, {
    position: "fixed", zIndex: "10000",
    top: `${box.top}px`, left: `${box.left}px`,
    width: `${box.width}px`, height: `${box.height}px`,
    transition: "none", transform: "translate3d(0, 0, 0)",
  });
}

/**
 * @param {HTMLElement[]} items
 * @param {HTMLElement} placeholder
 * @param {SortableInstance} inst
 * @param {SortableInstance} activeInst
 */
function cleanupDrag(items, placeholder, inst, activeInst) {
  placeholder.remove();
  for (const child of items) {
    for (const p of STYLE_PROPS) /** @type {any} */ (child.style)[p] = "";
    child.removeAttribute("data-dragging");
  }
  activeInst.el.classList.remove("sortable-active");
  inst.el.classList.remove("sortable-active");
  document.body.style.userSelect = "";
  /** @type {any} */ (document.body.style).webkitUserSelect = "";
  document.body.style.cursor = "";
  repaint(inst.el, inst.opts.items);
  if (activeInst !== inst) repaint(activeInst.el, inst.opts.items);
}

/**
 * @param {{scrollEl: HTMLElement | null, target: ScrollTarget, threshold: number, getPointer: () => Point, isActive: () => boolean, onTick: () => void}} cfg
 * @returns {{start: () => void}}
 */
function createAutoScroller({ scrollEl, target: st, threshold, getPointer, isActive, onTick }) {
  let scrolling = false;

  /** @param {Point} p @returns {{top: number, right: number, bottom: number, left: number}} */
  function edgeDist(p) {
    if (scrollEl) {
      const r = scrollEl.getBoundingClientRect();
      return { top: p.y - r.top, right: r.right - p.x, bottom: r.bottom - p.y, left: p.x - r.left };
    }
    return { top: p.y, right: innerWidth - p.x, bottom: innerHeight - p.y, left: p.x };
  }

  /** @returns {{x: number, y: number}} */
  function thresh() {
    if (scrollEl) {
      const r = scrollEl.getBoundingClientRect();
      return { x: Math.min(r.width * 0.25, threshold), y: Math.min(r.height * 0.25, threshold) };
    }
    return { x: threshold, y: threshold };
  }

  /** @param {{top: number, right: number, bottom: number, left: number}} d @param {{x: number, y: number}} t @returns {boolean} */
  function shouldScroll(d, t) {
    return (d.top < t.y && st.scrollY > 0) ||
           (d.right < t.x && st.scrollX + st.width < st.scrollWidth) ||
           (d.bottom < t.y && st.scrollY + st.height < st.scrollHeight) ||
           (d.left < t.x && st.scrollX > 0);
  }

  function loop() {
    if (!isActive() || !scrolling) { scrolling = false; return; }
    requestAnimationFrame(loop);
    const d = edgeDist(getPointer());
    const t = thresh();
    if (d.top < t.y && st.scrollY > 0) st.scrollBy(0, -(2 ** ((t.y - d.top) / 28)));
    if (d.right < t.x && st.scrollX + st.width < st.scrollWidth) st.scrollBy(2 ** ((t.x - d.right) / 28), 0);
    if (d.bottom < t.y && st.scrollY + st.height < st.scrollHeight) st.scrollBy(0, 2 ** ((t.y - d.bottom) / 28));
    if (d.left < t.x && st.scrollX > 0) st.scrollBy(-(2 ** ((t.x - d.left) / 28)), 0);
    onTick();
  }

  return {
    start() {
      if (scrolling) return;
      if (shouldScroll(edgeDist(getPointer()), thresh())) {
        scrolling = true;
        requestAnimationFrame(loop);
      }
    },
  };
}

/**
 * @param {HTMLElement} placeholder
 * @param {HTMLElement} container
 * @param {HTMLElement[]} items
 * @param {number} cy
 * @returns {number}
 */
function insertPlaceholderAt(placeholder, container, items, cy) {
  const found = items.findIndex(c => { const r = c.getBoundingClientRect(); return cy < r.top + r.height / 2; });
  const idx = found === -1 ? items.length : found;
  if (idx >= items.length) container.appendChild(placeholder);
  else container.insertBefore(placeholder, items[idx]);
  return idx;
}

/**
 * @param {MouseEvent | TouchEvent} e
 * @param {HTMLElement} container
 * @param {Opts} opts
 * @returns {HTMLElement | null}
 */
function validateDragTarget(e, container, opts) {
  const target = /** @type {HTMLElement} */ (e.target);
  const item = /** @type {HTMLElement | null} */ (target.closest(opts.items));
  if (!item || !container.contains(item)) return null;
  if (opts.disabled?.(item)) return null;
  if (opts.handle && item.querySelector(opts.handle)) {
    const handle = target.closest(opts.handle);
    if (!handle || !item.contains(handle)) return null;
  }
  if ("button" in e && e.button !== 0) return null;
  return item;
}

class DragSession {
  /**
   * @param {SortableInstance} inst
   * @param {HTMLElement} el
   * @param {Point} initialPos
   */
  constructor(inst, el, initialPos) {
    this.inst = inst;
    this.opts = inst.opts;
    this.el = el;
    this.initialPos = initialPos;
    this.box = el.getBoundingClientRect();
    this.placeholder = createPlaceholder(el);
    /** @type {Set<HTMLElement>} */
    this.animating = new Set();
    this.items = /** @type {HTMLElement[]} */ ([...inst.el.querySelectorAll(this.opts.items)]);
    this.originalIndex = this.items.indexOf(el);
    this.startIndex = this.originalIndex;
    this.currentIndex = this.originalIndex;
    this.pointer = initialPos;
    /** @type {SortableInstance} */
    this.activeInst = inst;
    this.dropping = false;
    this.indexDirty = false;

    // Visual position tracking — diverges from DOM order after each reposition
    /** @type {Map<HTMLElement, number>} */
    this.indices = new Map();
    this.items.forEach((c, i) => this.indices.set(c, i));

    // Exclusion zone: suppress swaps while dragged center is inside the
    // last-swapped target's pre-swap rect (prevents grid oscillation)
    /** @type {DOMRect | null} */
    this.exclusionZone = null;

    /** @type {Node} */ (el.parentNode).insertBefore(this.placeholder, el);
    liftElement(el, this.box);
    el.setAttribute("data-dragging", "");
    inst.el.classList.add("sortable-active");
    document.body.style.userSelect = "none";
    /** @type {any} */ (document.body.style).webkitUserSelect = "none";
    document.body.style.cursor = "grabbing";

    const scrollEl = findScrollParent(inst.el);
    this.scroller = createAutoScroller({
      scrollEl,
      target: buildScrollTarget(scrollEl),
      threshold: this.opts.scrollThreshold,
      getPointer: () => this.pointer,
      isActive: () => !this.dropping,
      onTick: () => this.updateIndex(),
    });
  }

  /** @param {Point} pos */
  move(pos) {
    if (this.dropping) return;
    this.pointer = pos;
    this.el.style.transform = `translate3d(${pos.x - this.initialPos.x}px, ${pos.y - this.initialPos.y}px, 0)`;
    this.scroller.start();
    if (!this.indexDirty) {
      this.indexDirty = true;
      requestAnimationFrame(() => { this.indexDirty = false; this.updateIndex(); });
    }
  }

  updateIndex() {
    if (this.dropping) return;

    const r = this.el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    if (this.exclusionZone) {
      if (cx > this.exclusionZone.left && cx < this.exclusionZone.right &&
          cy > this.exclusionZone.top && cy < this.exclusionZone.bottom) return;
      this.exclusionZone = null;
    }

    for (const child of this.items) {
      if (child === this.el || this.animating.has(child)) continue;
      if (hitTest(cx, cy, child)) {
        const idx = /** @type {number} */ (this.indices.get(child));
        if (idx !== this.currentIndex) {
          this.exclusionZone = child.getBoundingClientRect();
          this.currentIndex = idx;
          this.reposition();
        }
        return;
      }
    }
    if (this.opts.group) this.checkTransfer(cx, cy);
  }

  reposition() {
    const newOrder = arrMove([...this.items], this.startIndex, this.currentIndex);
    const siblings = this.items.filter(c => c !== this.el);
    const before = captureRects(siblings);
    const dragIdx = newOrder.indexOf(this.el);
    const ref = newOrder.slice(dragIdx + 1).find(c => c !== this.el) ?? null;
    /** @type {Node} */ (this.placeholder.parentNode).insertBefore(this.placeholder, ref);
    newOrder.forEach((c, i) => this.indices.set(c, i));
    flip(siblings, before, this.animating);
  }

  /** @param {number} cx @param {number} cy */
  checkTransfer(cx, cy) {
    if (hitTest(cx, cy, this.activeInst.el)) return;
    const group = /** @type {Set<SortableInstance>} */ (groups.get(/** @type {string} */ (this.opts.group)));
    for (const other of group) {
      if (other === this.activeInst) continue;
      if (hitTest(cx, cy, other.el)) { this.transfer(other, cy); return; }
    }
  }

  /** @param {SortableInstance} target @param {number} cy */
  transfer(target, cy) {
    const oldInst = this.activeInst;
    const siblings = this.items.filter(c => c !== this.el);
    const targetItems = /** @type {HTMLElement[]} */ ([...target.el.querySelectorAll(target.opts.items)])
      .filter(c => c !== this.el);

    const oldRects = captureRects(siblings);
    const targetRects = captureRects(targetItems);
    const oldHeight = oldInst.el.getBoundingClientRect().height;
    const targetHeight = target.el.getBoundingClientRect().height;

    this.placeholder.remove();
    oldInst.el.classList.remove("sortable-active");

    const insertIdx = insertPlaceholderAt(this.placeholder, target.el, targetItems, cy);
    target.el.classList.add("sortable-active");

    this.items = /** @type {HTMLElement[]} */ ([...target.el.querySelectorAll(target.opts.items)]).filter(c => c !== this.el);
    this.items.splice(insertIdx, 0, this.el);
    this.indices.clear();
    this.items.forEach((c, i) => this.indices.set(c, i));
    this.startIndex = insertIdx;
    this.currentIndex = insertIdx;
    this.activeInst = target;

    flip(siblings, oldRects, this.animating);
    flip(targetItems, targetRects, this.animating);
    flipHeight(oldInst.el, oldHeight);
    flipHeight(target.el, targetHeight);
  }

  drop() {
    this.dropping = true;
    const target = this.placeholder.getBoundingClientRect();
    this.el.style.transition = "";
    this.el.removeAttribute("data-dragging");
    this.el.getClientRects();
    this.el.style.transform = `translate3d(${target.left - this.box.left}px, ${target.top - this.box.top}px, 0)`;

    let done = false;
    const onSettle = () => {
      if (done) return;
      done = true;

      cleanupDrag(this.items, this.placeholder, this.inst, this.activeInst);

      const crossContainer = this.activeInst !== this.inst;
      const from = crossContainer ? this.originalIndex : this.startIndex;
      const to = this.currentIndex;

      if (crossContainer && this.opts.onTransfer) {
        requestAnimationFrame(() => this.opts.onTransfer && this.opts.onTransfer({
          from, to, el: this.el, sourceContainer: this.inst, targetContainer: this.activeInst,
        }));
      } else if (!crossContainer && from !== to && this.opts.onReorder) {
        requestAnimationFrame(() => this.opts.onReorder && this.opts.onReorder({ from, to }));
      }
    };

    this.el.addEventListener("transitionend", onSettle, { once: true });
    setTimeout(onSettle, cssTransitionMs(this.el) + SETTLE_BUFFER_MS);
  }
}

/**
 * @param {HTMLElement} container
 * @param {SortableOptions} [userOpts]
 * @returns {SortableInstance}
 */
export function sortable(container, userOpts = {}) {
  if (initialized.has(container)) throw new Error("sortable() already called on this element");
  initialized.add(container);

  /** @type {Opts} */
  const opts = { ...DEFAULTS, ...userOpts };
  /** @type {Record<string, any>} */
  const meta = {};

  /** @type {DragSession | null} */
  let session = null;

  const ac = new AbortController();
  const sig = ac.signal;
  /** @param {EventTarget} t @param {string} evt @param {EventListener} fn @param {AddEventListenerOptions} [o] */
  const on = (t, evt, fn, o) => t.addEventListener(evt, fn, { signal: sig, ...o });

  /** @type {SortableInstance} */
  const inst = {
    el: container,
    opts,
    meta,
    destroy() {
      ac.abort();
      initialized.delete(container);
      if (opts.group) groups.get(opts.group)?.delete(inst);
    },
  };

  if (opts.group) {
    if (!groups.has(opts.group)) groups.set(opts.group, new Set());
    /** @type {Set<SortableInstance>} */ (groups.get(opts.group)).add(inst);
  }

  /** @param {MouseEvent | TouchEvent} e */
  function onPointerDown(e) {
    if (session) return;
    const item = validateDragTarget(e, container, opts);
    if (!item) return;

    if (e.type === "touchstart") {
      e.preventDefault();
      const target = /** @type {HTMLElement} */ (e.target);
      setTimeout(() => {
        if (!session) target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }, opts.touchClickDelay);
    }

    const initialPos = pointerPos(e);
    let pending = true;

    /** @param {MouseEvent | TouchEvent} e */
    function onMove(e) {
      const pos = pointerPos(e);
      if (pending) {
        if (Math.abs(pos.x - initialPos.x) < opts.dragThreshold &&
            Math.abs(pos.y - initialPos.y) < opts.dragThreshold) return;
        pending = false;
        session = new DragSession(inst, /** @type {HTMLElement} */ (item), initialPos);
      }
      e.preventDefault();
      session?.move(pos);
    }

    function onUp() {
      dragAc.abort();
      if (session) {
        session.drop();
        session = null;
      }
      pending = false;
    }

    const dragAc = new AbortController();
    const dragSig = dragAc.signal;
    sig.addEventListener("abort", () => dragAc.abort());
    window.addEventListener("mousemove", /** @type {EventListener} */ (onMove), { passive: false, signal: dragSig });
    window.addEventListener("touchmove", /** @type {EventListener} */ (onMove), { passive: false, signal: dragSig });
    window.addEventListener("mouseup", onUp, { signal: dragSig });
    window.addEventListener("touchend", onUp, { signal: dragSig });
    window.addEventListener("touchcancel", onUp, { signal: dragSig });
  }

  on(container, "mousedown", /** @type {EventListener} */ (onPointerDown));
  on(container, "touchstart", /** @type {EventListener} */ (onPointerDown), { passive: false });
  on(window, "selectstart", (e) => { if (session) e.preventDefault(); });
  on(window, "dragstart", (e) => { if (session) e.preventDefault(); });

  return inst;
}

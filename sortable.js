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
const REORDER_COOLDOWN_MS = 50;
const SETTLE_BUFFER_MS = 50;

/** @type {Map<string, Set<SortableInstance>>} */
const groups = new Map();

// --- Utilities ---

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
function scrollTarget(el) {
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

// --- Drag session ---

/**
 * @param {SortableInstance} inst
 * @param {HTMLElement} el
 * @param {Point} initialPos
 */
function createSession(inst, el, initialPos) {
  const { opts } = inst;
  const box = el.getBoundingClientRect();
  const scrollEl = findScrollParent(inst.el);
  const st = scrollTarget(scrollEl);
  const placeholder = createPlaceholder(el);
  /** @type {Set<HTMLElement>} */
  const animating = new Set();

  let items = /** @type {HTMLElement[]} */ ([...inst.el.querySelectorAll(opts.items)]);
  /** @type {Map<HTMLElement, number>} */
  const indices = new Map();
  items.forEach((c, i) => indices.set(c, i));

  let startIndex = items.indexOf(el);
  let currentIndex = startIndex;
  let lastReorderTime = 0;
  let pointer = initialPos;
  let scrolling = false;
  let sourceInst = inst;
  let sourceIndex = startIndex;
  let activeInst = inst;
  let dropping = false;

  // Lift element into fixed position
  /** @type {Node} */ (el.parentNode).insertBefore(placeholder, el);
  Object.assign(el.style, {
    position: "fixed", zIndex: "10000",
    top: `${box.top}px`, left: `${box.left}px`,
    width: `${box.width}px`, height: `${box.height}px`,
    transition: "none", transform: "translate3d(0, 0, 0)",
  });
  el.setAttribute("data-dragging", "");
  inst.el.classList.add("sortable-active");
  document.body.style.userSelect = "none";
  /** @type {any} */ (document.body.style).webkitUserSelect = "none";
  document.body.style.cursor = "grabbing";

  // --- Move ---

  /** @param {Point} pos */
  function move(pos) {
    if (dropping) return;
    pointer = pos;
    el.style.transform = `translate3d(${pos.x - initialPos.x}px, ${pos.y - initialPos.y}px, 0)`;
    startAutoScroll();
    requestAnimationFrame(updateIndex);
  }

  function updateIndex() {
    if (dropping) return;
    if (Date.now() - lastReorderTime < REORDER_COOLDOWN_MS) return;

    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    for (const child of items) {
      if (child === el || animating.has(child)) continue;
      if (hitTest(cx, cy, child)) {
        const idx = /** @type {number} */ (indices.get(child));
        if (idx !== currentIndex) {
          currentIndex = idx;
          reposition();
        }
        return;
      }
    }
    if (opts.group) checkTransfer(cx, cy);
  }

  function reposition() {
    const newOrder = arrMove([...items], startIndex, currentIndex);
    const siblings = items.filter(c => c !== el);
    const before = captureRects(siblings);

    // Move placeholder
    const dragIdx = newOrder.indexOf(el);
    /** @type {HTMLElement | null} */
    let ref = null;
    for (let i = dragIdx + 1; i < newOrder.length; i++) {
      if (newOrder[i] !== el) { ref = newOrder[i]; break; }
    }
    /** @type {Node} */ (placeholder.parentNode).insertBefore(placeholder, ref);

    newOrder.forEach((c, i) => indices.set(c, i));
    flip(siblings, before, animating);
    lastReorderTime = Date.now();
  }

  // --- Cross-container transfer ---

  /**
   * @param {number} cx
   * @param {number} cy
   */
  function checkTransfer(cx, cy) {
    if (hitTest(cx, cy, activeInst.el)) return;
    const group = /** @type {Set<SortableInstance>} */ (groups.get(/** @type {string} */ (opts.group)));
    for (const other of group) {
      if (other === activeInst) continue;
      if (hitTest(cx, cy, other.el)) { transfer(other, cy); return; }
    }
  }

  /**
   * @param {SortableInstance} target
   * @param {number} cy
   */
  function transfer(target, cy) {
    const oldInst = activeInst;
    const siblings = items.filter(c => c !== el);
    const targetItems = /** @type {HTMLElement[]} */ ([...target.el.querySelectorAll(target.opts.items)])
      .filter(c => c !== el);

    const oldRects = captureRects(siblings);
    const targetRects = captureRects(targetItems);
    const oldHeight = oldInst.el.getBoundingClientRect().height;
    const targetHeight = target.el.getBoundingClientRect().height;

    placeholder.remove();
    oldInst.el.classList.remove("sortable-active");

    // Find insertion point
    let insertIdx = targetItems.length;
    for (let i = 0; i < targetItems.length; i++) {
      const r = targetItems[i].getBoundingClientRect();
      if (cy < r.top + r.height / 2) { insertIdx = i; break; }
    }

    if (insertIdx >= targetItems.length) target.el.appendChild(placeholder);
    else target.el.insertBefore(placeholder, targetItems[insertIdx]);
    target.el.classList.add("sortable-active");

    // Rebuild tracking
    items = /** @type {HTMLElement[]} */ ([...target.el.querySelectorAll(target.opts.items)])
      .filter(c => c !== el);
    items.splice(insertIdx, 0, el);
    indices.clear();
    items.forEach((c, i) => indices.set(c, i));
    startIndex = insertIdx;
    currentIndex = insertIdx;
    activeInst = target;

    flip(siblings, oldRects, animating);
    flip(targetItems, targetRects, animating);
    flipHeight(oldInst.el, oldHeight);
    flipHeight(target.el, targetHeight);
  }

  // --- Auto-scroll ---

  function startAutoScroll() {
    if (scrolling) return;
    const d = edgeDist();
    const t = scrollThresh();
    if ((d.top < t.y && st.scrollY > 0) ||
        (d.right < t.x && st.scrollX + st.width < st.scrollWidth) ||
        (d.bottom < t.y && st.scrollY + st.height < st.scrollHeight) ||
        (d.left < t.x && st.scrollX > 0)) {
      scrolling = true;
      requestAnimationFrame(scrollLoop);
    }
  }

  function scrollLoop() {
    if (dropping || !scrolling) { scrolling = false; return; }
    requestAnimationFrame(scrollLoop);
    const d = edgeDist();
    const t = scrollThresh();
    if (d.top < t.y && st.scrollY > 0) st.scrollBy(0, -Math.pow(2, (t.y - d.top) / 28));
    if (d.right < t.x && st.scrollX + st.width < st.scrollWidth) st.scrollBy(Math.pow(2, (t.x - d.right) / 28), 0);
    if (d.bottom < t.y && st.scrollY + st.height < st.scrollHeight) st.scrollBy(0, Math.pow(2, (t.y - d.bottom) / 28));
    if (d.left < t.x && st.scrollX > 0) st.scrollBy(-Math.pow(2, (t.x - d.left) / 28), 0);
    updateIndex();
  }

  /** @returns {{top: number, right: number, bottom: number, left: number}} */
  function edgeDist() {
    if (scrollEl) {
      const r = scrollEl.getBoundingClientRect();
      return { top: pointer.y - r.top, right: r.right - pointer.x, bottom: r.bottom - pointer.y, left: pointer.x - r.left };
    }
    return { top: pointer.y, right: innerWidth - pointer.x, bottom: innerHeight - pointer.y, left: pointer.x };
  }

  /** @returns {{x: number, y: number}} */
  function scrollThresh() {
    const max = opts.scrollThreshold;
    if (scrollEl) {
      const r = scrollEl.getBoundingClientRect();
      return { x: Math.min(r.width * 0.25, max), y: Math.min(r.height * 0.25, max) };
    }
    return { x: max, y: max };
  }

  // --- Drop ---

  function drop() {
    dropping = true;
    scrolling = false;

    const target = placeholder.getBoundingClientRect();
    el.style.transition = "";
    el.removeAttribute("data-dragging");
    el.getClientRects();
    el.style.transform = `translate3d(${target.left - box.left}px, ${target.top - box.top}px, 0)`;

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;

      const crossContainer = activeInst !== sourceInst;
      const from = crossContainer ? sourceIndex : startIndex;
      const to = currentIndex;

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

      repaint(inst.el, opts.items);
      if (crossContainer) repaint(activeInst.el, opts.items);

      if (crossContainer && opts.onTransfer) {
        requestAnimationFrame(() => /** @type {Function} */ (opts.onTransfer)({
          from, to, el, sourceContainer: sourceInst, targetContainer: activeInst,
        }));
      } else if (!crossContainer && from !== to && opts.onReorder) {
        requestAnimationFrame(() => /** @type {Function} */ (opts.onReorder)({ from, to }));
      }
    };

    el.addEventListener("transitionend", settle, { once: true });
    setTimeout(settle, cssTransitionMs(el) + SETTLE_BUFFER_MS);
  }

  return { move, drop };
}

// --- Public API ---

/**
 * @param {HTMLElement} container
 * @param {SortableOptions} [userOpts]
 * @returns {SortableInstance}
 */
export function sortable(container, userOpts = {}) {
  /** @type {Opts} */
  const opts = { ...DEFAULTS, ...userOpts };
  /** @type {Record<string, any>} */
  const meta = {};

  /** @type {ReturnType<typeof createSession> | null} */
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

    const target = /** @type {HTMLElement} */ (e.target);
    const item = /** @type {HTMLElement | null} */ (target.closest(opts.items));
    if (!item || !container.contains(item)) return;
    if (opts.disabled?.(item)) return;
    if (opts.handle && item.querySelector(opts.handle)) {
      const handle = target.closest(opts.handle);
      if (!handle || !item.contains(handle)) return;
    }
    if ("button" in e && e.button !== 0) return;

    if (e.type === "touchstart") {
      e.preventDefault();
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
        session = createSession(inst, /** @type {HTMLElement} */ (item), initialPos);
      }
      e.preventDefault();
      session?.move(pos);
    }

    function onUp() {
      window.removeEventListener("mousemove", /** @type {EventListener} */ (onMove));
      window.removeEventListener("touchmove", /** @type {EventListener} */ (onMove));
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchend", onUp);
      if (session) {
        session.drop();
        session = null;
      }
      pending = false;
    }

    window.addEventListener("mousemove", /** @type {EventListener} */ (onMove), { passive: false });
    window.addEventListener("touchmove", /** @type {EventListener} */ (onMove), { passive: false });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
  }

  on(container, "mousedown", /** @type {EventListener} */ (onPointerDown));
  on(container, "touchstart", /** @type {EventListener} */ (onPointerDown), { passive: false });
  on(window, "selectstart", (e) => { if (session) e.preventDefault(); });
  on(window, "dragstart", (e) => { if (session) e.preventDefault(); });

  return inst;
}


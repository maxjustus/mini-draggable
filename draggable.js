// Vanilla JS drag-to-reorder library.
// Uses placeholder + FLIP for correct positioning in any layout
// (lists, grids, flex, variable heights).
//
// Usage:
//   import { Draggable } from './draggable.js';
//   const d = new Draggable(container, {
//     items: '[data-draggable]',
//     handle: '[data-draggable-handle]',
//     disabled: (el) => el.hasAttribute('data-drag-disabled'),
//     onReorder({ from, to }) { ... },
//   });
//   d.destroy();

const DEFAULTS = {
  items: "[data-draggable]",
  handle: null,
  disabled: null,
  onReorder: null,
  transitionMs: 150,
  dragThreshold: 5,
  touchClickDelay: 100,
  scrollThreshold: 150,
};

const STYLE_PROPS = ["transform", "transition", "position", "zIndex", "top", "left", "width", "height"];

// --- Utilities ---

function pointerPos(e) {
  if (e.touches) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  return { x: e.clientX, y: e.clientY };
}

function arrMove(arr, from, to) {
  arr.splice(to, 0, arr.splice(from, 1)[0]);
  return arr;
}

function findScrollable(el) {
  let node = el;
  while (node) {
    if (/scroll|auto/.test(window.getComputedStyle(node).overflow)) return node;
    node = node.parentElement;
  }
  return null;
}

function createPlaceholder(source) {
  const ph = document.createElement(source.tagName);
  ph.className = source.className;
  ph.setAttribute("data-drag-placeholder", "");
  const cs = window.getComputedStyle(source);
  ph.style.cssText = [
    `width:${cs.width}`, `height:${cs.height}`,
    `min-width:${cs.minWidth}`, `min-height:${cs.minHeight}`,
    `margin:${cs.margin}`, `padding:${cs.padding}`, `box-sizing:${cs.boxSizing}`,
    `grid-column:${cs.gridColumn}`, `grid-row:${cs.gridRow}`, `grid-area:${cs.gridArea}`,
    `flex-grow:${cs.flexGrow}`, `flex-shrink:${cs.flexShrink}`, `flex-basis:${cs.flexBasis}`,
    `align-self:${cs.alignSelf}`,
    "visibility:hidden", "pointer-events:none",
  ].join(";");
  return ph;
}

function buildScrollTarget(scrollEl) {
  if (scrollEl) {
    return {
      scrollBy(x, y) { scrollEl.scrollTop += y; scrollEl.scrollLeft += x; },
      get scrollX() { return scrollEl.scrollLeft; },
      get scrollY() { return scrollEl.scrollTop; },
      get scrollWidth() { return scrollEl.scrollWidth; },
      get scrollHeight() { return scrollEl.scrollHeight; },
      get width() { return scrollEl.getBoundingClientRect().width; },
      get height() { return scrollEl.getBoundingClientRect().height; },
    };
  }
  return {
    scrollBy(x, y) { window.scrollBy(x, y); },
    get scrollX() { return window.scrollX; },
    get scrollY() { return window.scrollY; },
    get scrollWidth() { return document.body.scrollWidth; },
    get scrollHeight() { return document.body.scrollHeight; },
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

// --- Inject global styles (once) ---
let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .draggable-active::after {
      content: ""; display: block; position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      z-index: 9999; cursor: grabbing;
      user-select: none; -webkit-user-select: none;
    }
  `;
  document.head.appendChild(s);
}

// --- Draggable class ---

export class Draggable {
  constructor(container, opts = {}) {
    injectStyles();
    this.el = container;
    this.opts = { ...DEFAULTS, ...opts };
    this._transitionCSS = `transform ${this.opts.transitionMs}ms`;

    this._state = "idle";
    this._draggingEl = null;
    this._draggingBox = null;
    this._placeholder = null;
    this._items = [];
    this._indices = new Map();
    this._animating = new Set();
    this._startIndex = 0;
    this._currentIndex = 0;
    this._initialPointer = { x: 0, y: 0 };
    this._pointer = { x: 0, y: 0 };
    this._scrollTarget = null;
    this._scrollElement = null;
    this._scrolling = false;

    this._ac = new AbortController();
    const s = this._ac.signal;
    const on = (t, evt, fn, o) => t.addEventListener(evt, fn, { signal: s, ...o });

    on(this.el, "mousedown", this._onPointerDown.bind(this));
    on(this.el, "touchstart", this._onPointerDown.bind(this), { passive: false });
    on(window, "mousemove", this._onPointerMove.bind(this));
    on(window, "touchmove", this._onPointerMove.bind(this), { passive: false });
    on(window, "mouseup", this._onPointerUp.bind(this));
    on(window, "touchend", this._onPointerUp.bind(this));
    on(window, "selectstart", (e) => { if (this._state === "dragging") e.preventDefault(); });
    on(window, "dragstart", (e) => { if (this._state === "dragging") e.preventDefault(); });
  }

  destroy() { this._ac.abort(); }

  // --- Pointer down ---

  _onPointerDown(e) {
    if (this._state !== "idle") return;

    const item = e.target.closest(this.opts.items);
    if (!item || !this.el.contains(item)) return;
    if (this.opts.disabled?.(item)) return;
    if (this.opts.handle && item.hasAttribute("data-needs-handle")) {
      const handle = e.target.closest(this.opts.handle);
      if (!handle || !item.contains(handle)) return;
    }
    if (e.button !== undefined && e.button !== 0) return;

    if (e.type === "touchstart") {
      e.preventDefault();
      const target = e.target;
      setTimeout(() => {
        if (this._state !== "dragging") {
          target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        }
      }, this.opts.touchClickDelay);
    }

    this._state = "pending";
    this._draggingEl = item;
    this._initialPointer = pointerPos(e);
  }

  // --- Pointer move ---

  _onPointerMove(e) {
    if (this._state === "idle" || this._state === "dropping") return;

    const pos = pointerPos(e);
    this._pointer = pos;

    if (this._state === "pending") {
      const dx = pos.x - this._initialPointer.x;
      const dy = pos.y - this._initialPointer.y;
      if (Math.abs(dx) < this.opts.dragThreshold && Math.abs(dy) < this.opts.dragThreshold) return;
      this._startDrag();
    }

    if (this._state === "dragging") {
      e.preventDefault();
      const dx = pos.x - this._initialPointer.x;
      const dy = pos.y - this._initialPointer.y;
      this._draggingEl.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      this._startAutoScroll();
      requestAnimationFrame(() => this._updateCurrentIndex());
    }
  }

  // --- Start drag ---

  _startDrag() {
    this._state = "dragging";

    this._items = [...this.el.querySelectorAll(this.opts.items)];
    this._draggingBox = this._draggingEl.getBoundingClientRect();

    this._items.forEach((child, i) => this._indices.set(child, i));
    this._startIndex = this._items.indexOf(this._draggingEl);
    this._currentIndex = this._startIndex;

    this._scrollElement = findScrollable(this.el);
    this._scrollTarget = buildScrollTarget(this._scrollElement);

    this._placeholder = createPlaceholder(this._draggingEl);
    this._draggingEl.parentNode.insertBefore(this._placeholder, this._draggingEl);

    this._draggingEl.setAttribute("data-dragging", "");
    this.el.classList.add("draggable-active");
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    document.body.style.cursor = "grabbing";

    const b = this._draggingBox;
    Object.assign(this._draggingEl.style, {
      position: "fixed", zIndex: "10000",
      top: `${b.top}px`, left: `${b.left}px`,
      width: `${b.width}px`, height: `${b.height}px`,
      transition: "none", transform: "translate3d(0, 0, 0)",
    });
  }

  // --- Auto-scroll ---

  _startAutoScroll() {
    if (!this._scrollTarget || this._scrolling) return;
    const s = this._shouldScroll();
    if (s.up || s.right || s.down || s.left) {
      this._scrolling = true;
      requestAnimationFrame(() => this._scrollLoop());
    }
  }

  _scrollLoop() {
    if (this._state !== "dragging" || !this._scrolling) { this._scrolling = false; return; }
    requestAnimationFrame(() => this._scrollLoop());

    const s = this._shouldScroll();
    const st = this._scrollTarget;
    const d = this._edgeDistances();
    const t = this._scrollThreshold();

    if (s.up)    st.scrollBy(0, -Math.pow(2, (t.y - d.top) / 28));
    if (s.right)  st.scrollBy(Math.pow(2, (t.x - d.right) / 28), 0);
    if (s.down)   st.scrollBy(0, Math.pow(2, (t.y - d.bottom) / 28));
    if (s.left)   st.scrollBy(-Math.pow(2, (t.x - d.left) / 28), 0);

    this._updateCurrentIndex();
  }

  _edgeDistances() {
    const p = this._pointer;
    if (this._scrollElement) {
      const r = this._scrollElement.getBoundingClientRect();
      return { top: p.y - r.top, right: r.right - p.x, bottom: r.bottom - p.y, left: p.x - r.left };
    }
    return { top: p.y, right: window.innerWidth - p.x, bottom: window.innerHeight - p.y, left: p.x };
  }

  _scrollThreshold() {
    const max = this.opts.scrollThreshold;
    if (this._scrollElement) {
      const r = this._scrollElement.getBoundingClientRect();
      return { x: Math.min(r.width * 0.25, max), y: Math.min(r.height * 0.25, max) };
    }
    return { x: max, y: max };
  }

  _shouldScroll() {
    const d = this._edgeDistances();
    const st = this._scrollTarget;
    const t = this._scrollThreshold();
    return {
      up:    d.top < t.y && st.scrollY > 0,
      right: d.right < t.x && (st.scrollX + st.width) < st.scrollWidth,
      down:  d.bottom < t.y && (st.scrollY + st.height) < st.scrollHeight,
      left:  d.left < t.x && st.scrollX > 0,
    };
  }

  // --- Index tracking ---

  _updateCurrentIndex() {
    if (!this._draggingEl || this._state !== "dragging") return;

    const r = this._draggingEl.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    for (const child of this._items) {
      if (child === this._draggingEl) continue;
      if (this.opts.disabled?.(child)) continue;
      if (this._animating.has(child)) continue;

      const cr = child.getBoundingClientRect();
      if (cx > cr.left && cx < cr.right && cy > cr.top && cy < cr.bottom) {
        const idx = this._indices.get(child);
        if (idx !== this._currentIndex) {
          this._currentIndex = idx;
          this._repositionSiblings();
        }
      }
    }
  }

  // --- Sibling repositioning via placeholder + FLIP ---

  _repositionSiblings() {
    const newOrder = arrMove([...this._items], this._startIndex, this._currentIndex);

    // FIRST
    const firstRects = new Map();
    for (const child of this._items) {
      if (child !== this._draggingEl) firstRects.set(child, child.getBoundingClientRect());
    }

    // Move placeholder
    const dragIdx = newOrder.indexOf(this._draggingEl);
    let ref = null;
    for (let i = dragIdx + 1; i < newOrder.length; i++) {
      if (newOrder[i] !== this._draggingEl) { ref = newOrder[i]; break; }
    }
    this._placeholder.parentNode.insertBefore(this._placeholder, ref || null);

    // Update indices
    newOrder.forEach((child, i) => this._indices.set(child, i));

    // LAST + INVERT + PLAY
    const ms = this.opts.transitionMs;
    for (const child of this._items) {
      if (child === this._draggingEl) continue;

      const first = firstRects.get(child);
      const last = child.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;

      if (dx === 0 && dy === 0) {
        child.style.transition = "none";
        child.style.transform = "";
        continue;
      }

      child.style.transition = "none";
      child.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      child.getClientRects();
      child.style.transition = this._transitionCSS;
      child.style.transform = "none";

      this._animating.add(child);
      setTimeout(() => this._animating.delete(child), ms);
    }
  }

  // --- Drop ---

  _onPointerUp() {
    if (this._state === "pending") {
      this._state = "idle";
      this._draggingEl = null;
      return;
    }
    if (this._state !== "dragging") return;

    this._state = "dropping";
    this._scrolling = false;

    const target = this._placeholder.getBoundingClientRect();
    this._draggingEl.style.transition = this._transitionCSS;
    this._draggingEl.style.transform = `translate3d(${target.left - this._draggingBox.left}px, ${target.top - this._draggingBox.top}px, 0)`;

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;

      const from = this._startIndex;
      const to = this._currentIndex;

      this._placeholder?.remove();
      this._placeholder = null;

      for (const child of this._items) {
        for (const p of STYLE_PROPS) child.style[p] = "";
        child.removeAttribute("data-dragging");
      }

      this.el.classList.remove("draggable-active");
      document.body.style.userSelect = "";
      document.body.style.webkitUserSelect = "";
      document.body.style.cursor = "";

      this._draggingEl = null;
      this._state = "idle";
      this._indices.clear();
      this._animating.clear();

      if (from !== to && this.opts.onReorder) {
        requestAnimationFrame(() => this.opts.onReorder({ from, to }));
      }
    };

    this._draggingEl.addEventListener("transitionend", settle, { once: true });
    setTimeout(settle, this.opts.transitionMs + 50);
  }
}

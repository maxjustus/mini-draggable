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

// --- Utilities ---

function pointerPos(e) {
  if (e.touches) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  return { x: e.clientX, y: e.clientY };
}

function center(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function inRect(pt, el) {
  const r = el.getBoundingClientRect();
  return pt.x > r.left && pt.x < r.right && pt.y > r.top && pt.y < r.bottom;
}

function arrMove(arr, from, to) {
  const el = arr.splice(from, 1)[0];
  arr.splice(to, 0, el);
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
      el: scrollEl,
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
    el: null,
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

    this._state = "idle"; // idle | pending | dragging | dropping
    this._draggingEl = null;
    this._draggingBox = null;
    this._placeholder = null;
    this._items = [];
    this._indices = new Map();  // element -> current virtual index
    this._animating = new Set();
    this._startIndex = 0;
    this._currentIndex = 0;
    this._initialPointer = { x: 0, y: 0 };
    this._pointer = { x: 0, y: 0 };
    this._scrollTarget = null;
    this._scrollElement = null;
    this._scrolling = false;

    // Bind methods for event listeners
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._preventDuringDrag = this._preventDuringDrag.bind(this);

    this.el.addEventListener("mousedown", this._onPointerDown);
    this.el.addEventListener("touchstart", this._onPointerDown, { passive: false });
    window.addEventListener("mousemove", this._onPointerMove);
    window.addEventListener("touchmove", this._onPointerMove, { passive: false });
    window.addEventListener("mouseup", this._onPointerUp);
    window.addEventListener("touchend", this._onPointerUp);
    window.addEventListener("selectstart", this._preventDuringDrag);
    window.addEventListener("dragstart", this._preventDuringDrag);
  }

  destroy() {
    this.el.removeEventListener("mousedown", this._onPointerDown);
    this.el.removeEventListener("touchstart", this._onPointerDown);
    window.removeEventListener("mousemove", this._onPointerMove);
    window.removeEventListener("touchmove", this._onPointerMove);
    window.removeEventListener("mouseup", this._onPointerUp);
    window.removeEventListener("touchend", this._onPointerUp);
    window.removeEventListener("selectstart", this._preventDuringDrag);
    window.removeEventListener("dragstart", this._preventDuringDrag);
  }

  // --- Query helpers ---

  _queryItems() {
    return [...this.el.querySelectorAll(this.opts.items)].filter(
      (child) => this.el.contains(child)
    );
  }

  _isDisabled(item) {
    if (typeof this.opts.disabled === "function") return this.opts.disabled(item);
    if (typeof this.opts.disabled === "string") return item.matches(this.opts.disabled);
    return false;
  }

  _needsHandle(item) {
    return this.opts.handle && item.hasAttribute("data-needs-handle");
  }

  _isHandleClick(e, item) {
    if (!this.opts.handle) return true;
    return e.target.closest(this.opts.handle) && item.contains(e.target.closest(this.opts.handle));
  }

  // --- Pointer down ---

  _onPointerDown(e) {
    if (this._state !== "idle") return;

    const item = e.target.closest(this.opts.items);
    if (!item || !this.el.contains(item)) return;
    if (this._isDisabled(item)) return;
    if (this._needsHandle(item) && !this._isHandleClick(e, item)) return;
    if (e.button !== undefined && e.button !== 0) return;

    if (e.type === "touchstart") {
      e.preventDefault();
      const target = e.target;
      setTimeout(() => {
        if (this._state !== "dragging") {
          target.dispatchEvent(new MouseEvent("click", {
            bubbles: true, cancelable: true, view: window,
          }));
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

    this._items = this._queryItems();
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

    const box = this._draggingBox;
    Object.assign(this._draggingEl.style, {
      position: "fixed",
      zIndex: "10000",
      top: `${box.top}px`,
      left: `${box.left}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      transition: "none",
      transform: "translate3d(0, 0, 0)",
    });
  }

  // --- Auto-scroll ---

  _startAutoScroll() {
    if (!this._scrollTarget || this._scrolling) return;
    const should = this._shouldScroll();
    if (should.up || should.right || should.down || should.left) {
      this._scrolling = true;
      requestAnimationFrame(() => this._scrollLoop());
    }
  }

  _scrollLoop() {
    if (this._state !== "dragging" || !this._scrolling) {
      this._scrolling = false;
      return;
    }
    requestAnimationFrame(() => this._scrollLoop());

    const should = this._shouldScroll();
    const st = this._scrollTarget;
    const dist = this._edgeDistances();
    const thresh = this._scrollThreshold();

    if (should.up)    st.scrollBy(0, -Math.pow(2, (thresh.y - dist.top) / 28));
    if (should.right)  st.scrollBy(Math.pow(2, (thresh.x - dist.right) / 28), 0);
    if (should.down)   st.scrollBy(0, Math.pow(2, (thresh.y - dist.bottom) / 28));
    if (should.left)   st.scrollBy(-Math.pow(2, (thresh.x - dist.left) / 28), 0);

    this._updateCurrentIndex();
  }

  _edgeDistances() {
    const pos = this._pointer;
    if (this._scrollElement) {
      const r = this._scrollElement.getBoundingClientRect();
      return { top: pos.y - r.top, right: r.right - pos.x, bottom: r.bottom - pos.y, left: pos.x - r.left };
    }
    return { top: pos.y, right: window.innerWidth - pos.x, bottom: window.innerHeight - pos.y, left: pos.x };
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
    const thresh = this._scrollThreshold();
    return {
      up:    d.top < thresh.y && st.scrollY > 0,
      right: d.right < thresh.x && (st.scrollX + st.width) < st.scrollWidth,
      down:  d.bottom < thresh.y && (st.scrollY + st.height) < st.scrollHeight,
      left:  d.left < thresh.x && st.scrollX > 0,
    };
  }

  // --- Index tracking ---

  _updateCurrentIndex() {
    if (!this._draggingEl || this._state !== "dragging") return;

    const c = center(this._draggingEl);

    for (const child of this._items) {
      if (child === this._draggingEl) continue;
      if (this._isDisabled(child)) continue;
      if (this._animating.has(child)) continue;

      if (inRect(c, child)) {
        const newIndex = this._indices.get(child);
        if (newIndex !== this._currentIndex) {
          this._currentIndex = newIndex;
          this._repositionSiblings();
        }
      }
    }
  }

  // --- Sibling repositioning via placeholder + FLIP ---

  _repositionSiblings() {
    const newOrder = arrMove([...this._items], this._startIndex, this._currentIndex);
    const ms = this.opts.transitionMs;

    // FIRST
    const firstRects = new Map();
    for (const child of this._items) {
      if (child !== this._draggingEl) {
        firstRects.set(child, child.getBoundingClientRect());
      }
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
      child.getClientRects(); // force recalc
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
    const dropDx = target.left - this._draggingBox.left;
    const dropDy = target.top - this._draggingBox.top;

    this._draggingEl.style.transition = this._transitionCSS;
    this._draggingEl.style.transform = `translate3d(${dropDx}px, ${dropDy}px, 0)`;

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;

      const from = this._startIndex;
      const to = this._currentIndex;

      if (this._placeholder?.parentNode) this._placeholder.remove();
      this._placeholder = null;

      for (const child of this._items) {
        child.style.transform = "";
        child.style.transition = "";
        child.style.position = "";
        child.style.zIndex = "";
        child.style.top = "";
        child.style.left = "";
        child.style.width = "";
        child.style.height = "";
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
        this.opts.onReorder({ from, to });
      }
    };

    this._draggingEl.addEventListener("transitionend", settle, { once: true });
    setTimeout(settle, this.opts.transitionMs + 50);
  }

  _preventDuringDrag(e) {
    if (this._state === "dragging") e.preventDefault();
  }
}

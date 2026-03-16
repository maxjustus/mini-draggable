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
    this.transitionCSS = `transform ${this.opts.transitionMs}ms`;

    this.state = "idle";
    this.draggingEl = null;
    this.draggingBox = null;
    this.placeholder = null;
    this.items = [];
    this.indices = new Map();
    this.animating = new Set();
    this.startIndex = 0;
    this.currentIndex = 0;
    this.initialPointer = { x: 0, y: 0 };
    this.pointer = { x: 0, y: 0 };
    this.scrollTarget = null;
    this.scrollElement = null;
    this.scrolling = false;

    this.ac = new AbortController();
    const s = this.ac.signal;
    const on = (t, evt, fn, o) => t.addEventListener(evt, fn, { signal: s, ...o });

    on(this.el, "mousedown", this.onPointerDown.bind(this));
    on(this.el, "touchstart", this.onPointerDown.bind(this), { passive: false });
    on(window, "mousemove", this.onPointerMove.bind(this));
    on(window, "touchmove", this.onPointerMove.bind(this), { passive: false });
    on(window, "mouseup", this.onPointerUp.bind(this));
    on(window, "touchend", this.onPointerUp.bind(this));
    on(window, "selectstart", (e) => { if (this.state === "dragging") e.preventDefault(); });
    on(window, "dragstart", (e) => { if (this.state === "dragging") e.preventDefault(); });
  }

  destroy() { this.ac.abort(); }

  // --- Pointer down ---

  onPointerDown(e) {
    if (this.state !== "idle") return;

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
      this.emitTouchClick(e);
    }

    this.state = "pending";
    this.draggingEl = item;
    this.initialPointer = pointerPos(e);
  }

  emitTouchClick(e) {
    const target = e.target;
    setTimeout(() => {
      if (this.state !== "dragging") {
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
    }, this.opts.touchClickDelay);
  }

  // --- Pointer move ---

  onPointerMove(e) {
    if (this.state === "idle" || this.state === "dropping") return;

    const pos = pointerPos(e);
    this.pointer = pos;

    if (this.state === "pending") {
      const dx = pos.x - this.initialPointer.x;
      const dy = pos.y - this.initialPointer.y;
      if (Math.abs(dx) < this.opts.dragThreshold && Math.abs(dy) < this.opts.dragThreshold) return;
      this.startDrag();
    }

    if (this.state === "dragging") {
      e.preventDefault();
      const dx = pos.x - this.initialPointer.x;
      const dy = pos.y - this.initialPointer.y;
      this.draggingEl.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      this.startAutoScroll();
      requestAnimationFrame(() => this.updateCurrentIndex());
    }
  }

  // --- Start drag ---

  startDrag() {
    this.state = "dragging";
    this.draggingBox = this.draggingEl.getBoundingClientRect();
    this.collectItems();
    this.initScroll();
    this.insertPlaceholder();
    this.liftDraggingElement();
  }

  collectItems() {
    this.items = [...this.el.querySelectorAll(this.opts.items)];
    this.items.forEach((child, i) => this.indices.set(child, i));
    this.startIndex = this.items.indexOf(this.draggingEl);
    this.currentIndex = this.startIndex;
  }

  initScroll() {
    this.scrollElement = findScrollable(this.el);
    this.scrollTarget = buildScrollTarget(this.scrollElement);
  }

  insertPlaceholder() {
    this.placeholder = createPlaceholder(this.draggingEl);
    this.draggingEl.parentNode.insertBefore(this.placeholder, this.draggingEl);

    this.draggingEl.setAttribute("data-dragging", "");
    this.el.classList.add("draggable-active");
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    document.body.style.cursor = "grabbing";
  }

  liftDraggingElement() {
    const b = this.draggingBox;
    Object.assign(this.draggingEl.style, {
      position: "fixed", zIndex: "10000",
      top: `${b.top}px`, left: `${b.left}px`,
      width: `${b.width}px`, height: `${b.height}px`,
      transition: "none", transform: "translate3d(0, 0, 0)",
    });
  }

  // --- Auto-scroll ---

  startAutoScroll() {
    if (!this.scrollTarget || this.scrolling) return;
    const s = this.shouldScroll();
    if (s.up || s.right || s.down || s.left) {
      this.scrolling = true;
      requestAnimationFrame(() => this.scrollLoop());
    }
  }

  scrollLoop() {
    if (this.state !== "dragging" || !this.scrolling) { this.scrolling = false; return; }
    requestAnimationFrame(() => this.scrollLoop());

    const s = this.shouldScroll();
    const st = this.scrollTarget;
    const d = this.edgeDistances();
    const t = this.scrollThresholds();

    if (s.up)    st.scrollBy(0, -Math.pow(2, (t.y - d.top) / 28));
    if (s.right)  st.scrollBy(Math.pow(2, (t.x - d.right) / 28), 0);
    if (s.down)   st.scrollBy(0, Math.pow(2, (t.y - d.bottom) / 28));
    if (s.left)   st.scrollBy(-Math.pow(2, (t.x - d.left) / 28), 0);

    this.updateCurrentIndex();
  }

  edgeDistances() {
    const p = this.pointer;
    if (this.scrollElement) {
      const r = this.scrollElement.getBoundingClientRect();
      return { top: p.y - r.top, right: r.right - p.x, bottom: r.bottom - p.y, left: p.x - r.left };
    }
    return { top: p.y, right: window.innerWidth - p.x, bottom: window.innerHeight - p.y, left: p.x };
  }

  scrollThresholds() {
    const max = this.opts.scrollThreshold;
    if (this.scrollElement) {
      const r = this.scrollElement.getBoundingClientRect();
      return { x: Math.min(r.width * 0.25, max), y: Math.min(r.height * 0.25, max) };
    }
    return { x: max, y: max };
  }

  shouldScroll() {
    const d = this.edgeDistances();
    const st = this.scrollTarget;
    const t = this.scrollThresholds();
    return {
      up:    d.top < t.y && st.scrollY > 0,
      right: d.right < t.x && (st.scrollX + st.width) < st.scrollWidth,
      down:  d.bottom < t.y && (st.scrollY + st.height) < st.scrollHeight,
      left:  d.left < t.x && st.scrollX > 0,
    };
  }

  // --- Index tracking ---

  updateCurrentIndex() {
    if (!this.draggingEl || this.state !== "dragging") return;

    const r = this.draggingEl.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    for (const child of this.items) {
      if (child === this.draggingEl) continue;
      if (this.opts.disabled?.(child)) continue;
      if (this.animating.has(child)) continue;

      const cr = child.getBoundingClientRect();
      if (cx > cr.left && cx < cr.right && cy > cr.top && cy < cr.bottom) {
        const idx = this.indices.get(child);
        if (idx !== this.currentIndex) {
          this.currentIndex = idx;
          this.repositionSiblings();
        }
      }
    }
  }

  // --- Sibling repositioning via placeholder + FLIP ---

  repositionSiblings() {
    const newOrder = arrMove([...this.items], this.startIndex, this.currentIndex);
    const firstRects = this.captureRects();
    this.movePlaceholder(newOrder);
    newOrder.forEach((child, i) => this.indices.set(child, i));
    this.flipAnimate(firstRects);
  }

  captureRects() {
    const rects = new Map();
    for (const child of this.items) {
      if (child !== this.draggingEl) rects.set(child, child.getBoundingClientRect());
    }
    return rects;
  }

  movePlaceholder(newOrder) {
    const dragIdx = newOrder.indexOf(this.draggingEl);
    let ref = null;
    for (let i = dragIdx + 1; i < newOrder.length; i++) {
      if (newOrder[i] !== this.draggingEl) { ref = newOrder[i]; break; }
    }
    this.placeholder.parentNode.insertBefore(this.placeholder, ref || null);
  }

  flipAnimate(firstRects) {
    const ms = this.opts.transitionMs;
    for (const child of this.items) {
      if (child === this.draggingEl) continue;

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
      child.style.transition = this.transitionCSS;
      child.style.transform = "none";

      this.animating.add(child);
      setTimeout(() => this.animating.delete(child), ms);
    }
  }

  // --- Drop ---

  onPointerUp() {
    if (this.state === "pending") {
      this.state = "idle";
      this.draggingEl = null;
      return;
    }
    if (this.state !== "dragging") return;

    this.state = "dropping";
    this.scrolling = false;
    this.animateDropToPlaceholder();
  }

  animateDropToPlaceholder() {
    const target = this.placeholder.getBoundingClientRect();
    this.draggingEl.style.transition = this.transitionCSS;
    this.draggingEl.style.transform = `translate3d(${target.left - this.draggingBox.left}px, ${target.top - this.draggingBox.top}px, 0)`;

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      this.settle();
    };

    this.draggingEl.addEventListener("transitionend", settle, { once: true });
    setTimeout(settle, this.opts.transitionMs + 50);
  }

  settle() {
    const from = this.startIndex;
    const to = this.currentIndex;

    this.placeholder?.remove();
    this.placeholder = null;

    for (const child of this.items) {
      for (const p of STYLE_PROPS) child.style[p] = "";
      child.removeAttribute("data-dragging");
    }

    this.el.classList.remove("draggable-active");
    document.body.style.userSelect = "";
    document.body.style.webkitUserSelect = "";
    document.body.style.cursor = "";

    this.draggingEl = null;
    this.state = "idle";
    this.indices.clear();
    this.animating.clear();

    if (from !== to && this.opts.onReorder) {
      requestAnimationFrame(() => this.opts.onReorder({ from, to }));
    }
  }
}

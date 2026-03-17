// Vanilla JS drag-to-reorder library.
// Uses placeholder + FLIP for correct positioning in any layout
// (lists, grids, flex, variable heights).
//
// Supports cross-container transfer via the `group` option.
//
// Usage:
//   import { Draggable } from './draggable.js';
//   const d = new Draggable(container, {
//     items: '[data-draggable]',
//     handle: '[data-draggable-handle]',
//     disabled: (el) => el.hasAttribute('data-drag-disabled'),
//     group: 'board',
//     onReorder({ from, to }) { ... },
//     onTransfer({ from, to, el, sourceContainer, targetContainer }) { ... },
//   });
//   d.destroy();

const DEFAULTS = {
  items: "[data-draggable]",
  handle: null,
  disabled: null,
  onReorder: null,
  onTransfer: null,
  group: null,
  transitionMs: 150,
  dragThreshold: 5,
  touchClickDelay: 100,
  scrollThreshold: 150,
};

const STYLE_PROPS = ["transform", "transition", "position", "zIndex", "top", "left", "width", "height"];
const groups = new Map();

// --- Utilities ---

function pointerPos(e) {
  if (e.touches) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  return { x: e.clientX, y: e.clientY };
}

function arrMove(arr, from, to) {
  arr.splice(to, 0, arr.splice(from, 1)[0]);
  return arr;
}

function hitTest(x, y, el) {
  const r = el.getBoundingClientRect();
  return x > r.left && x < r.right && y > r.top && y < r.bottom;
}

function captureRects(items) {
  const rects = new Map();
  for (const child of items) rects.set(child, child.getBoundingClientRect());
  return rects;
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
    "pointer-events:none",
  ].join(";");
  ph.textContent = "";
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

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    [data-drag-placeholder] {
      background: rgba(0, 0, 0, 0.05);
      border: 2px dashed rgba(0, 0, 0, 0.15);
      border-radius: 4px;
    }
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
    this.meta = {};
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
    this.sourceContainer = null;
    this.sourceIndex = 0;
    this.activeContainer = null;

    if (this.opts.group) {
      if (!groups.has(this.opts.group)) groups.set(this.opts.group, new Set());
      groups.get(this.opts.group).add(this);
    }

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

  destroy() {
    this.ac.abort();
    if (this.opts.group) groups.get(this.opts.group)?.delete(this);
  }

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
      const target = e.target;
      setTimeout(() => {
        if (this.state !== "dragging") {
          target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        }
      }, this.opts.touchClickDelay);
    }

    this.state = "pending";
    this.draggingEl = item;
    this.initialPointer = pointerPos(e);
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
    this.sourceContainer = this;
    this.sourceIndex = this.startIndex;
    this.activeContainer = this;
    this.initScroll();
    this.insertPlaceholder();
    this.liftDraggingElement();

    this.draggingEl.setAttribute("data-dragging", "");
    this.el.classList.add("draggable-active");
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    document.body.style.cursor = "grabbing";
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

    const d = this.edgeDistances();
    const t = this.scrollThresholds();
    const st = this.scrollTarget;

    if (d.top < t.y && st.scrollY > 0)
      st.scrollBy(0, -Math.pow(2, (t.y - d.top) / 28));
    if (d.right < t.x && (st.scrollX + st.width) < st.scrollWidth)
      st.scrollBy(Math.pow(2, (t.x - d.right) / 28), 0);
    if (d.bottom < t.y && (st.scrollY + st.height) < st.scrollHeight)
      st.scrollBy(0, Math.pow(2, (t.y - d.bottom) / 28));
    if (d.left < t.x && st.scrollX > 0)
      st.scrollBy(-Math.pow(2, (t.x - d.left) / 28), 0);

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
      if (this.activeContainer.opts.disabled?.(child)) continue;
      if (this.animating.has(child)) continue;

      if (hitTest(cx, cy, child)) {
        const idx = this.indices.get(child);
        if (idx !== this.currentIndex) {
          this.currentIndex = idx;
          this.repositionSiblings();
        }
        return;
      }
    }

    if (this.opts.group) this.checkContainerTransfer(cx, cy);
  }

  // --- Cross-container transfer ---

  checkContainerTransfer(cx, cy) {
    if (hitTest(cx, cy, this.activeContainer.el)) return;

    for (const other of groups.get(this.opts.group)) {
      if (other === this.activeContainer) continue;
      if (hitTest(cx, cy, other.el)) {
        this.transferToContainer(other, cy);
        return;
      }
    }
  }

  transferToContainer(target, cy) {
    const oldContainer = this.activeContainer;
    const siblings = this.items.filter(el => el !== this.draggingEl);
    const targetItems = [...target.el.querySelectorAll(target.opts.items)]
      .filter(el => el !== this.draggingEl);

    // FIRST: capture item rects + container heights
    const oldRects = captureRects(siblings);
    const targetRects = captureRects(targetItems);
    const oldContainerHeight = oldContainer.el.getBoundingClientRect().height;
    const targetContainerHeight = target.el.getBoundingClientRect().height;

    // Move placeholder between containers
    this.placeholder.remove();
    oldContainer.el.classList.remove("draggable-active");

    const insertIdx = this.computeInsertionIndex(targetItems, cy);
    if (insertIdx >= targetItems.length) {
      target.el.appendChild(this.placeholder);
    } else {
      target.el.insertBefore(this.placeholder, targetItems[insertIdx]);
    }
    target.el.classList.add("draggable-active");

    // Rebuild tracking
    this.items = [...target.el.querySelectorAll(target.opts.items)]
      .filter(el => el !== this.draggingEl);
    this.items.splice(insertIdx, 0, this.draggingEl);
    this.indices.clear();
    this.items.forEach((child, i) => this.indices.set(child, i));
    this.startIndex = insertIdx;
    this.currentIndex = insertIdx;
    this.activeContainer = target;

    // FLIP animate items
    this.flipAnimate(siblings, oldRects);
    this.flipAnimate(targetItems, targetRects);

    // FLIP animate container heights
    this.flipContainerHeight(oldContainer.el, oldContainerHeight);
    this.flipContainerHeight(target.el, targetContainerHeight);
  }

  computeInsertionIndex(items, cy) {
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (cy < r.top + r.height / 2) return i;
    }
    return items.length;
  }

  // --- Sibling repositioning via placeholder + FLIP ---

  repositionSiblings() {
    const newOrder = arrMove([...this.items], this.startIndex, this.currentIndex);
    const siblings = this.items.filter(c => c !== this.draggingEl);
    const firstRects = captureRects(siblings);
    this.movePlaceholder(newOrder);
    newOrder.forEach((child, i) => this.indices.set(child, i));
    this.flipAnimate(siblings, firstRects);
  }

  movePlaceholder(newOrder) {
    const dragIdx = newOrder.indexOf(this.draggingEl);
    let ref = null;
    for (let i = dragIdx + 1; i < newOrder.length; i++) {
      if (newOrder[i] !== this.draggingEl) { ref = newOrder[i]; break; }
    }
    this.placeholder.parentNode.insertBefore(this.placeholder, ref || null);
  }

  flipAnimate(items, firstRects) {
    const ms = this.opts.transitionMs;
    for (const child of items) {
      const first = firstRects.get(child);
      if (!first) continue;
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

  flipContainerHeight(container, firstHeight) {
    const lastHeight = container.getBoundingClientRect().height;
    if (firstHeight === lastHeight) return;

    container.style.height = `${firstHeight}px`;
    container.style.transition = "none";
    container.getClientRects();
    container.style.transition = `height ${this.opts.transitionMs}ms`;
    container.style.height = `${lastHeight}px`;

    const cleanup = () => {
      container.style.height = "";
      container.style.transition = "";
    };
    container.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, this.opts.transitionMs + 50);
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
    const crossContainer = this.activeContainer !== this.sourceContainer;
    const from = crossContainer ? this.sourceIndex : this.startIndex;
    const to = this.currentIndex;

    this.placeholder?.remove();
    this.placeholder = null;

    for (const child of this.items) {
      for (const p of STYLE_PROPS) child.style[p] = "";
      child.removeAttribute("data-dragging");
    }

    this.activeContainer.el.classList.remove("draggable-active");
    this.el.classList.remove("draggable-active");
    document.body.style.userSelect = "";
    document.body.style.webkitUserSelect = "";
    document.body.style.cursor = "";

    const dragged = this.draggingEl;
    this.draggingEl = null;
    this.state = "idle";
    this.indices.clear();
    this.animating.clear();

    if (crossContainer && this.opts.onTransfer) {
      const sc = this.sourceContainer;
      const tc = this.activeContainer;
      requestAnimationFrame(() => this.opts.onTransfer({
        from, to, el: dragged, sourceContainer: sc, targetContainer: tc,
      }));
    } else if (!crossContainer && from !== to && this.opts.onReorder) {
      requestAnimationFrame(() => this.opts.onReorder({ from, to }));
    }

    this.repaintContainer(this.el);
    if (crossContainer) this.repaintContainer(this.activeContainer.el);
  }

  // Workaround: Safari can desync hit-test coordinates from visual
  // positions after scroll + transform. Toggling will-change forces
  // a compositing layer rebuild.
  repaintContainer(container) {
    const items = container.querySelectorAll(this.opts.items);
    for (const child of items) child.style.willChange = "transform";
    requestAnimationFrame(() => {
      for (const child of items) child.style.willChange = "";
    });
  }
}

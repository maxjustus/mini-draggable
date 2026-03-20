// Vanilla JS drag-to-reorder library.
// Uses placeholder + FLIP for correct positioning in any layout
// (lists, grids, flex, variable heights).
//
// Supports cross-container transfer via the `group` option.
//
// Usage:
//   import { sortable } from 'mini-sortable';
//   const s = sortable(container, {
//     items: '[data-sortable]',
//     handle: '[data-sortable-handle]',
//     group: 'board',
//     onReorder({ from, to }) { ... },
//     onTransfer({ from, to, el, sourceContainer, targetContainer }) { ... },
//   });
//   s.destroy();

export type Point = { x: number; y: number };
export type ReorderEvent = { from: number; to: number };

export type TransferEvent = {
  from: number;
  to: number;
  el: HTMLElement;
  sourceContainer: SortableInstance;
  targetContainer: SortableInstance;
};

export type ScrollTarget = {
  scrollBy: (x: number, y: number) => void;
  scrollX: number;
  scrollY: number;
  scrollWidth: number;
  scrollHeight: number;
  width: number;
  height: number;
};

export type SortableOptions = {
  items?: string;
  handle?: string | null;
  disabled?: ((el: HTMLElement) => boolean) | null;
  onReorder?: ((event: ReorderEvent) => void) | null;
  onTransfer?: ((event: TransferEvent) => void) | null;
  group?: string | null;
  dragThreshold?: number;
  touchClickDelay?: number;
  scrollThreshold?: number;
};

export type ResolvedOptions = Required<SortableOptions>;

export type SortableInstance = {
  el: HTMLElement;
  opts: ResolvedOptions;
  destroy: () => void;
};

type AutoScrollerConfig = {
  scrollEl: HTMLElement | null;
  target: ScrollTarget;
  threshold: number;
  getPointer: () => Point;
  isActive: () => boolean;
  onTick: () => void;
};

type EdgeDistances = { top: number; right: number; bottom: number; left: number };

const DEFAULTS: ResolvedOptions = {
  items: "[data-sortable]",
  handle: null,
  disabled: (el) => el.hasAttribute("data-drag-disabled"),
  onReorder: null,
  onTransfer: null,
  group: null,
  dragThreshold: 5,
  touchClickDelay: 100,
  scrollThreshold: 150,
};

const LAYOUT_PROPS = [
  "width", "height", "minWidth", "minHeight",
  "margin", "padding", "boxSizing",
  "gridColumn", "gridRow", "gridArea",
  "flexGrow", "flexShrink", "flexBasis", "alignSelf",
] as const;

const MANAGED_STYLE_PROPS = [
  "transform", "transition", "position", "zIndex",
  "top", "left", "width", "height",
] as const;

const groups = new Map<string, Set<SortableInstance>>();
const initialized = new WeakSet<HTMLElement>();

function pointerPos(event: MouseEvent | TouchEvent): Point {
  if ("touches" in event) {
    return { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }
  return { x: event.clientX, y: event.clientY };
}

export function arrMove<T>(arr: T[], from: number, to: number): T[] {
  arr.splice(to, 0, arr.splice(from, 1)[0]);
  return arr;
}

function hitTest(x: number, y: number, el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom;
}

function captureRects(items: HTMLElement[]) {
  return new Map(items.map((el) => [el, el.getBoundingClientRect()] as const));
}

function cssTransitionMs(el: HTMLElement) {
  const raw = getComputedStyle(el).transitionDuration;
  return raw ? parseFloat(raw) * 1000 : 0;
}

function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el;
  while (node) {
    if (/scroll|auto/.test(getComputedStyle(node).overflow)) return node;
    node = node.parentElement;
  }
  return null;
}

function buildScrollTarget(el: HTMLElement | null): ScrollTarget {
  if (el) {
    return {
      scrollBy(x, y) { el.scrollTop += y; el.scrollLeft += x; },
      get scrollX() { return el.scrollLeft; },
      get scrollY() { return el.scrollTop; },
      get scrollWidth() { return el.scrollWidth; },
      get scrollHeight() { return el.scrollHeight; },
      get width() { return el.getBoundingClientRect().width; },
      get height() { return el.getBoundingClientRect().height; },
    };
  }

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

function createPlaceholder(source: HTMLElement) {
  const ph = document.createElement(source.tagName) as HTMLElement;
  ph.className = source.className;
  ph.setAttribute("data-drag-placeholder", "");
  ph.textContent = "";

  const computed = getComputedStyle(source);
  for (const prop of LAYOUT_PROPS) ph.style[prop] = computed[prop];
  ph.style.pointerEvents = "none";

  return ph;
}

/**
 * FLIP-animate items from their old positions to their new positions.
 * Items are added to `animating` during the transition to suppress hit-testing.
 */
function flip(items: HTMLElement[], beforeRects: Map<HTMLElement, DOMRect>, animating: Set<HTMLElement>) {
  for (const child of items) {
    const first = beforeRects.get(child);
    if (!first) continue;

    const last = child.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (dx === 0 && dy === 0) continue;

    child.style.transition = "none";
    child.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    child.getClientRects(); // force reflow
    child.style.transition = "";
    child.style.transform = "none";

    animating.add(child);
    const done = () => animating.delete(child);
    child.addEventListener("transitionend", done, { once: true });
    setTimeout(done, cssTransitionMs(child));
  }
}

function flipHeight(container: HTMLElement, firstHeight: number) {
  const lastHeight = container.getBoundingClientRect().height;
  if (firstHeight === lastHeight) return;

  container.style.height = `${firstHeight}px`;
  container.style.transition = "none";
  container.getClientRects();
  container.style.transition = "";
  container.style.height = `${lastHeight}px`;

  const cleanup = () => { container.style.height = ""; container.style.transition = ""; };
  container.addEventListener("transitionend", cleanup, { once: true });
  setTimeout(cleanup, cssTransitionMs(container));
}

function liftElement(el: HTMLElement, box: DOMRect) {
  el.style.position = "fixed";
  el.style.zIndex = "10000";
  el.style.top = `${box.top}px`;
  el.style.left = `${box.left}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
  el.style.transition = "none";
  el.style.transform = "translate3d(0, 0, 0)";
}

function createAutoScroller({ scrollEl, target: st, threshold, getPointer, isActive, onTick }: AutoScrollerConfig) {
  let scrolling = false;

  function edgeDist(p: Point): EdgeDistances {
    if (scrollEl) {
      const r = scrollEl.getBoundingClientRect();
      return { top: p.y - r.top, right: r.right - p.x, bottom: r.bottom - p.y, left: p.x - r.left };
    }
    return { top: p.y, right: innerWidth - p.x, bottom: innerHeight - p.y, left: p.x };
  }

  function thresh() {
    if (scrollEl) {
      const r = scrollEl.getBoundingClientRect();
      return { x: Math.min(r.width * 0.25, threshold), y: Math.min(r.height * 0.25, threshold) };
    }
    return { x: threshold, y: threshold };
  }

  function shouldScroll(d: EdgeDistances, t: { x: number; y: number }) {
    return (d.top < t.y && st.scrollY > 0)
      || (d.right < t.x && st.scrollX + st.width < st.scrollWidth)
      || (d.bottom < t.y && st.scrollY + st.height < st.scrollHeight)
      || (d.left < t.x && st.scrollX > 0);
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

function insertPlaceholderAt(placeholder: HTMLElement, container: HTMLElement, items: HTMLElement[], cy: number) {
  const found = items.findIndex((child) => {
    const r = child.getBoundingClientRect();
    return cy < r.top + r.height / 2;
  });
  const idx = found === -1 ? items.length : found;
  if (idx >= items.length) container.appendChild(placeholder);
  else container.insertBefore(placeholder, items[idx]);
  return idx;
}

function queryItems(container: HTMLElement, selector: string, exclude?: HTMLElement) {
  const items = [...container.querySelectorAll(selector)] as HTMLElement[];
  return exclude ? items.filter((c) => c !== exclude) : items;
}

function validateDragTarget(event: MouseEvent | TouchEvent, container: HTMLElement, opts: ResolvedOptions): HTMLElement | null {
  const target = event.target as HTMLElement;
  const item = target.closest(opts.items) as HTMLElement | null;
  if (!item || !container.contains(item)) return null;
  if (opts.disabled?.(item)) return null;
  if (opts.handle && item.querySelector(opts.handle)) {
    const handle = target.closest(opts.handle);
    if (!handle || !item.contains(handle)) return null;
  }
  if ("button" in event && event.button !== 0) return null;
  return item;
}

/**
 * Short-lived drag session. Created when the drag threshold is crossed,
 * discarded after the drop animation settles.
 */
class DragSession {
  initialRect: DOMRect;
  placeholder: HTMLElement;
  animating = new Set<HTMLElement>();
  items: HTMLElement[];
  originalIndex: number;
  draggedIndex: number;
  currentIndex: number;
  pointer: Point;
  currentContainer: SortableInstance;
  dropping = false;
  indexDirty = false;
  visualOrder = new Map<HTMLElement, number>();
  exclusionZone: DOMRect | null = null;
  scroller: { start: () => void };

  constructor(
    public inst: SortableInstance,
    public el: HTMLElement,
    public initialPos: Point,
  ) {
    this.initialRect = el.getBoundingClientRect();
    this.placeholder = createPlaceholder(el);
    this.items = queryItems(inst.el, inst.opts.items);
    this.originalIndex = this.items.indexOf(el);
    this.draggedIndex = this.originalIndex;
    this.currentIndex = this.originalIndex;
    this.pointer = initialPos;
    this.currentContainer = inst;

    // Build visual order map
    this.items.forEach((child, i) => this.visualOrder.set(child, i));

    // Insert placeholder and lift element
    el.parentNode!.insertBefore(this.placeholder, el);
    liftElement(el, this.initialRect);

    // Activate drag state
    el.setAttribute("data-dragging", "");
    inst.el.classList.add("sortable-active");
    document.body.style.userSelect = "none";
    (document.body.style as any).webkitUserSelect = "none";
    document.body.style.cursor = "grabbing";

    const scrollEl = findScrollParent(inst.el);
    this.scroller = createAutoScroller({
      scrollEl,
      target: buildScrollTarget(scrollEl),
      threshold: inst.opts.scrollThreshold,
      getPointer: () => this.pointer,
      isActive: () => !this.dropping,
      onTick: () => this.scheduleUpdate(),
    });
  }

  /** Debounce index updates to one per animation frame. */
  scheduleUpdate() {
    if (this.indexDirty) return;
    this.indexDirty = true;
    requestAnimationFrame(() => {
      this.indexDirty = false;
      this.scroller.start();
      this.updateIndex();
    });
  }

  move(pos: Point) {
    if (this.dropping) return;
    this.pointer = pos;
    this.el.style.transform = `translate3d(${pos.x - this.initialPos.x}px, ${pos.y - this.initialPos.y}px, 0)`;
    this.scheduleUpdate();
  }

  /** Returns true if the dragged center is still inside the last swap's exclusion zone. */
  isInExclusionZone(cx: number, cy: number) {
    if (!this.exclusionZone) return false;
    if (cx > this.exclusionZone.left && cx < this.exclusionZone.right &&
        cy > this.exclusionZone.top && cy < this.exclusionZone.bottom) return true;
    this.exclusionZone = null;
    return false;
  }

  updateIndex() {
    if (this.dropping) return;

    const rect = this.el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    if (this.isInExclusionZone(cx, cy)) return;

    for (const child of this.items) {
      if (child === this.el || this.animating.has(child)) continue;
      if (hitTest(cx, cy, child)) {
        const idx = this.visualOrder.get(child)!;
        if (idx !== this.currentIndex) {
          this.exclusionZone = child.getBoundingClientRect();
          this.currentIndex = idx;
          this.reposition();
        }
        return;
      }
    }

    if (this.inst.opts.group) this.checkTransfer(cx, cy);
  }

  reposition() {
    const newOrder = arrMove([...this.items], this.draggedIndex, this.currentIndex);
    const siblings = this.items.filter((c) => c !== this.el);
    const beforeRects = captureRects(siblings);

    const dragIdx = newOrder.indexOf(this.el);
    const ref = newOrder.slice(dragIdx + 1).find((c) => c !== this.el) ?? null;
    this.placeholder.parentNode!.insertBefore(this.placeholder, ref);

    newOrder.forEach((c, i) => this.visualOrder.set(c, i));
    flip(siblings, beforeRects, this.animating);
  }

  checkTransfer(cx: number, cy: number) {
    if (hitTest(cx, cy, this.currentContainer.el)) return;
    const group = groups.get(this.inst.opts.group!)!;
    for (const other of group) {
      if (other === this.currentContainer) continue;
      if (hitTest(cx, cy, other.el)) { this.transfer(other, cy); return; }
    }
  }

  transfer(target: SortableInstance, cy: number) {
    const oldInst = this.currentContainer;
    const siblings = this.items.filter((c) => c !== this.el);
    const targetItems = queryItems(target.el, target.opts.items, this.el);

    const oldRects = captureRects(siblings);
    const targetRects = captureRects(targetItems);
    const oldHeight = oldInst.el.getBoundingClientRect().height;
    const targetHeight = target.el.getBoundingClientRect().height;

    this.placeholder.remove();
    oldInst.el.classList.remove("sortable-active");
    const insertIdx = insertPlaceholderAt(this.placeholder, target.el, targetItems, cy);
    target.el.classList.add("sortable-active");

    this.items = queryItems(target.el, target.opts.items, this.el);
    this.items.splice(insertIdx, 0, this.el);
    this.visualOrder.clear();
    this.items.forEach((c, i) => this.visualOrder.set(c, i));
    this.draggedIndex = insertIdx;
    this.currentIndex = insertIdx;
    this.currentContainer = target;

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
    this.el.getClientRects(); // reflow: lock in position before animating
    this.el.style.transform = `translate3d(${target.left - this.initialRect.left}px, ${target.top - this.initialRect.top}px, 0)`;

    let done = false;
    const finalize = () => {
      if (done) return;
      done = true;
      this.cleanup();

      const crossContainer = this.currentContainer !== this.inst;
      const from = crossContainer ? this.originalIndex : this.draggedIndex;
      const to = this.currentIndex;

      if (crossContainer && this.inst.opts.onTransfer) {
        requestAnimationFrame(() => this.inst.opts.onTransfer!({
          from, to, el: this.el,
          sourceContainer: this.inst, targetContainer: this.currentContainer,
        }));
      } else if (!crossContainer && from !== to && this.inst.opts.onReorder) {
        requestAnimationFrame(() => this.inst.opts.onReorder!({ from, to }));
      }
    };

    this.el.addEventListener("transitionend", finalize, { once: true });
    setTimeout(finalize, cssTransitionMs(this.el));
  }

  cleanup() {
    this.placeholder.remove();
    for (const child of this.items) {
      for (const prop of MANAGED_STYLE_PROPS) (child.style as any)[prop] = "";
      child.removeAttribute("data-dragging");
    }
    this.currentContainer.el.classList.remove("sortable-active");
    this.inst.el.classList.remove("sortable-active");
    document.body.style.userSelect = "";
    (document.body.style as any).webkitUserSelect = "";
    document.body.style.cursor = "";
  }
}

/** Make a container's children sortable via drag-and-drop. */
export function sortable(container: HTMLElement, userOpts: SortableOptions = {}): SortableInstance {
  if (initialized.has(container)) throw new Error("sortable() already called on this element");
  initialized.add(container);

  const opts = { ...DEFAULTS, ...userOpts } as ResolvedOptions;
  let session: DragSession | null = null;

  const ac = new AbortController();
  const sig = ac.signal;
  const on = (t: EventTarget, e: string, fn: EventListener, o?: AddEventListenerOptions) =>
    t.addEventListener(e, fn, { signal: sig, ...o });

  const inst: SortableInstance = {
    el: container, opts,
    destroy() {
      ac.abort();
      initialized.delete(container);
      if (opts.group) groups.get(opts.group)?.delete(inst);
    },
  };

  if (opts.group) {
    if (!groups.has(opts.group)) groups.set(opts.group, new Set());
    groups.get(opts.group)!.add(inst);
  }

  // On touch, prevent default and fire a synthetic click if the drag
  // threshold isn't crossed (so taps still work).
  function handleTouchStart(event: TouchEvent) {
    event.preventDefault();
    const target = event.target as HTMLElement;
    setTimeout(() => {
      if (!session) target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    }, opts.touchClickDelay);
  }

  function onPointerDown(event: MouseEvent | TouchEvent) {
    if (session) return;
    const item = validateDragTarget(event, container, opts);
    if (!item) return;
    if (event.type === "touchstart") handleTouchStart(event as TouchEvent);

    const initialPos = pointerPos(event);
    let pending = true;

    function onMove(event: MouseEvent | TouchEvent) {
      const pos = pointerPos(event);
      if (pending) {
        if (Math.abs(pos.x - initialPos.x) < opts.dragThreshold &&
            Math.abs(pos.y - initialPos.y) < opts.dragThreshold) return;
        pending = false;
        session = new DragSession(inst, item!, initialPos);
      }
      event.preventDefault();
      session?.move(pos);
    }

    function onUp() {
      dragAc.abort();
      if (session) { session.drop(); session = null; }
      pending = false;
    }

    const dragAc = new AbortController();
    const dragSig = dragAc.signal;
    sig.addEventListener("abort", () => dragAc.abort(), { signal: dragSig });
    window.addEventListener("mousemove", onMove as EventListener, { passive: false, signal: dragSig });
    window.addEventListener("touchmove", onMove as EventListener, { passive: false, signal: dragSig });
    window.addEventListener("mouseup", onUp, { signal: dragSig });
    window.addEventListener("touchend", onUp, { signal: dragSig });
    window.addEventListener("touchcancel", onUp, { signal: dragSig });
  }

  on(container, "mousedown", onPointerDown as EventListener);
  on(container, "touchstart", onPointerDown as EventListener, { passive: false });
  on(window, "selectstart", (e) => { if (session) e.preventDefault(); });
  on(window, "dragstart", (e) => { if (session) e.preventDefault(); });

  return inst;
}

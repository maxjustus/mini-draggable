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
  disabled: (el: HTMLElement) => el.hasAttribute("data-drag-disabled"),
  onReorder: null,
  onTransfer: null,
  group: null,
  dragThreshold: 5,
  touchClickDelay: 100,
  scrollThreshold: 150,
};

const MANAGED_STYLE_PROPS = [
  "transform",
  "transition",
  "position",
  "zIndex",
  "top",
  "left",
  "width",
  "height",
] as const;

const groups: Map<string, Set<SortableInstance>> = new Map();
const initialized: WeakSet<HTMLElement> = new WeakSet();

/**
 * Extract pointer coordinates from a mouse or touch event.
 */
function pointerPos(event: MouseEvent | TouchEvent): Point {
  if ("touches" in event) {
    return { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }
  return { x: event.clientX, y: event.clientY };
}

/**
 * Move an element within an array from one index to another (mutates).
 */
export function arrMove<T>(arr: T[], from: number, to: number): T[] {
  arr.splice(to, 0, arr.splice(from, 1)[0]);
  return arr;
}

/**
 * Check if a point (x, y) is inside an element's bounding rect.
 */
function hitTest(x: number, y: number, el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom;
}

/**
 * Snapshot bounding rects for a list of elements.
 */
function captureRects(items: HTMLElement[]): Map<HTMLElement, DOMRect> {
  const rects: Map<HTMLElement, DOMRect> = new Map();
  for (const el of items) {
    rects.set(el, el.getBoundingClientRect());
  }
  return rects;
}

/**
 * Read the CSS-defined transition duration for an element (in ms).
 */
function cssTransitionMs(el: HTMLElement): number {
  const raw = getComputedStyle(el).transitionDuration;
  return raw ? parseFloat(raw) * 1000 : 0;
}

/**
 * Walk up the DOM to find the nearest scrollable ancestor.
 */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el;
  while (node) {
    if (/scroll|auto/.test(getComputedStyle(node).overflow)) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Build a scroll-target adapter for either a scrollable element or the window.
 */
function buildScrollTarget(el: HTMLElement | null): ScrollTarget {
  if (el) {
    return {
      scrollBy(x: number, y: number) {
        el.scrollTop += y;
        el.scrollLeft += x;
      },
      get scrollX() {
        return el.scrollLeft;
      },
      get scrollY() {
        return el.scrollTop;
      },
      get scrollWidth() {
        return el.scrollWidth;
      },
      get scrollHeight() {
        return el.scrollHeight;
      },
      get width() {
        return el.getBoundingClientRect().width;
      },
      get height() {
        return el.getBoundingClientRect().height;
      },
    };
  }

  return {
    scrollBy(x: number, y: number) {
      window.scrollBy(x, y);
    },
    get scrollX() {
      return window.scrollX;
    },
    get scrollY() {
      return window.scrollY;
    },
    get scrollWidth() {
      return document.body.scrollWidth;
    },
    get scrollHeight() {
      return document.body.scrollHeight;
    },
    get width() {
      return window.innerWidth;
    },
    get height() {
      return window.innerHeight;
    },
  };
}

/**
 * Create a placeholder element that occupies the same layout space as the source.
 * Copies computed dimensions, margins, grid/flex properties.
 */
function createPlaceholder(source: HTMLElement): HTMLElement {
  const placeholder = document.createElement(source.tagName) as HTMLElement;
  placeholder.className = source.className;
  placeholder.setAttribute("data-drag-placeholder", "");
  placeholder.textContent = "";

  const style = getComputedStyle(source);
  placeholder.style.width = style.width;
  placeholder.style.height = style.height;
  placeholder.style.minWidth = style.minWidth;
  placeholder.style.minHeight = style.minHeight;
  placeholder.style.margin = style.margin;
  placeholder.style.padding = style.padding;
  placeholder.style.boxSizing = style.boxSizing;
  placeholder.style.gridColumn = style.gridColumn;
  placeholder.style.gridRow = style.gridRow;
  placeholder.style.gridArea = style.gridArea;
  placeholder.style.flexGrow = style.flexGrow;
  placeholder.style.flexShrink = style.flexShrink;
  placeholder.style.flexBasis = style.flexBasis;
  placeholder.style.alignSelf = style.alignSelf;
  placeholder.style.pointerEvents = "none";

  return placeholder;
}

/**
 * Animate items from their old positions to their new positions using FLIP.
 * Items are added to the `animating` set during the transition to prevent
 * re-triggering swaps while they're in flight.
 */
function flip(
  items: HTMLElement[],
  beforeRects: Map<HTMLElement, DOMRect>,
  animating: Set<HTMLElement>,
): void {
  for (const child of items) {
    const first = beforeRects.get(child);
    if (!first) continue;

    const last = child.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (dx === 0 && dy === 0) continue;

    // Set initial offset (no transition)
    child.style.transition = "none";
    child.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;

    // Force reflow, then animate to final position
    child.getClientRects();
    child.style.transition = "";
    child.style.transform = "none";

    // Track animation state for hit-test suppression
    animating.add(child);
    const done = () => animating.delete(child);
    child.addEventListener("transitionend", done, { once: true });
    setTimeout(done, cssTransitionMs(child));
  }
}

/**
 * Animate a container's height change using FLIP.
 */
function flipHeight(container: HTMLElement, firstHeight: number): void {
  const lastHeight = container.getBoundingClientRect().height;
  if (firstHeight === lastHeight) return;

  container.style.height = `${firstHeight}px`;
  container.style.transition = "none";
  container.getClientRects();
  container.style.transition = "";
  container.style.height = `${lastHeight}px`;

  const cleanup = () => {
    container.style.height = "";
    container.style.transition = "";
  };
  container.addEventListener("transitionend", cleanup, { once: true });
  setTimeout(cleanup, cssTransitionMs(container));
}

/**
 * Lift an element out of normal flow into a fixed position at its current
 * visual location. Used at drag start to float the dragged item.
 */
function liftElement(el: HTMLElement, box: DOMRect): void {
  el.style.position = "fixed";
  el.style.zIndex = "10000";
  el.style.top = `${box.top}px`;
  el.style.left = `${box.left}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
  el.style.transition = "none";
  el.style.transform = "translate3d(0, 0, 0)";
}

/**
 * Create an auto-scroller that scrolls a container (or the window) when
 * the pointer is near its edges during a drag.
 */
function createAutoScroller(config: AutoScrollerConfig): { start: () => void } {
  const { scrollEl, target: scrollTarget, threshold, getPointer, isActive, onTick } = config;
  let scrolling = false;

  function edgeDistances(pointer: Point): EdgeDistances {
    if (scrollEl) {
      const rect = scrollEl.getBoundingClientRect();
      return {
        top: pointer.y - rect.top,
        right: rect.right - pointer.x,
        bottom: rect.bottom - pointer.y,
        left: pointer.x - rect.left,
      };
    }
    return {
      top: pointer.y,
      right: innerWidth - pointer.x,
      bottom: innerHeight - pointer.y,
      left: pointer.x,
    };
  }

  function scrollThresholds(): { x: number; y: number } {
    if (scrollEl) {
      const rect = scrollEl.getBoundingClientRect();
      return {
        x: Math.min(rect.width * 0.25, threshold),
        y: Math.min(rect.height * 0.25, threshold),
      };
    }
    return { x: threshold, y: threshold };
  }

  function shouldScroll(dist: EdgeDistances, thresh: { x: number; y: number }): boolean {
    return (
      (dist.top < thresh.y && scrollTarget.scrollY > 0) ||
      (dist.right < thresh.x &&
        scrollTarget.scrollX + scrollTarget.width < scrollTarget.scrollWidth) ||
      (dist.bottom < thresh.y &&
        scrollTarget.scrollY + scrollTarget.height < scrollTarget.scrollHeight) ||
      (dist.left < thresh.x && scrollTarget.scrollX > 0)
    );
  }

  function loop(): void {
    if (!isActive() || !scrolling) {
      scrolling = false;
      return;
    }
    requestAnimationFrame(loop);

    const dist = edgeDistances(getPointer());
    const thresh = scrollThresholds();

    if (dist.top < thresh.y && scrollTarget.scrollY > 0)
      scrollTarget.scrollBy(0, -(2 ** ((thresh.y - dist.top) / 28)));

    if (
      dist.right < thresh.x &&
      scrollTarget.scrollX + scrollTarget.width < scrollTarget.scrollWidth
    )
      scrollTarget.scrollBy(2 ** ((thresh.x - dist.right) / 28), 0);

    if (
      dist.bottom < thresh.y &&
      scrollTarget.scrollY + scrollTarget.height < scrollTarget.scrollHeight
    )
      scrollTarget.scrollBy(0, 2 ** ((thresh.y - dist.bottom) / 28));

    if (dist.left < thresh.x && scrollTarget.scrollX > 0)
      scrollTarget.scrollBy(-(2 ** ((thresh.x - dist.left) / 28)), 0);

    onTick();
  }

  return {
    start() {
      if (scrolling) return;
      if (shouldScroll(edgeDistances(getPointer()), scrollThresholds())) {
        scrolling = true;
        requestAnimationFrame(loop);
      }
    },
  };
}

/**
 * Insert a placeholder into a container at the vertical position closest
 * to the given y-coordinate.
 */
function insertPlaceholderAt(
  placeholder: HTMLElement,
  container: HTMLElement,
  items: HTMLElement[],
  cy: number,
): number {
  const found = items.findIndex((child) => {
    const rect = child.getBoundingClientRect();
    return cy < rect.top + rect.height / 2;
  });
  const idx = found === -1 ? items.length : found;

  if (idx >= items.length) container.appendChild(placeholder);
  else container.insertBefore(placeholder, items[idx]);

  return idx;
}

/**
 * Validate a pointer event as a valid drag start. Returns the target
 * sortable item, or null if the event should be ignored.
 */
function validateDragTarget(
  event: MouseEvent | TouchEvent,
  container: HTMLElement,
  opts: ResolvedOptions,
): HTMLElement | null {
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
 * discarded after the drop animation settles. All drag state lives here
 * as explicit instance properties.
 */
class DragSession {
  inst: SortableInstance;
  el: HTMLElement;
  initialPos: Point;
  initialRect: DOMRect;
  placeholder: HTMLElement;
  animating: Set<HTMLElement>;
  items: HTMLElement[];
  originalIndex: number;
  draggedIndex: number;
  currentIndex: number;
  pointer: Point;
  currentContainer: SortableInstance;
  dropping: boolean;
  indexDirty: boolean;
  visualOrder: Map<HTMLElement, number>;
  exclusionZone: DOMRect | null;
  scroller: { start: () => void };

  constructor(inst: SortableInstance, el: HTMLElement, initialPos: Point) {
    this.inst = inst;
    this.el = el;
    this.initialPos = initialPos;
    this.initialRect = el.getBoundingClientRect();
    this.placeholder = createPlaceholder(el);
    this.animating = new Set();

    this.items = [...inst.el.querySelectorAll(inst.opts.items)] as HTMLElement[];
    this.originalIndex = this.items.indexOf(el);
    this.draggedIndex = this.originalIndex;
    this.currentIndex = this.originalIndex;
    this.pointer = initialPos;

    this.currentContainer = inst;
    this.dropping = false;
    this.indexDirty = false;

    // Visual position tracking — diverges from DOM order after each
    // reposition. items.indexOf() would return stale original positions.
    this.visualOrder = new Map();
    this.items.forEach((child, i) => this.visualOrder.set(child, i));

    // Exclusion zone: after a swap, suppress further swaps while the
    // dragged element's center stays inside the swapped target's
    // pre-swap rect. Prevents oscillation in grid layouts.
    this.exclusionZone = null;

    // Insert placeholder and lift element into fixed positioning
    el.parentNode!.insertBefore(this.placeholder, el);
    liftElement(el, this.initialRect);

    // Activate drag state
    el.setAttribute("data-dragging", "");
    inst.el.classList.add("sortable-active");
    document.body.style.userSelect = "none";
    (document.body.style as any).webkitUserSelect = "none";
    document.body.style.cursor = "grabbing";

    // Set up auto-scroller
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

  /**
   * Debounce index updates to one per animation frame. Both move() and
   * the auto-scroller's onTick route through here.
   */
  scheduleUpdate(): void {
    if (this.indexDirty) return;
    this.indexDirty = true;
    requestAnimationFrame(() => {
      this.indexDirty = false;
      this.scroller.start();
      this.updateIndex();
    });
  }

  /**
   * Called on every pointer move during drag. Updates the floating
   * element's position and schedules an index check.
   */
  move(pos: Point): void {
    if (this.dropping) return;
    this.pointer = pos;
    const dx = pos.x - this.initialPos.x;
    const dy = pos.y - this.initialPos.y;
    this.el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    this.scheduleUpdate();
  }

  /**
   * Check if the dragged element's center overlaps a sibling. If so,
   * reposition the placeholder. Respects the exclusion zone and the
   * animating set.
   */
  updateIndex(): void {
    if (this.dropping) return;

    const rect = this.el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    // Stay inside the exclusion zone — no swaps until the cursor leaves
    if (this.exclusionZone) {
      if (
        cx > this.exclusionZone.left &&
        cx < this.exclusionZone.right &&
        cy > this.exclusionZone.top &&
        cy < this.exclusionZone.bottom
      ) {
        return;
      }
      this.exclusionZone = null;
    }

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

  /**
   * Move the placeholder to reflect the current drag position within the
   * same container. FLIP-animates siblings.
   */
  reposition(): void {
    const newOrder = arrMove([...this.items], this.draggedIndex, this.currentIndex);
    const siblings = this.items.filter((child) => child !== this.el);
    const beforeRects = captureRects(siblings);

    // Find the next sibling after the dragged element in the new order
    const dragIdx = newOrder.indexOf(this.el);
    const ref = newOrder.slice(dragIdx + 1).find((child) => child !== this.el) ?? null;

    this.placeholder.parentNode!.insertBefore(this.placeholder, ref);
    newOrder.forEach((child, i) => this.visualOrder.set(child, i));
    flip(siblings, beforeRects, this.animating);
  }

  /**
   * Check if the dragged element has left its current container and
   * entered another container in the same group.
   */
  checkTransfer(cx: number, cy: number): void {
    if (hitTest(cx, cy, this.currentContainer.el)) return;

    const group = groups.get(this.inst.opts.group!)!;
    for (const other of group) {
      if (other === this.currentContainer) continue;
      if (hitTest(cx, cy, other.el)) {
        this.transfer(other, cy);
        return;
      }
    }
  }

  /**
   * Transfer the dragged element from the current container to a
   * different container in the same group.
   */
  transfer(target: SortableInstance, cy: number): void {
    const oldInst = this.currentContainer;
    const siblings = this.items.filter((child) => child !== this.el);
    const targetItems = ([...target.el.querySelectorAll(target.opts.items)] as HTMLElement[]).filter(
      (child) => child !== this.el,
    );

    // Capture pre-transfer state for FLIP
    const oldRects = captureRects(siblings);
    const targetRects = captureRects(targetItems);
    const oldHeight = oldInst.el.getBoundingClientRect().height;
    const targetHeight = target.el.getBoundingClientRect().height;

    // Move placeholder to target container
    this.placeholder.remove();
    oldInst.el.classList.remove("sortable-active");
    const insertIdx = insertPlaceholderAt(this.placeholder, target.el, targetItems, cy);
    target.el.classList.add("sortable-active");

    // Rebuild tracking for the new container
    this.items = ([...target.el.querySelectorAll(target.opts.items)] as HTMLElement[]).filter(
      (child) => child !== this.el,
    );
    this.items.splice(insertIdx, 0, this.el);

    this.visualOrder.clear();
    this.items.forEach((child, i) => this.visualOrder.set(child, i));

    this.draggedIndex = insertIdx;
    this.currentIndex = insertIdx;
    this.currentContainer = target;

    // Animate both containers
    flip(siblings, oldRects, this.animating);
    flip(targetItems, targetRects, this.animating);
    flipHeight(oldInst.el, oldHeight);
    flipHeight(target.el, targetHeight);
  }

  /**
   * Begin the drop animation. The element slides to the placeholder
   * position, then cleanup fires to restore DOM state and dispatch callbacks.
   */
  drop(): void {
    this.dropping = true;

    const target = this.placeholder.getBoundingClientRect();
    this.el.style.transition = "";
    this.el.removeAttribute("data-dragging");
    this.el.getClientRects(); // reflow: lock in position before animating
    this.el.style.transform = `translate3d(${target.left - this.initialRect.left}px, ${target.top - this.initialRect.top}px, 0)`;

    let done = false;
    const finalizeMove = () => {
      if (done) return;
      done = true;

      this.cleanup();

      const crossContainer = this.currentContainer !== this.inst;
      const from = crossContainer ? this.originalIndex : this.draggedIndex;
      const to = this.currentIndex;

      if (crossContainer && this.inst.opts.onTransfer) {
        requestAnimationFrame(() =>
          this.inst.opts.onTransfer!({
            from,
            to,
            el: this.el,
            sourceContainer: this.inst,
            targetContainer: this.currentContainer,
          }),
        );
      } else if (!crossContainer && from !== to && this.inst.opts.onReorder) {
        requestAnimationFrame(() => this.inst.opts.onReorder!({ from, to }));
      }
    };

    this.el.addEventListener("transitionend", finalizeMove, { once: true });
    setTimeout(finalizeMove, cssTransitionMs(this.el));
  }

  /**
   * Remove the placeholder, clear all inline styles set during drag,
   * and restore body/container state.
   */
  cleanup(): void {
    this.placeholder.remove();

    for (const child of this.items) {
      for (const prop of MANAGED_STYLE_PROPS) {
        (child.style as any)[prop] = "";
      }
      child.removeAttribute("data-dragging");
    }

    this.currentContainer.el.classList.remove("sortable-active");
    this.inst.el.classList.remove("sortable-active");

    document.body.style.userSelect = "";
    (document.body.style as any).webkitUserSelect = "";
    document.body.style.cursor = "";
  }
}

/**
 * Make a container's children sortable via drag-and-drop.
 * Returns a handle with `el`, `opts`, and `destroy()`.
 */
export function sortable(container: HTMLElement, userOpts: SortableOptions = {}): SortableInstance {
  if (initialized.has(container)) {
    throw new Error("sortable() already called on this element");
  }
  initialized.add(container);

  const opts: ResolvedOptions = { ...DEFAULTS, ...userOpts } as ResolvedOptions;

  let session: DragSession | null = null;

  const ac = new AbortController();
  const sig = ac.signal;

  const on = (
    target: EventTarget,
    event: string,
    handler: EventListener,
    options?: AddEventListenerOptions,
  ) => target.addEventListener(event, handler, { signal: sig, ...options });

  const inst: SortableInstance = {
    el: container,
    opts,
    destroy() {
      ac.abort();
      initialized.delete(container);
      if (opts.group) groups.get(opts.group)?.delete(inst);
    },
  };

  // Register in group for cross-container transfer
  if (opts.group) {
    if (!groups.has(opts.group)) groups.set(opts.group, new Set());
    groups.get(opts.group)!.add(inst);
  }

  function onPointerDown(event: MouseEvent | TouchEvent): void {
    if (session) return;

    const item = validateDragTarget(event, container, opts);
    if (!item) return;

    // On touch, prevent default and fire a synthetic click if the drag
    // threshold isn't crossed (so taps still work).
    if (event.type === "touchstart") {
      event.preventDefault();
      const target = event.target as HTMLElement;
      setTimeout(() => {
        if (!session) {
          target.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window,
            }),
          );
        }
      }, opts.touchClickDelay);
    }

    const initialPos = pointerPos(event);
    let pending = true;

    function onMove(event: MouseEvent | TouchEvent): void {
      const pos = pointerPos(event);

      if (pending) {
        const dx = Math.abs(pos.x - initialPos.x);
        const dy = Math.abs(pos.y - initialPos.y);
        if (dx < opts.dragThreshold && dy < opts.dragThreshold) return;
        pending = false;
        session = new DragSession(inst, item!, initialPos);
      }

      event.preventDefault();
      session?.move(pos);
    }

    function onUp(): void {
      dragAc.abort();
      if (session) {
        session.drop();
        session = null;
      }
      pending = false;
    }

    // Per-drag listeners: cleaned up on pointer-up or instance destroy
    const dragAc = new AbortController();
    const dragSig = dragAc.signal;
    sig.addEventListener("abort", () => dragAc.abort(), { signal: dragSig });

    window.addEventListener("mousemove", onMove as EventListener, {
      passive: false,
      signal: dragSig,
    });
    window.addEventListener("touchmove", onMove as EventListener, {
      passive: false,
      signal: dragSig,
    });
    window.addEventListener("mouseup", onUp, { signal: dragSig });
    window.addEventListener("touchend", onUp, { signal: dragSig });
    window.addEventListener("touchcancel", onUp, { signal: dragSig });
  }

  on(container, "mousedown", onPointerDown as EventListener);
  on(container, "touchstart", onPointerDown as EventListener, { passive: false });
  on(window, "selectstart", (event) => {
    if (session) event.preventDefault();
  });
  on(window, "dragstart", (event) => {
    if (session) event.preventDefault();
  });

  return inst;
}

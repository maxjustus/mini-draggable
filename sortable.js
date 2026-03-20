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
 * @typedef {{ x: number; y: number }} Point
 *
 * @typedef {{ from: number; to: number }} ReorderEvent
 *
 * @typedef {{
 *   from: number;
 *   to: number;
 *   el: HTMLElement;
 *   sourceContainer: SortableInstance;
 *   targetContainer: SortableInstance;
 * }} TransferEvent
 *
 *
 * @typedef {{
 *   scrollBy: (x: number, y: number) => void;
 *   scrollX: number;
 *   scrollY: number;
 *   scrollWidth: number;
 *   scrollHeight: number;
 *   width: number;
 *   height: number;
 * }} ScrollTarget
 *
 *
 * @typedef {{
 *   items?: string;
 *   handle?: string | null;
 *   disabled?: ((el: HTMLElement) => boolean) | null;
 *   onReorder?: ((event: ReorderEvent) => void) | null;
 *   onTransfer?: ((event: TransferEvent) => void) | null;
 *   group?: string | null;
 *   dragThreshold?: number;
 *   touchClickDelay?: number;
 *   scrollThreshold?: number;
 * }} SortableOptions
 *
 *
 * @typedef {Required<SortableOptions>} ResolvedOptions
 *
 * @typedef {{
 *   el: HTMLElement;
 *   opts: ResolvedOptions;
 *   destroy: () => void;
 * }} SortableInstance
 */

/** @type {ResolvedOptions} */
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

const MANAGED_STYLE_PROPS = /** @type {const} */ ([
  "transform",
  "transition",
  "position",
  "zIndex",
  "top",
  "left",
  "width",
  "height",
]);

/** @type {Map<string, Set<SortableInstance>>} */
const groups = new Map();

/** @type {WeakSet<HTMLElement>} */
const initialized = new WeakSet();

/**
 * Extract pointer coordinates from a mouse or touch event.
 *
 * @param {MouseEvent | TouchEvent} event
 * @returns {Point}
 */
function pointerPos(event) {
  if ("touches" in event) {
    return { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }
  return { x: event.clientX, y: event.clientY };
}

/**
 * Move an element within an array from one index to another (mutates).
 *
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

/**
 * Check if a point (x, y) is inside an element's bounding rect.
 *
 * @param {number} x
 * @param {number} y
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function hitTest(x, y, el) {
  const rect = el.getBoundingClientRect();
  return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom;
}

/**
 * Snapshot bounding rects for a list of elements.
 *
 * @param {HTMLElement[]} items
 * @returns {Map<HTMLElement, DOMRect>}
 */
function captureRects(items) {
  /** @type {Map<HTMLElement, DOMRect>} */
  const rects = new Map();
  for (const el of items) {
    rects.set(el, el.getBoundingClientRect());
  }
  return rects;
}

/**
 * Read the CSS-defined transition duration for an element (in ms).
 *
 * @param {HTMLElement} el
 * @returns {number}
 */
function cssTransitionMs(el) {
  const raw = getComputedStyle(el).transitionDuration;
  return raw ? parseFloat(raw) * 1000 : 0;
}

/**
 * Walk up the DOM to find the nearest scrollable ancestor.
 *
 * @param {HTMLElement} el
 * @returns {HTMLElement | null}
 */
function findScrollParent(el) {
  /** @type {HTMLElement | null} */
  let node = el;
  while (node) {
    if (/scroll|auto/.test(getComputedStyle(node).overflow)) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Build a scroll-target adapter for either a scrollable element or the window.
 *
 * @param {HTMLElement | null} el
 * @returns {ScrollTarget}
 */
function buildScrollTarget(el) {
  if (el) {
    return {
      scrollBy(x, y) {
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
    scrollBy(x, y) {
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
 * Create a placeholder element that occupies the same layout space as the source. Copies computed
 * dimensions, margins, grid/flex properties.
 *
 * @param {HTMLElement} source
 * @returns {HTMLElement}
 */
function createPlaceholder(source) {
  const placeholder = /** @type {HTMLElement} */ (document.createElement(source.tagName));
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
 * Animate items from their old positions to their new positions using FLIP. Items are added to the
 * `animating` set during the transition to prevent re-triggering swaps while they're in flight.
 *
 * @param {HTMLElement[]} items
 * @param {Map<HTMLElement, DOMRect>} beforeRects
 * @param {Set<HTMLElement>} animating
 */
function flip(items, beforeRects, animating) {
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
 *
 * @param {HTMLElement} container
 * @param {number} firstHeight
 */
function flipHeight(container, firstHeight) {
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
 * Lift an element out of normal flow into a fixed position at its current visual location. Used at
 * drag start to float the dragged item.
 *
 * @param {HTMLElement} el
 * @param {DOMRect} box
 */
function liftElement(el, box) {
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
 * Create an auto-scroller that scrolls a container (or the window) when the pointer is near its
 * edges during a drag.
 *
 * @param {{
 *   scrollEl: HTMLElement | null;
 *   target: ScrollTarget;
 *   threshold: number;
 *   getPointer: () => Point;
 *   isActive: () => boolean;
 *   onTick: () => void;
 * }} config
 * @returns {{ start: () => void }}
 */
function createAutoScroller({
  scrollEl,
  target: scrollTarget,
  threshold,
  getPointer,
  isActive,
  onTick,
}) {
  let scrolling = false;

  /**
   * @param {Point} pointer
   * @returns {{ top: number; right: number; bottom: number; left: number }}
   */
  function edgeDistances(pointer) {
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

  /** @returns {{ x: number; y: number }} */
  function scrollThresholds() {
    if (scrollEl) {
      const rect = scrollEl.getBoundingClientRect();
      return {
        x: Math.min(rect.width * 0.25, threshold),
        y: Math.min(rect.height * 0.25, threshold),
      };
    }
    return { x: threshold, y: threshold };
  }

  /**
   * @param {{ top: number; right: number; bottom: number; left: number }} dist
   * @param {{ x: number; y: number }} thresh
   * @returns {boolean}
   */
  function shouldScroll(dist, thresh) {
    return (
      (dist.top < thresh.y && scrollTarget.scrollY > 0) ||
      (dist.right < thresh.x &&
        scrollTarget.scrollX + scrollTarget.width < scrollTarget.scrollWidth) ||
      (dist.bottom < thresh.y &&
        scrollTarget.scrollY + scrollTarget.height < scrollTarget.scrollHeight) ||
      (dist.left < thresh.x && scrollTarget.scrollX > 0)
    );
  }

  function loop() {
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
 * Insert a placeholder into a container at the vertical position closest to the given y-coordinate.
 *
 * @param {HTMLElement} placeholder
 * @param {HTMLElement} container
 * @param {HTMLElement[]} items
 * @param {number} cy
 * @returns {number} The insertion index
 */
function insertPlaceholderAt(placeholder, container, items, cy) {
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
 * Validate a pointer event as a valid drag start. Returns the target sortable item, or null if the
 * event should be ignored.
 *
 * @param {MouseEvent | TouchEvent} event
 * @param {HTMLElement} container
 * @param {ResolvedOptions} opts
 * @returns {HTMLElement | null}
 */
function validateDragTarget(event, container, opts) {
  const target = /** @type {HTMLElement} */ (event.target);
  const item = /** @type {HTMLElement | null} */ (target.closest(opts.items));

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
 * Short-lived drag session. Created when the drag threshold is crossed, discarded after the drop
 * animation settles. All drag state lives here as explicit instance properties.
 */
class DragSession {
  /**
   * @param {SortableInstance} inst
   * @param {HTMLElement} el
   * @param {Point} initialPos
   */
  constructor(inst, el, initialPos) {
    this.inst = inst;
    this.el = el;
    this.initialPos = initialPos;
    this.initialRect = el.getBoundingClientRect();
    this.placeholder = createPlaceholder(el);

    /** @type {Set<HTMLElement>} */
    this.animating = new Set();

    this.items = /** @type {HTMLElement[]} */ ([...inst.el.querySelectorAll(inst.opts.items)]);
    this.originalIndex = this.items.indexOf(el);
    this.draggedIndex = this.originalIndex;
    this.currentIndex = this.originalIndex;
    this.pointer = initialPos;

    /** @type {SortableInstance} */
    this.currentContainer = inst;
    this.dropping = false;
    this.indexDirty = false;

    // Visual position tracking — diverges from DOM order after each
    // reposition. items.indexOf() would return stale original positions.
    /** @type {Map<HTMLElement, number>} */
    this.visualOrder = new Map();
    this.items.forEach((child, i) => this.visualOrder.set(child, i));

    // Exclusion zone: after a swap, suppress further swaps while the
    // dragged element's center stays inside the swapped target's
    // pre-swap rect. Prevents oscillation in grid layouts.
    /** @type {DOMRect | null} */
    this.exclusionZone = null;

    // Insert placeholder and lift element into fixed positioning
    /** @type {Node} */ (el.parentNode).insertBefore(this.placeholder, el);
    liftElement(el, this.initialRect);

    // Activate drag state
    el.setAttribute("data-dragging", "");
    inst.el.classList.add("sortable-active");
    document.body.style.userSelect = "none";
    /** @type {any} */ (document.body.style).webkitUserSelect = "none";
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
   * Debounce index updates to one per animation frame. Both move() and the auto-scroller's onTick
   * route through here.
   */
  scheduleUpdate() {
    if (this.indexDirty) return;
    this.indexDirty = true;
    requestAnimationFrame(() => {
      this.indexDirty = false;
      this.scroller.start();
      this.updateIndex();
    });
  }

  /**
   * Called on every pointer move during drag. Updates the floating element's position and schedules
   * an index check.
   *
   * @param {Point} pos
   */
  move(pos) {
    if (this.dropping) return;
    this.pointer = pos;
    const dx = pos.x - this.initialPos.x;
    const dy = pos.y - this.initialPos.y;
    this.el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    this.scheduleUpdate();
  }

  /**
   * Check if the dragged element's center overlaps a sibling. If so, reposition the placeholder.
   * Respects the exclusion zone and the animating set.
   */
  updateIndex() {
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
        const idx = /** @type {number} */ (this.visualOrder.get(child));
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
   * Move the placeholder to reflect the current drag position within the same container.
   * FLIP-animates siblings.
   */
  reposition() {
    const newOrder = arrMove([...this.items], this.draggedIndex, this.currentIndex);
    const siblings = this.items.filter((child) => child !== this.el);
    const beforeRects = captureRects(siblings);

    // Find the next sibling after the dragged element in the new order
    const dragIdx = newOrder.indexOf(this.el);
    const ref = newOrder.slice(dragIdx + 1).find((child) => child !== this.el) ?? null;

    /** @type {Node} */ (this.placeholder.parentNode).insertBefore(this.placeholder, ref);
    newOrder.forEach((child, i) => this.visualOrder.set(child, i));
    flip(siblings, beforeRects, this.animating);
  }

  /**
   * Check if the dragged element has left its current container and entered another container in
   * the same group.
   *
   * @param {number} cx
   * @param {number} cy
   */
  checkTransfer(cx, cy) {
    if (hitTest(cx, cy, this.currentContainer.el)) return;

    const group = /** @type {Set<SortableInstance>} */ (
      groups.get(/** @type {string} */ (this.inst.opts.group))
    );
    for (const other of group) {
      if (other === this.currentContainer) continue;
      if (hitTest(cx, cy, other.el)) {
        this.transfer(other, cy);
        return;
      }
    }
  }

  /**
   * Transfer the dragged element from the current container to a different container in the same
   * group.
   *
   * @param {SortableInstance} target
   * @param {number} cy
   */
  transfer(target, cy) {
    const oldInst = this.currentContainer;
    const siblings = this.items.filter((child) => child !== this.el);
    const targetItems = /** @type {HTMLElement[]} */ ([
      ...target.el.querySelectorAll(target.opts.items),
    ]).filter((child) => child !== this.el);

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
    this.items = /** @type {HTMLElement[]} */ ([
      ...target.el.querySelectorAll(target.opts.items),
    ]).filter((child) => child !== this.el);
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
   * Begin the drop animation. The element slides to the placeholder position, then settle() fires
   * to clean up and dispatch callbacks.
   */
  drop() {
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
        requestAnimationFrame(
          () =>
            this.inst.opts.onTransfer &&
            this.inst.opts.onTransfer({
              from,
              to,
              el: this.el,
              sourceContainer: this.inst,
              targetContainer: this.currentContainer,
            }),
        );
      } else if (!crossContainer && from !== to && this.inst.opts.onReorder) {
        requestAnimationFrame(
          () => this.inst.opts.onReorder && this.inst.opts.onReorder({ from, to }),
        );
      }
    };

    this.el.addEventListener("transitionend", finalizeMove, { once: true });
    setTimeout(finalizeMove, cssTransitionMs(this.el));
  }

  /**
   * Remove the placeholder, clear all inline styles set during drag, and restore body/container
   * state.
   */
  cleanup() {
    this.placeholder.remove();

    for (const child of this.items) {
      for (const prop of MANAGED_STYLE_PROPS) {
        /** @type {any} */ (child.style)[prop] = "";
      }
      child.removeAttribute("data-dragging");
    }

    this.currentContainer.el.classList.remove("sortable-active");
    this.inst.el.classList.remove("sortable-active");

    document.body.style.userSelect = "";
    /** @type {any} */ (document.body.style).webkitUserSelect = "";
    document.body.style.cursor = "";
  }
}

/**
 * Make a container's children sortable via drag-and-drop. Returns a handle with `el`, `opts`, and
 * `destroy()`.
 *
 * @param {HTMLElement} container
 * @param {SortableOptions} [userOpts]
 * @returns {SortableInstance}
 */
export function sortable(container, userOpts = {}) {
  if (initialized.has(container)) {
    throw new Error("sortable() already called on this element");
  }
  initialized.add(container);

  /** @type {ResolvedOptions} */
  const opts = { ...DEFAULTS, ...userOpts };

  /** @type {DragSession | null} */
  let session = null;

  const ac = new AbortController();
  const sig = ac.signal;

  /**
   * @param {EventTarget} target
   * @param {string} event
   * @param {EventListener} handler
   * @param {AddEventListenerOptions} [options]
   */
  const on = (target, event, handler, options) =>
    target.addEventListener(event, handler, { signal: sig, ...options });

  /** @type {SortableInstance} */
  const inst = {
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
    /** @type {Set<SortableInstance>} */ (groups.get(opts.group)).add(inst);
  }

  /** @param {MouseEvent | TouchEvent} event */
  function onPointerDown(event) {
    if (session) return;

    const item = validateDragTarget(event, container, opts);
    if (!item) return;

    // On touch, prevent default and fire a synthetic click if the drag
    // threshold isn't crossed (so taps still work).
    if (event.type === "touchstart") {
      event.preventDefault();
      const target = /** @type {HTMLElement} */ (event.target);
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

    /** @param {MouseEvent | TouchEvent} event */
    function onMove(event) {
      const pos = pointerPos(event);

      if (pending) {
        const dx = Math.abs(pos.x - initialPos.x);
        const dy = Math.abs(pos.y - initialPos.y);
        if (dx < opts.dragThreshold && dy < opts.dragThreshold) return;
        pending = false;
        session = new DragSession(inst, /** @type {HTMLElement} */ (item), initialPos);
      }

      event.preventDefault();
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

    // Per-drag listeners: cleaned up on pointer-up or instance destroy
    const dragAc = new AbortController();
    const dragSig = dragAc.signal;
    sig.addEventListener("abort", () => dragAc.abort(), { signal: dragSig });

    window.addEventListener("mousemove", /** @type {EventListener} */ (onMove), {
      passive: false,
      signal: dragSig,
    });
    window.addEventListener("touchmove", /** @type {EventListener} */ (onMove), {
      passive: false,
      signal: dragSig,
    });
    window.addEventListener("mouseup", onUp, { signal: dragSig });
    window.addEventListener("touchend", onUp, { signal: dragSig });
    window.addEventListener("touchcancel", onUp, { signal: dragSig });
  }

  on(container, "mousedown", /** @type {EventListener} */ (onPointerDown));
  on(container, "touchstart", /** @type {EventListener} */ (onPointerDown), { passive: false });
  on(window, "selectstart", (event) => {
    if (session) event.preventDefault();
  });
  on(window, "dragstart", (event) => {
    if (session) event.preventDefault();
  });

  return inst;
}

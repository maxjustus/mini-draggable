// @ts-check

// Drag-to-reorder library. Placeholder + FLIP animation approach.
// Supports lists, grids, variable heights, cross-container transfer.
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
 * @typedef {{ spliceOut: (i: number) => any; spliceIn: (i: number, item: any) => void }} SpliceBinding
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
 *   scrollThreshold?: number;
 *   animationMs?: number;
 * }} SortableOptions
 *
 *
 * @typedef {Required<SortableOptions>} ResolvedOptions
 *
 * @typedef {{ el: HTMLElement; opts: ResolvedOptions; destroy: () => void }} SortableInstance
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
  scrollThreshold: 150,
  animationMs: 150,
};

const LAYOUT_PROPS = /** @type {const} */ ([
  "width",
  "height",
  "minWidth",
  "minHeight",
  "margin",
  "padding",
  "boxSizing",
  "gridColumn",
  "gridRow",
  "gridArea",
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "alignSelf",
]);

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

const SCROLL_SPEED_RAMP = 28;
/** @type {Map<string, Set<SortableInstance>>} */
const groups = new Map();
/** @type {WeakSet<HTMLElement>} */
const initialized = new WeakSet();

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

/**
 * @param {number} x
 * @param {number} y
 * @param {HTMLElement} el
 */
function hitTest(x, y, el) {
  const rect = el.getBoundingClientRect();
  return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom;
}

/** @param {HTMLElement[]} items */
function captureRects(items) {
  return new Map(items.map((el) => /** @type {const} */ ([el, el.getBoundingClientRect()])));
}

/** @param {string} v */
function isScrollable(v) {
  return v === "auto" || v === "scroll";
}

/**
 * @param {HTMLElement} el
 * @returns {HTMLElement | null}
 */
function findScrollParent(el) {
  /** @type {HTMLElement | null} */
  let node = el;
  while (node) {
    const s = getComputedStyle(node);
    if (isScrollable(s.overflowY) || isScrollable(s.overflowX)) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * @param {HTMLElement | null} el
 * @returns {ScrollTarget}
 */
function buildScrollTarget(el) {
  if (el)
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

/** @param {HTMLElement} source */
function createPlaceholder(source) {
  const placeholder = /** @type {HTMLElement} */ (document.createElement(source.tagName));
  placeholder.className = source.className;
  placeholder.setAttribute("data-drag-placeholder", "");
  placeholder.textContent = "";
  const sourceStyle = getComputedStyle(source);
  for (const prop of LAYOUT_PROPS) placeholder.style[prop] = sourceStyle[prop];
  placeholder.style.pointerEvents = "none";
  return placeholder;
}

/**
 * FLIP-animate items from old to new positions using WAAPI.
 *
 * @param {HTMLElement[]} items
 * @param {Map<HTMLElement, DOMRect>} beforeRects
 * @param {Set<HTMLElement>} animating
 * @param {number} durationMs
 */
function flip(items, beforeRects, animating, durationMs) {
  for (const child of items) {
    const first = beforeRects.get(child);
    if (!first) continue;
    const last = child.getBoundingClientRect();
    const dx = first.left - last.left,
      dy = first.top - last.top;
    if (dx === 0 && dy === 0) continue;

    animating.add(child);
    child.getAnimations().forEach((a) => a.cancel());
    child
      .animate([{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: "none" }], {
        duration: durationMs,
        easing: "ease",
      })
      .finished.then(() => animating.delete(child));
  }
}

/**
 * @param {HTMLElement} container
 * @param {number} firstHeight
 * @param {number} durationMs
 */
function flipHeight(container, firstHeight, durationMs) {
  const lastHeight = container.getBoundingClientRect().height;
  if (firstHeight === lastHeight) return;
  container.animate([{ height: `${firstHeight}px` }, { height: `${lastHeight}px` }], {
    duration: durationMs,
    easing: "ease",
  });
}

/**
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
 * @param {number} dist
 * @param {number} threshold
 */
function scrollSpeed(dist, threshold) {
  return 2 ** ((threshold - dist) / SCROLL_SPEED_RAMP);
}

/**
 * @param {{
 *   scrollEl: HTMLElement | null;
 *   target: ScrollTarget;
 *   threshold: number;
 *   getPointer: () => Point;
 *   isActive: () => boolean;
 *   onTick: (scrolled: boolean) => void;
 * }} cfg
 */
function createAutoScroller(cfg) {
  const { scrollEl, target: scrollTarget, threshold, getPointer, isActive, onTick } = cfg;
  let scrolling = false;

  /** @param {Point} pointer */
  function edgeDist(pointer) {
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

  function edgeThresh() {
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
   * @param {ReturnType<typeof edgeDist>} dist
   * @param {ReturnType<typeof edgeThresh>} thresh
   * @returns {[number, number] | null}
   */
  function computeScroll(dist, thresh) {
    let dx = 0,
      dy = 0;
    if (dist.top < thresh.y && scrollTarget.scrollY > 0) dy -= scrollSpeed(dist.top, thresh.y);
    if (
      dist.right < thresh.x &&
      scrollTarget.scrollX + scrollTarget.width < scrollTarget.scrollWidth
    )
      dx += scrollSpeed(dist.right, thresh.x);
    if (
      dist.bottom < thresh.y &&
      scrollTarget.scrollY + scrollTarget.height < scrollTarget.scrollHeight
    )
      dy += scrollSpeed(dist.bottom, thresh.y);
    if (dist.left < thresh.x && scrollTarget.scrollX > 0) dx -= scrollSpeed(dist.left, thresh.x);
    return dx || dy ? [dx, dy] : null;
  }

  function scrollLoop() {
    if (!isActive() || !scrolling) {
      scrolling = false;
      return;
    }
    requestAnimationFrame(scrollLoop);
    const scroll = computeScroll(edgeDist(getPointer()), edgeThresh());
    if (scroll) scrollTarget.scrollBy(scroll[0], scroll[1]);
    onTick(!!scroll);
  }

  return {
    start() {
      if (scrolling) return;
      if (computeScroll(edgeDist(getPointer()), edgeThresh())) {
        scrolling = true;
        requestAnimationFrame(scrollLoop);
      }
    },
  };
}

/**
 * @param {HTMLElement} placeholder
 * @param {HTMLElement} container
 * @param {HTMLElement[]} items
 * @param {number} pointerY
 */
function insertPlaceholderAt(placeholder, container, items, pointerY) {
  const found = items.findIndex(
    (child) =>
      pointerY < child.getBoundingClientRect().top + child.getBoundingClientRect().height / 2,
  );
  const idx = found === -1 ? items.length : found;
  if (idx >= items.length) container.appendChild(placeholder);
  else container.insertBefore(placeholder, items[idx]);
  return idx;
}

/**
 * @param {HTMLElement} container
 * @param {string} selector
 * @param {HTMLElement} [exclude]
 */
function queryItems(container, selector, exclude) {
  const items = /** @type {HTMLElement[]} */ ([...container.querySelectorAll(selector)]);
  return exclude ? items.filter((child) => child !== exclude) : items;
}

/**
 * @param {PointerEvent} event
 * @param {HTMLElement} container
 * @param {ResolvedOptions} opts
 * @returns {HTMLElement | null}
 */
function validateDragTarget(event, container, opts) {
  if (event.button !== 0) return null;
  const target = /** @type {HTMLElement} */ (event.target);
  const item = /** @type {HTMLElement | null} */ (target.closest(opts.items));
  if (!item || !container.contains(item)) return null;
  if (opts.disabled?.(item)) return null;
  if (opts.handle && item.querySelector(opts.handle)) {
    const handle = target.closest(opts.handle);
    if (!handle || !item.contains(handle)) return null;
  }
  return item;
}

/** Short-lived drag session. Created on threshold cross, discarded after drop settles. */
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
    this.items = queryItems(inst.el, inst.opts.items);
    this.originalIndex = this.items.indexOf(el);
    this.draggedIndex = this.originalIndex;
    this.currentIndex = this.originalIndex;
    this.pointer = initialPos;
    /** @type {SortableInstance} */
    this.currentContainer = inst;
    this.dropping = false;
    this.framePending = false;
    /** @type {Map<HTMLElement, number>} */
    this.visualOrder = new Map();
    /** @type {DOMRect | null} */
    this.exclusionZone = null;

    this.items.forEach((child, i) => this.visualOrder.set(child, i));

    /** @type {Node} */ (el.parentNode).insertBefore(this.placeholder, el);
    liftElement(el, this.initialRect);
    el.setAttribute("data-dragging", "");
    inst.el.classList.add("sortable-active");
    document.body.style.userSelect = "none";
    /** @type {any} */ (document.body.style).webkitUserSelect = "none";
    document.body.style.cursor = "grabbing";

    const scrollEl = findScrollParent(inst.el);
    this.scroller = createAutoScroller({
      scrollEl,
      target: buildScrollTarget(scrollEl),
      threshold: inst.opts.scrollThreshold,
      getPointer: () => this.pointer,
      isActive: () => !this.dropping,
      onTick: (scrolled) => {
        if (scrolled) this.exclusionZone = null;
        this.scheduleFrame();
      },
    });
  }

  get duration() {
    return this.inst.opts.animationMs;
  }

  scheduleFrame() {
    if (this.framePending || this.dropping) return;
    this.framePending = true;
    requestAnimationFrame(() => {
      this.framePending = false;
      this.scroller.start();
      this.updateIndex();
    });
  }

  /** @param {Point} pos */
  move(pos) {
    if (this.dropping) return;
    this.pointer = pos;
    this.el.style.transform = `translate3d(${pos.x - this.initialPos.x}px, ${pos.y - this.initialPos.y}px, 0)`;
    this.scheduleFrame();
  }

  /**
   * @param {number} centerX
   * @param {number} centerY
   */
  isInExclusionZone(centerX, centerY) {
    if (!this.exclusionZone) return false;
    if (
      centerX > this.exclusionZone.left &&
      centerX < this.exclusionZone.right &&
      centerY > this.exclusionZone.top &&
      centerY < this.exclusionZone.bottom
    )
      return true;
    this.exclusionZone = null;
    return false;
  }

  updateIndex() {
    if (this.dropping) return;
    const rect = this.el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    if (this.isInExclusionZone(centerX, centerY)) return;

    for (const child of this.items) {
      if (child === this.el || this.animating.has(child)) continue;
      if (hitTest(centerX, centerY, child)) {
        const idx = /** @type {number} */ (this.visualOrder.get(child));
        if (idx !== this.currentIndex) {
          this.exclusionZone = child.getBoundingClientRect();
          this.currentIndex = idx;
          this.reposition();
        }
        return;
      }
    }
    if (this.inst.opts.group) this.checkTransfer(centerX, centerY);
  }

  reposition() {
    const newOrder = arrMove([...this.items], this.draggedIndex, this.currentIndex);
    const siblings = this.items.filter((child) => child !== this.el);
    const beforeRects = captureRects(siblings);
    const dragIdx = newOrder.indexOf(this.el);
    const ref = newOrder.slice(dragIdx + 1).find((child) => child !== this.el) ?? null;
    /** @type {Node} */ (this.placeholder.parentNode).insertBefore(this.placeholder, ref);
    newOrder.forEach((child, i) => this.visualOrder.set(child, i));
    flip(siblings, beforeRects, this.animating, this.duration);
  }

  /**
   * @param {number} centerX
   * @param {number} centerY
   */
  checkTransfer(centerX, centerY) {
    if (hitTest(centerX, centerY, this.currentContainer.el)) return;
    const group = /** @type {Set<SortableInstance>} */ (
      groups.get(/** @type {string} */ (this.inst.opts.group))
    );
    for (const other of group) {
      if (other === this.currentContainer) continue;
      if (hitTest(centerX, centerY, other.el)) {
        this.transfer(other, centerY);
        return;
      }
    }
  }

  /**
   * @param {SortableInstance} target
   * @param {number} pointerY
   */
  transfer(target, pointerY) {
    const prevContainer = this.currentContainer;
    const siblings = this.items.filter((child) => child !== this.el);
    const targetItems = queryItems(target.el, target.opts.items, this.el);

    const prevRects = captureRects(siblings);
    const targetRects = captureRects(targetItems);
    const prevHeight = prevContainer.el.getBoundingClientRect().height;
    const targetHeight = target.el.getBoundingClientRect().height;

    this.placeholder.remove();
    prevContainer.el.classList.remove("sortable-active");
    const insertIdx = insertPlaceholderAt(this.placeholder, target.el, targetItems, pointerY);
    target.el.classList.add("sortable-active");

    this.items = queryItems(target.el, target.opts.items, this.el);
    this.items.splice(insertIdx, 0, this.el);
    this.visualOrder.clear();
    this.items.forEach((child, i) => this.visualOrder.set(child, i));
    this.draggedIndex = insertIdx;
    this.currentIndex = insertIdx;
    this.currentContainer = target;

    flip(siblings, prevRects, this.animating, this.duration);
    flip(targetItems, targetRects, this.animating, this.duration);
    flipHeight(prevContainer.el, prevHeight, this.duration);
    flipHeight(target.el, targetHeight, this.duration);
  }

  drop() {
    this.dropping = true;
    const target = this.placeholder.getBoundingClientRect();
    const dx = target.left - this.initialRect.left;
    const dy = target.top - this.initialRect.top;

    this.el.removeAttribute("data-dragging");

    this.el
      .animate(
        [{ transform: this.el.style.transform }, { transform: `translate3d(${dx}px, ${dy}px, 0)` }],
        { duration: this.duration, easing: "ease" },
      )
      .finished.then(() => {
        const crossContainer = this.currentContainer !== this.inst;
        const from = crossContainer ? this.originalIndex : this.draggedIndex;
        const to = this.currentIndex;

        if (crossContainer && this.inst.opts.onTransfer) {
          this.inst.opts.onTransfer({
            from,
            to,
            el: this.el,
            sourceContainer: this.inst,
            targetContainer: this.currentContainer,
          });
        } else if (!crossContainer && from !== to && this.inst.opts.onReorder) {
          this.inst.opts.onReorder({ from, to });
        }

        this.cleanup();
      });
  }

  cleanup() {
    this.placeholder.remove();
    for (const child of this.items) {
      for (const prop of MANAGED_STYLE_PROPS) /** @type {any} */ (child.style)[prop] = "";
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
 * Make a container's children sortable via drag-and-drop.
 *
 * @param {HTMLElement} container
 * @param {SortableOptions} [userOpts]
 * @returns {SortableInstance}
 */
export function sortable(container, userOpts = {}) {
  if (initialized.has(container)) throw new Error("sortable() already called on this element");
  initialized.add(container);

  /** @type {ResolvedOptions} */
  const opts = /** @type {ResolvedOptions} */ ({ ...DEFAULTS, ...userOpts });
  /** @type {DragSession | null} */
  let session = null;

  const ac = new AbortController();
  const sig = ac.signal;
  /**
   * @param {EventTarget} t
   * @param {string} e
   * @param {EventListener} fn
   * @param {AddEventListenerOptions} [o]
   */
  const on = (t, e, fn, o) => t.addEventListener(e, fn, { signal: sig, ...o });

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

  if (opts.group) {
    if (!groups.has(opts.group)) groups.set(opts.group, new Set());
    /** @type {Set<SortableInstance>} */ (groups.get(opts.group)).add(inst);
  }

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    if (session) return;
    const item = validateDragTarget(event, container, opts);
    if (!item) return;

    /** @type {Point} */
    const initialPos = { x: event.clientX, y: event.clientY };
    let pending = true;

    /** @param {PointerEvent} event */
    function onMove(event) {
      /** @type {Point} */
      const pos = { x: event.clientX, y: event.clientY };
      if (pending) {
        if (
          Math.abs(pos.x - initialPos.x) < opts.dragThreshold &&
          Math.abs(pos.y - initialPos.y) < opts.dragThreshold
        )
          return;
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

    const dragAc = new AbortController();
    const dragSig = dragAc.signal;
    sig.addEventListener("abort", () => dragAc.abort(), { signal: dragSig });
    window.addEventListener("pointermove", /** @type {EventListener} */ (onMove), {
      passive: false,
      signal: dragSig,
    });
    window.addEventListener("pointerup", onUp, { signal: dragSig });
    window.addEventListener("pointercancel", onUp, { signal: dragSig });
  }

  on(container, "pointerdown", /** @type {EventListener} */ (onPointerDown));
  on(window, "selectstart", (e) => {
    if (session) e.preventDefault();
  });
  on(window, "dragstart", (e) => {
    if (session) e.preventDefault();
  });

  return inst;
}

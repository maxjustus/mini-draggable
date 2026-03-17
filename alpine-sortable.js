// Alpine.js bindings for the vanilla Draggable library.
// Maps x-sortable, x-draggable, and x-draggable-handle directives
// to data attributes consumed by the Draggable class.
//
// Usage:
//   x-sortable="items"          -- auto-splices the bound array on reorder
//   x-sortable.board="items"    -- grouped containers for cross-list transfer
//   x-sortable                  -- event-only, handle @reorder yourself

import { Draggable } from "./draggable.js";

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `[x-sortable] { position: relative; }`;
  document.head.appendChild(s);
}

/** @param {any} Alpine */
export default function AlpineSortable(Alpine) {
  injectStyles();

  Alpine.directive("sortable", (/** @type {HTMLElement} */ el, /** @type {{expression: string, modifiers: string[]}} */ { expression, modifiers }, /** @type {{evaluate: (expr: string) => any, cleanup: (fn: () => void) => void}} */ { evaluate, cleanup }) => {
    const group = modifiers[0] || null;

    /**
     * @param {number} i
     * @returns {any}
     */
    const spliceOut = (i) => {
      if (!expression) return undefined;
      return evaluate(expression).splice(i, 1)[0];
    };

    /**
     * @param {number} i
     * @param {any} item
     */
    const spliceIn = (i, item) => {
      if (!expression) return;
      evaluate(expression).splice(i, 0, item);
    };

    const d = new Draggable(el, {
      items: "[data-draggable]",
      handle: "[data-draggable-handle]",
      disabled: (/** @type {HTMLElement} */ item) => item.hasAttribute("data-drag-disabled"),
      group,
      onReorder(/** @type {{from: number, to: number}} */ { from, to }) {
        if (expression) {
          const arr = evaluate(expression);
          arr.splice(to, 0, arr.splice(from, 1)[0]);
        }
        el.dispatchEvent(new CustomEvent("reorder", {
          detail: { from, to },
          bubbles: true,
        }));
      },
      onTransfer(/** @type {{from: number, to: number, sourceContainer: Draggable, targetContainer: Draggable}} */ { from, to, sourceContainer, targetContainer }) {
        const item = sourceContainer.meta.spliceOut?.(from);
        if (item !== undefined) targetContainer.meta.spliceIn?.(to, item);
        el.dispatchEvent(new CustomEvent("transfer", {
          detail: { from, to, sourceEl: sourceContainer.el, targetEl: targetContainer.el },
          bubbles: true,
        }));
      },
    });

    d.meta = { spliceOut, spliceIn };
    cleanup(() => d.destroy());
  });

  Alpine.directive("draggable", (/** @type {HTMLElement} */ el, /** @type {{modifiers: string[]}} */ { modifiers }) => {
    el.setAttribute("data-draggable", "");
    if (modifiers.includes("handle")) el.setAttribute("data-needs-handle", "");
    if (modifiers.includes("disabled")) el.setAttribute("data-drag-disabled", "");
  });

  Alpine.directive("draggable-handle", (/** @type {HTMLElement} */ el) => {
    el.setAttribute("data-draggable-handle", "");
    el.style.cursor = "grab";
  });
}

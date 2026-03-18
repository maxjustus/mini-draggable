// Alpine.js bindings for the vanilla Sortable library.
// Maps x-sortable, x-sortable-item, and x-sortable-handle directives
// to data attributes consumed by the Sortable class.
//
// Usage:
//   x-sortable="items"          -- auto-splices the bound array on reorder
//   x-sortable.board="items"    -- grouped containers for cross-list transfer
//   x-sortable                  -- event-only, handle @reorder yourself

import { sortable, arrMove } from "./sortable.js";

/** @param {any} Alpine */
export default function AlpineSortable(Alpine) {

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

    const d = sortable(el, {
      handle: "[data-sortable-handle]",
      group,
      onReorder(/** @type {{from: number, to: number}} */ { from, to }) {
        if (expression) {
          arrMove(evaluate(expression), from, to);
        }
        el.dispatchEvent(new CustomEvent("reorder", {
          detail: { from, to },
          bubbles: true,
        }));
      },
      onTransfer(/** @type {{from: number, to: number, sourceContainer: import('./sortable.js').SortableInstance, targetContainer: import('./sortable.js').SortableInstance}} */ { from, to, sourceContainer, targetContainer }) {
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

  Alpine.directive("sortable-item", (/** @type {HTMLElement} */ el, /** @type {{modifiers: string[]}} */ { modifiers }) => {
    el.setAttribute("data-sortable", "");
    if (modifiers.includes("disabled")) el.setAttribute("data-drag-disabled", "");
  });

  Alpine.directive("sortable-handle", (/** @type {HTMLElement} */ el) => {
    el.setAttribute("data-sortable-handle", "");
    el.style.cursor = "grab";
  });
}

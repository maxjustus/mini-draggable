// Alpine.js bindings for the vanilla Draggable library.
// Maps x-sortable, x-draggable, and x-draggable-handle directives
// to data attributes consumed by the Draggable class.
//
// Usage:
//   x-sortable="items"   -- auto-splices the bound array on reorder
//   x-sortable            -- event-only, handle @reorder yourself

import { Draggable } from "./draggable.js";

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `[x-sortable] { position: relative; }`;
  document.head.appendChild(s);
}

export default function AlpineSortable(Alpine) {
  injectStyles();

  Alpine.directive("sortable", (el, { expression, modifiers }, { evaluate, cleanup }) => {
    const group = modifiers[0] || null;
    const d = new Draggable(el, {
      items: "[data-draggable]",
      handle: "[data-draggable-handle]",
      disabled: (item) => item.hasAttribute("data-drag-disabled"),
      group,
      onReorder({ from, to }) {
        if (expression) {
          const arr = evaluate(expression);
          arr.splice(to, 0, arr.splice(from, 1)[0]);
        }
        el.dispatchEvent(new CustomEvent("reorder", {
          detail: { from, to },
          bubbles: true,
        }));
      },
      onTransfer({ from, to, sourceContainer, targetContainer }) {
        const item = sourceContainer._spliceOut?.(from);
        if (item !== undefined) targetContainer._spliceIn?.(to, item);
        el.dispatchEvent(new CustomEvent("transfer", {
          detail: { from, to, sourceEl: sourceContainer.el, targetEl: targetContainer.el },
          bubbles: true,
        }));
      },
    });
    d._spliceOut = (i) => {
      if (!expression) return undefined;
      const arr = evaluate(expression);
      return arr.splice(i, 1)[0];
    };
    d._spliceIn = (i, item) => {
      if (!expression) return;
      const arr = evaluate(expression);
      arr.splice(i, 0, item);
    };
    cleanup(() => d.destroy());
  });

  Alpine.directive("draggable", (el, { modifiers }) => {
    el.setAttribute("data-draggable", "");
    if (modifiers.includes("handle")) el.setAttribute("data-needs-handle", "");
    if (modifiers.includes("disabled")) el.setAttribute("data-drag-disabled", "");
  });

  Alpine.directive("draggable-handle", (el) => {
    el.setAttribute("data-draggable-handle", "");
    el.style.cursor = "grab";
  });
}

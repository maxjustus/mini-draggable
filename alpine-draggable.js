// Alpine.js bindings for the vanilla Draggable library.
// Maps x-draggable-list, x-draggable, and x-draggable-handle directives
// to data attributes consumed by the Draggable class.

import { Draggable } from "./draggable.js";

// Inject Alpine-specific styles (attribute selectors for directives)
let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `[x-draggable-list] { position: relative; }`;
  document.head.appendChild(s);
}

export default function AlpineDraggable(Alpine) {
  injectStyles();

  Alpine.directive("draggable-list", (el, {}, { cleanup }) => {
    const d = new Draggable(el, {
      items: "[data-draggable]",
      handle: "[data-draggable-handle]",
      disabled: (item) => item.hasAttribute("data-drag-disabled"),
      onReorder({ from, to }) {
        el.dispatchEvent(new CustomEvent("reorder", {
          detail: { from, to },
          bubbles: true,
        }));
      },
    });
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

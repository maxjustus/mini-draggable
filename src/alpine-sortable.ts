// Alpine.js bindings for the vanilla sortable library.
// Maps x-sortable, x-sortable-item, and x-sortable-handle directives
// to data attributes consumed by sortable().
//
// Usage:
//   x-sortable="items"          -- auto-splices the bound array on reorder
//   x-sortable.board="items"    -- grouped containers for cross-list transfer
//   x-sortable                  -- event-only, handle @reorder yourself

import { sortable, arrMove, type SortableInstance, type TransferEvent } from "./sortable.js";

type SpliceBinding = {
  spliceOut: (i: number) => any;
  spliceIn: (i: number, item: any) => void;
};

const bindings: WeakMap<SortableInstance, SpliceBinding> = new WeakMap();

type AlpineDirectiveContext = {
  expression: string;
  modifiers: string[];
};

type AlpineUtilities = {
  evaluate: (expr: string) => any;
  cleanup: (fn: () => void) => void;
};

export default function AlpineSortable(Alpine: any): void {
  Alpine.directive(
    "sortable",
    (el: HTMLElement, { expression, modifiers }: AlpineDirectiveContext, { evaluate, cleanup }: AlpineUtilities) => {
      const group = modifiers[0] || null;

      const spliceOut = (i: number): any => {
        if (!expression) return undefined;
        return evaluate(expression).splice(i, 1)[0];
      };

      const spliceIn = (i: number, item: any): void => {
        if (!expression) return;
        evaluate(expression).splice(i, 0, item);
      };

      const d = sortable(el, {
        handle: "[data-sortable-handle]",
        group,
        onReorder({ from, to }) {
          if (expression) {
            arrMove(evaluate(expression), from, to);
          }
          el.dispatchEvent(
            new CustomEvent("reorder", {
              detail: { from, to },
              bubbles: true,
            }),
          );
        },
        onTransfer({ from, to, sourceContainer, targetContainer }: TransferEvent) {
          const src = bindings.get(sourceContainer);
          const tgt = bindings.get(targetContainer);
          if (src && tgt) {
            const item = src.spliceOut(from);
            if (item !== undefined) tgt.spliceIn(to, item);
          }
          el.dispatchEvent(
            new CustomEvent("transfer", {
              detail: { from, to, sourceEl: sourceContainer.el, targetEl: targetContainer.el },
              bubbles: true,
            }),
          );
        },
      });

      bindings.set(d, { spliceOut, spliceIn });
      cleanup(() => d.destroy());
    },
  );

  Alpine.directive(
    "sortable-item",
    (el: HTMLElement, { modifiers }: { modifiers: string[] }) => {
      el.setAttribute("data-sortable", "");
      if (modifiers.includes("disabled")) el.setAttribute("data-drag-disabled", "");
    },
  );

  Alpine.directive("sortable-handle", (el: HTMLElement) => {
    el.setAttribute("data-sortable-handle", "");
    el.style.cursor = "grab";
  });
}

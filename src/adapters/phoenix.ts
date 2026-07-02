// Phoenix LiveView hook for the vanilla sortable library.
// A hook is a plain object — no phoenix_live_view import needed.
//
// Usage:
//   import { SortableHook } from "mini-sortable/phoenix";
//   const liveSocket = new LiveSocket("/live", Socket, { hooks: { Sortable: SortableHook } });
//
//   <ul id="my-list" phx-hook="Sortable">
//     <li :for={item <- @items} id={"item-#{item.id}"} data-sortable>{item.name}</li>
//   </ul>
//
// Container data attributes:
//   data-sort-handle    -- handle selector (e.g. "[data-sortable-handle]")
//   data-sort-group     -- group name for cross-container transfer
//   data-reorder-event  -- event name pushed on reorder (default "reorder")
//   data-transfer-event -- event name pushed on transfer (default "transfer")

import { sortable, type SortableInstance } from "../sortable.js";

type HookContext = {
  el: HTMLElement;
  pushEventTo(target: HTMLElement, event: string, payload: object): void;
  sortableInstance?: SortableInstance;
};

function itemIds(container: HTMLElement, selector: string) {
  return [...container.querySelectorAll(selector)].map((item) => item.id);
}

export const SortableHook = {
  mounted(this: HookContext) {
    const el = this.el;
    const push = (event: string, payload: object) => this.pushEventTo(el, event, payload);

    const inst = sortable(el, {
      handle: el.dataset.sortHandle || null,
      group: el.dataset.sortGroup || null,

      onReorder({ from, to }) {
        // Move the dragged element to the placeholder position before cleanup
        // removes it, so there is no snap-back while awaiting the server patch
        const items = [...el.querySelectorAll<HTMLElement>(inst.opts.items)];
        const item = items[from];
        const placeholder = el.querySelector("[data-drag-placeholder]");
        if (item && placeholder) placeholder.before(item);

        push(el.dataset.reorderEvent || "reorder", {
          id: item?.id ?? null,
          from,
          to,
          order: itemIds(el, inst.opts.items),
        });
      },

      onTransfer({ from, to, el: dragged, sourceContainer, targetContainer }) {
        const placeholder = targetContainer.el.querySelector("[data-drag-placeholder]");
        if (placeholder) placeholder.before(dragged);

        push(el.dataset.transferEvent || "transfer", {
          id: dragged.id,
          from,
          to,
          source: sourceContainer.el.id,
          target: targetContainer.el.id,
          sourceOrder: itemIds(sourceContainer.el, sourceContainer.opts.items),
          targetOrder: itemIds(targetContainer.el, targetContainer.opts.items),
        });
      },
    });

    this.sortableInstance = inst;
  },

  destroyed(this: HookContext) {
    this.sortableInstance?.destroy();
  },
};

export default SortableHook;

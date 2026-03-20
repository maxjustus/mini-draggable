// Phoenix LiveView hook for the vanilla sortable library.
// Pushes "reorder" and "transfer" events to the server on drop.
//
// Usage (JS side):
//   import { SortableHook } from 'mini-sortable/liveview';
//   let liveSocket = new LiveSocket("/live", Socket, {
//     hooks: { Sortable: SortableHook }
//   });
//
// Usage (HEEx template):
//   <ul id="my-list" phx-hook="Sortable">
//     <li :for={item <- @items} id={"item-#{item.id}"} data-sortable>
//       <%= item.name %>
//     </li>
//   </ul>
//
// With handles and groups:
//   <ul id="my-list" phx-hook="Sortable"
//       data-sort-group="board"
//       data-sort-handle="[data-sortable-handle]">
//
// LiveView event handler:
//   def handle_event("reorder", %{"from" => from, "to" => to}, socket) do
//     items = MiniSortable.reorder(socket.assigns.items, from, to)
//     {:noreply, assign(socket, items: items)}
//   end

import { sortable, type SortableInstance, type TransferEvent } from "./sortable.js";

type HookContext = {
  el: HTMLElement;
  pushEvent: (event: string, payload: object) => void;
  _sortable?: SortableInstance;
};

const ITEM_SELECTOR = "[data-sortable]";

export const SortableHook = {
  mounted(this: HookContext) {
    const el = this.el;
    const group = el.dataset.sortGroup || null;
    const handle = el.dataset.sortHandle || null;

    this._sortable = sortable(el, {
      items: ITEM_SELECTOR,
      handle,
      group,

      onReorder: ({ from, to }) => {
        // Insert dragged element at placeholder position before cleanup removes it.
        const items = [...el.querySelectorAll(ITEM_SELECTOR)];
        const item = items[from];
        const placeholder = el.querySelector("[data-drag-placeholder]");
        if (item && placeholder) placeholder.before(item);

        this.pushEvent("reorder", { id: item?.id ?? null, from, to });
      },

      onTransfer: ({ from, to, el: draggedEl, sourceContainer, targetContainer }: TransferEvent) => {
        // Move element from source to target at placeholder position.
        const placeholder = targetContainer.el.querySelector("[data-drag-placeholder]");
        if (placeholder) placeholder.before(draggedEl);

        this.pushEvent("transfer", {
          id: draggedEl.id,
          from,
          to,
          source: sourceContainer.el.id,
          target: targetContainer.el.id,
        });
      },
    });
  },

  updated() {},

  destroyed(this: HookContext) {
    this._sortable?.destroy();
  },
};

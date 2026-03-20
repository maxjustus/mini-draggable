# Phoenix LiveView Integration

mini-sortable works with Phoenix LiveView via a JS hook that pushes `reorder` and `transfer` events to the server.

## JS Hook

Copy this into your app's hooks (e.g. `assets/js/hooks/sortable.js`):

```javascript
import { sortable } from "mini-sortable";

const ITEM_SELECTOR = "[data-sortable]";

export const SortableHook = {
  mounted() {
    const el = this.el;

    this._sortable = sortable(el, {
      items: ITEM_SELECTOR,
      handle: el.dataset.sortHandle || null,
      group: el.dataset.sortGroup || null,

      onReorder({ from, to }) {
        // Move the dragged element to the placeholder position before cleanup
        // removes it. This prevents a visual snap-back while waiting for the
        // server to patch the DOM.
        const items = [...el.querySelectorAll(ITEM_SELECTOR)];
        const item = items[from];
        const placeholder = el.querySelector("[data-drag-placeholder]");
        if (item && placeholder) placeholder.before(item);

        this.pushEvent("reorder", { id: item?.id ?? null, from, to });
      },

      onTransfer({ from, to, el: draggedEl, sourceContainer, targetContainer }) {
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

  destroyed() {
    this._sortable?.destroy();
  },
};
```

Register it with your LiveSocket:

```javascript
import { SortableHook } from "./hooks/sortable";

let liveSocket = new LiveSocket("/live", Socket, {
  hooks: { Sortable: SortableHook },
});
```

## HEEx Templates

Basic sortable list -- every item needs a stable `id` for morphdom:

```heex
<ul id="my-list" phx-hook="Sortable">
  <li :for={item <- @items} id={"item-#{item.id}"} data-sortable>
    <%= item.name %>
  </li>
</ul>
```

With drag handles:

```heex
<ul id="my-list" phx-hook="Sortable" data-sort-handle="[data-sortable-handle]">
  <li :for={item <- @items} id={"item-#{item.id}"} data-sortable>
    <span data-sortable-handle style="cursor: grab">&#x2630;</span>
    <%= item.name %>
  </li>
</ul>
```

Cross-container (kanban) -- containers share a `data-sort-group`:

```heex
<ul id="todo-list" phx-hook="Sortable" data-sort-group="board">
  <li :for={item <- @todo} id={"item-#{item.id}"} data-sortable><%= item.name %></li>
</ul>

<ul id="done-list" phx-hook="Sortable" data-sort-group="board">
  <li :for={item <- @done} id={"item-#{item.id}"} data-sortable><%= item.name %></li>
</ul>
```

## LiveView Event Handlers

Reorder within a single list:

```elixir
def handle_event("reorder", %{"from" => from, "to" => to}, socket) do
  items = reorder(socket.assigns.items, from, to)
  {:noreply, assign(socket, items: items)}
end

defp reorder(list, from, to) do
  {item, rest} = List.pop_at(list, from)
  List.insert_at(rest, to, item)
end
```

Transfer between lists:

```elixir
def handle_event("transfer", params, socket) do
  %{"from" => from, "to" => to, "source" => source_id, "target" => target_id} = params

  {source_key, target_key} = {list_key(source_id), list_key(target_id)}
  {item, new_source} = List.pop_at(socket.assigns[source_key], from)
  new_target = List.insert_at(socket.assigns[target_key], to, item)

  {:noreply, socket |> assign(source_key, new_source) |> assign(target_key, new_target)}
end
```

## How It Works

The hook takes advantage of a key detail in sortable's drop sequence: `onReorder` / `onTransfer` callbacks fire **before** cleanup removes the placeholder and clears inline styles. This means the callback can insert the dragged element at the placeholder's position in the DOM, so when cleanup runs the element is already in the right place. No visual flash while waiting for the server round-trip.

## Event Payloads

Reorder: `%{"id" => "item-5", "from" => 0, "to" => 2}`

Transfer: `%{"id" => "item-5", "from" => 1, "to" => 0, "source" => "todo-list", "target" => "done-list"}`

`id` is the dragged element's DOM id. Useful as a safety check against stale indices if multiple users edit the same list concurrently.

# Phoenix LiveView Integration

mini-sortable ships a LiveView hook: `mini-sortable/phoenix`. It pushes `reorder` and `transfer` events to the LiveView or LiveComponent that owns the list (via `pushEventTo`, so it works inside components).

## Setup

```javascript
// assets/js/app.js
import { SortableHook } from "mini-sortable/phoenix";

const liveSocket = new LiveSocket("/live", Socket, {
  hooks: { Sortable: SortableHook },
});
```

## HEEx Templates

Basic sortable list — every item needs a stable `id` so morphdom can track it:

```heex
<ul id="my-list" phx-hook="Sortable">
  <li :for={item <- @items} id={"item-#{item.id}"} data-sortable>
    {item.name}
  </li>
</ul>
```

With drag handles:

```heex
<ul id="my-list" phx-hook="Sortable" data-sort-handle="[data-sortable-handle]">
  <li :for={item <- @items} id={"item-#{item.id}"} data-sortable>
    <span data-sortable-handle style="cursor: grab">&#x2630;</span>
    {item.name}
  </li>
</ul>
```

Cross-container (kanban) — containers share a `data-sort-group`:

```heex
<ul id="todo-list" phx-hook="Sortable" data-sort-group="board">
  <li :for={item <- @todo} id={"item-#{item.id}"} data-sortable>{item.name}</li>
</ul>

<ul id="done-list" phx-hook="Sortable" data-sort-group="board">
  <li :for={item <- @done} id={"item-#{item.id}"} data-sortable>{item.name}</li>
</ul>
```

Container attributes:

- `data-sort-handle` — CSS selector for the drag grip inside each item
- `data-sort-group` — group name; containers with the same group accept transfers
- `data-reorder-event` — event name pushed on reorder (default `"reorder"`)
- `data-transfer-event` — event name pushed on transfer (default `"transfer"`)

## Event Payloads

Reorder:

```
%{"id" => "item-5", "from" => 0, "to" => 2,
  "order" => ["item-2", "item-7", "item-5", "item-9"]}
```

Transfer (pushed to the source container's view/component):

```
%{"id" => "item-5", "from" => 1, "to" => 0,
  "source" => "todo-list", "target" => "done-list",
  "sourceOrder" => ["item-2"], "targetOrder" => ["item-5", "item-8"]}
```

Prefer `order`/`sourceOrder`/`targetOrder` over the indices on the server: writing the full order is idempotent and immune to stale indices when multiple users edit the same list.

## LiveView Event Handlers

```elixir
def handle_event("reorder", %{"order" => ids}, socket) do
  by_id = Map.new(socket.assigns.items, &{"item-#{&1.id}", &1})
  {:noreply, assign(socket, items: Enum.map(ids, &by_id[&1]))}
end

def handle_event("transfer", %{"sourceOrder" => source_ids, "targetOrder" => target_ids}, socket) do
  all = socket.assigns.todo ++ socket.assigns.done
  by_id = Map.new(all, &{"item-#{&1.id}", &1})

  {:noreply,
   socket
   |> assign(:todo, Enum.map(source_ids, &by_id[&1]))
   |> assign(:done, Enum.map(target_ids, &by_id[&1]))}
end
```

## How It Works

- The hook fires callbacks **after** the drop animation settles but **before** cleanup removes the placeholder, and moves the dragged element to the placeholder position in the DOM. The list is already visually correct while the server round-trip is in flight, so the LiveView patch is a no-op visually — no flash.
- The sortable instance is created once in `mounted()` and destroyed in `destroyed()`. No `updated()` handling is needed: listeners live on the container element (which morphdom preserves — it's the hook root) and items are queried per drag, so server patches that replace children are picked up automatically.

# mini-draggable

Drag-to-reorder for lists, grids, and variable-height layouts. Works with any CSS layout (block, flexbox, grid). Touch support included.

Uses a placeholder element + FLIP animation -- the browser computes correct positions, not manual math.

## Vanilla JS

```html
<ul id="my-list">
  <li data-draggable>Item 1</li>
  <li data-draggable>Item 2</li>
  <li data-draggable>Item 3</li>
</ul>

<script type="module">
  import { Draggable } from './draggable.js';

  new Draggable(document.getElementById('my-list'), {
    onReorder({ from, to }) {
      console.log(`Moved from index ${from} to ${to}`);
    },
  });
</script>
```

### Constructor options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `items` | string | `"[data-draggable]"` | CSS selector for draggable items within the container |
| `handle` | string \| null | `null` | CSS selector for handle elements. When set, items with `data-needs-handle` can only be dragged from matching elements |
| `disabled` | function \| string \| null | `null` | Predicate or CSS selector. Matching items can't be dragged or swapped into |
| `onReorder` | function \| null | `null` | Called with `{ from, to }` after a successful reorder |
| `transitionMs` | number | `150` | Duration of the FLIP animation in ms |
| `dragThreshold` | number | `5` | Pixels of movement before a drag activates |
| `touchClickDelay` | number | `100` | Ms to wait before firing synthetic click on touch (distinguishes taps from drags) |
| `scrollThreshold` | number | `150` | Distance from edge (px) that triggers auto-scroll |

### Handles

Add `data-needs-handle` to items that should only be draggable from a handle, and provide the `handle` option:

```html
<ul id="my-list">
  <li data-draggable data-needs-handle>
    <span data-draggable-handle style="cursor: grab;">&#x2630;</span>
    Item 1
  </li>
</ul>

<script type="module">
  import { Draggable } from './draggable.js';

  new Draggable(document.getElementById('my-list'), {
    handle: '[data-draggable-handle]',
    onReorder({ from, to }) { /* ... */ },
  });
</script>
```

Items without `data-needs-handle` can be dragged from anywhere, even when the `handle` option is set.

### Disabled items

```js
new Draggable(container, {
  disabled: (el) => el.hasAttribute('data-drag-disabled'),
  onReorder({ from, to }) { /* ... */ },
});
```

Disabled items can't be dragged and other items can't be swapped into their position.

### Cleanup

```js
const d = new Draggable(container, { /* ... */ });
// Later:
d.destroy();
```

### Styling

During drag, the following attributes/classes are applied:

| Selector | Applied to | When |
|----------|-----------|------|
| `[data-dragging]` | The item being dragged | During drag |
| `.draggable-active` | The container | During drag |
| `[data-drag-placeholder]` | The placeholder element | During drag |

The dragged item gets `position: fixed` with inline styles. The placeholder is a `visibility: hidden` element that preserves the dragged item's space in the layout. All inline styles are cleaned up on drop.

### CSS grid example

```html
<div id="grid" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;">
  <div data-draggable style="grid-column: span 2;">Wide</div>
  <div data-draggable>Normal</div>
  <div data-draggable style="grid-row: span 2;">Tall</div>
  <div data-draggable>Normal</div>
</div>
```

The placeholder copies computed grid/flex layout properties from the dragged item, so multi-span items preserve the grid layout during drag.

## Alpine.js

```html
<script type="module">
  import AlpineDraggable from './alpine-draggable.js';
  import Alpine from 'https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/module.esm.js';
  Alpine.plugin(AlpineDraggable);
  Alpine.start();
</script>

<ul x-data="{ items: ['A', 'B', 'C'] }"
    x-draggable-list
    @reorder="
      const [el] = items.splice($event.detail.from, 1);
      items.splice($event.detail.to, 0, el);
    ">
  <template x-for="item in items" :key="item">
    <li x-draggable x-text="item"></li>
  </template>
</ul>
```

### Directives

**`x-draggable-list`** on the container. Listens for `@reorder` events with `{ from, to }` detail.

**`x-draggable`** on each item. Modifiers:
- `.handle` -- only draggable from a handle element
- `.disabled` -- can't be dragged or swapped into

**`x-draggable-handle`** on the handle element inside a `.handle` item.

Dynamic disabled state via Alpine binding:
```html
<li x-draggable :data-drag-disabled="item.locked || false">...</li>
```

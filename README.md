# mini-sortable

[Live demo](https://maxjustus.github.io/mini-sortable/)

Drag-to-reorder for lists, grids, and variable-height layouts. Works with any CSS layout (block, flexbox, grid). Touch support included.

Uses a placeholder element + FLIP animation to support arbitrary sortable element sizes and layouts.

## Vanilla JS

```html
<ul id="my-list">
  <li data-sortable>Item 1</li>
  <li data-sortable>Item 2</li>
  <li data-sortable>Item 3</li>
</ul>

<script type="module">
  import { Sortable } from './sortable.js';

  new Sortable(document.getElementById('my-list'), {
    onReorder({ from, to }) {
      console.log(`Moved from index ${from} to ${to}`);
    },
  });
</script>
```

### Constructor options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `items` | string | `"[data-sortable]"` | CSS selector for sortable items within the container |
| `handle` | string \| null | `null` | CSS selector for handle elements. Items with `data-needs-handle` can only be dragged from matching elements |
| `disabled` | function \| null | `null` | Called with each item element. Return `true` to prevent dragging and swapping into that item |
| `onReorder` | function \| null | `null` | Called with `{ from, to }` after a same-container drop (deferred by one frame) |
| `onTransfer` | function \| null | `null` | Called with `{ from, to, el, sourceContainer, targetContainer }` after a cross-container drop |
| `group` | string \| null | `null` | Group name. Containers with the same group allow dragging items between them |
| `transitionMs` | number | `150` | Duration of the FLIP animation in ms |
| `dragThreshold` | number | `5` | Pixels of movement before a drag activates |
| `touchClickDelay` | number | `100` | Ms to wait before firing synthetic click on touch (distinguishes taps from drags) |
| `scrollThreshold` | number | `150` | Distance from edge (px) that triggers auto-scroll |

### Handles

Add `data-needs-handle` to items that should only be sortable from a handle, and provide the `handle` option:

```html
<ul id="my-list">
  <li data-sortable data-needs-handle>
    <span data-sortable-handle style="cursor: grab;">&#x2630;</span>
    Item 1
  </li>
  <li data-sortable data-needs-handle>
    <span data-sortable-handle style="cursor: grab;">&#x2630;</span>
    Item 2
  </li>
</ul>

<script type="module">
  import { Sortable } from './sortable.js';

  new Sortable(document.getElementById('my-list'), {
    handle: '[data-sortable-handle]',
    onReorder({ from, to }) { /* ... */ },
  });
</script>
```

Items without `data-needs-handle` can be dragged from anywhere, even when the `handle` option is set.

### Disabled items

```js
new Sortable(container, {
  disabled: (el) => el.hasAttribute('data-drag-disabled'),
  onReorder({ from, to }) { /* ... */ },
});
```

Disabled items can't be dragged and other items can't be swapped into their position.

### Cleanup

```js
const d = new Sortable(container, { /* ... */ });
// Later:
d.destroy();
```

### Styling

During drag, the following attributes/classes are applied:

| Selector | Applied to | When |
|----------|-----------|------|
| `[data-dragging]` | The item being dragged | During drag |
| `.sortable-active` | The container | During drag |
| `[data-drag-placeholder]` | The placeholder element | During drag (visible drop indicator, override default style with CSS) |

The dragged item gets `position: fixed` with inline styles. The placeholder preserves the dragged item's space in the layout and shows a dashed drop indicator by default. Override with your own CSS:

```css
[data-drag-placeholder] {
  background: rgba(59, 130, 246, 0.1);
  border: 2px dashed rgba(59, 130, 246, 0.4);
  border-radius: 6px;
}
```

All inline styles are cleaned up on drop.

### CSS grid

```html
<div id="grid" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;">
  <div data-sortable style="grid-column: span 2;">Wide</div>
  <div data-sortable>Normal</div>
  <div data-sortable style="grid-row: span 2;">Tall</div>
  <div data-sortable>Normal</div>
</div>
```

The placeholder copies computed grid/flex layout properties from the dragged item, so multi-span items preserve the grid layout during drag.

### Cross-container (e.g. Kanban board)

Give multiple containers the same `group` name. Items can be dragged between them.

```html
<ul id="todo">
  <li data-sortable>Task A</li>
  <li data-sortable>Task B</li>
</ul>
<ul id="done">
  <li data-sortable>Task C</li>
</ul>

<script type="module">
  import { Sortable } from './sortable.js';

  const opts = {
    group: 'board',
    onReorder({ from, to }) {
      console.log(`Reordered within list: ${from} -> ${to}`);
    },
    onTransfer({ from, to, sourceContainer, targetContainer }) {
      console.log(`Moved from list ${sourceContainer.el.id}[${from}] to ${targetContainer.el.id}[${to}]`);
    },
  };

  new Sortable(document.getElementById('todo'), opts);
  new Sortable(document.getElementById('done'), opts);
</script>
```

`onReorder` fires for moves within the same container. `onTransfer` fires when an item is dropped in a different container. `sourceContainer` and `targetContainer` are the `Sortable` instances (access `container.el` for the DOM element).

## Alpine.js

### Setup

```html
<script type="module">
  import AlpineSortable from './alpine-sortable.js';
  import Alpine from 'https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/module.esm.js';
  Alpine.plugin(AlpineSortable);
  Alpine.start();
</script>
```

### Basic list

Pass your data array as the directive expression. The plugin auto-splices it on reorder.

```html
<div x-data="{ items: ['Apple', 'Banana', 'Cherry', 'Date'] }"
     x-sortable="items">
  <ul>
    <template x-for="item in items" :key="item">
      <li x-sortable-item x-text="item"></li>
    </template>
  </ul>
</div>
```

For side effects (logging, saving to server), add `@reorder` -- the event fires after the array is already updated:

```html
<div x-data="{ items: ['A', 'B', 'C'] }"
     x-sortable="items"
     @reorder="console.log(`Moved from ${$event.detail.from} to ${$event.detail.to}`)">
```

Without an expression, the plugin only fires the event and you handle the array yourself:

```html
<div x-data="{ items: ['A', 'B', 'C'] }"
     x-sortable="items">
```

### With handles

Use the `.handle` modifier on `x-sortable-item` and add `x-sortable-handle` to the grip element. The item can only be dragged from the handle.

```html
<div x-data="{ items: ['Red', 'Green', 'Blue'] }"
     x-sortable="items">
  <ul>
    <template x-for="item in items" :key="item">
      <li x-sortable-item.handle>
        <span x-sortable-handle style="cursor: grab;">&#x2630;</span>
        <span x-text="item"></span>
      </li>
    </template>
  </ul>
</div>
```

### Disabled items

Use the `.disabled` modifier for static disabled state, or bind `data-drag-disabled` for dynamic control:

```html
<!-- Static: always disabled -->
<li x-sortable-item.disabled>Can't move this</li>

<!-- Dynamic: disabled based on data -->
<template x-for="item in items" :key="item.id">
  <li x-sortable-item
      :data-drag-disabled="item.locked || false"
      x-text="item.name"></li>
</template>
```

Disabled items can't be dragged and other items can't be swapped into their position.

### Scrollable container

Put `x-sortable` on the scrollable element. Auto-scroll triggers when dragging near the container edges.

```html
<div x-data="{ items: Array.from({length: 20}, (_, i) => `Item ${i + 1}`) }">
  <div style="max-height: 200px; overflow-y: auto;"
       x-sortable
       @reorder="
         const [el] = items.splice($event.detail.from, 1);
         items.splice($event.detail.to, 0, el);
       ">
    <ul>
      <template x-for="item in items" :key="item">
        <li x-sortable-item x-text="item"></li>
      </template>
    </ul>
  </div>
</div>
```

### CSS grid

Works with grid layouts including multi-span items:

```html
<div x-data="{
       items: [
         { label: 'A', w: 1, h: 1 },
         { label: 'B', w: 2, h: 1 },
         { label: 'C', w: 1, h: 2 },
         { label: 'D', w: 1, h: 1 },
       ]
     }"
     x-sortable="items">
  <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;">
    <template x-for="item in items" :key="item.label">
      <div x-sortable-item
           :style="`grid-column: span ${item.w}; grid-row: span ${item.h}; min-height: ${item.h * 60}px;`"
           x-text="item.label"></div>
    </template>
  </div>
</div>
```

### Variable-height items

No special configuration needed. Heights are handled correctly by the FLIP animation.

```html
<div x-data="{
       items: [
         { id: 1, text: 'Short' },
         { id: 2, text: 'This item has much more content and will wrap to multiple lines, making it taller.' },
         { id: 3, text: 'Medium length item' },
       ]
     }"
     x-sortable="items">
  <ul>
    <template x-for="item in items" :key="item.id">
      <li x-sortable-item x-text="item.text"></li>
    </template>
  </ul>
</div>
```

### Cross-container (e.g. Kanban board)

Add a group name as a modifier on `x-sortable`. Containers with the same group allow items to be dragged between them. Each container binds its own array -- the plugin auto-splices items between arrays on transfer.

```html
<div x-data="{
       todo: ['Design', 'Write tests'],
       done: ['Setup repo'],
     }"
     @transfer="console.log($event.detail)"
     @reorder="console.log($event.detail)">
  <ul x-sortable.board="todo">
    <template x-for="item in todo" :key="item">
      <li x-sortable-item x-text="item"></li>
    </template>
  </ul>
  <ul x-sortable.board="done">
    <template x-for="item in done" :key="item">
      <li x-sortable-item x-text="item"></li>
    </template>
  </ul>
</div>
```

The `@reorder` event fires for moves within the same list. The `@transfer` event fires when an item is dropped in a different list, with `{ from, to, sourceEl, targetEl }` in the detail. Both events bubble, so you can listen on a shared parent.

### Directive reference

**`x-sortable`** -- place on the container. Pass a data array as the expression (`x-sortable="items"`) for auto-splice, or omit and handle `@reorder` manually.

**`x-sortable-item`** -- place on each sortable item. Modifiers:
- `.handle` -- item can only be dragged from a child `x-sortable-handle` element
- `.disabled` -- item can't be dragged or swapped into (static)

**`x-sortable-handle`** -- place on the drag grip element inside an `x-sortable-item.handle` item. Sets `cursor: grab` automatically.

## Development

ES module imports require a local server. To view the test page:

```
make serve
```

Then open http://localhost:3813/test.html

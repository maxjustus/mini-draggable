# CLAUDE.md

## Project

mini-sortable: TypeScript drag-to-reorder library with framework adapters. Placeholder + FLIP animation approach. Supports lists, grids, variable heights, cross-container transfer.

## Files

- `src/sortable.ts` -- vanilla drag engine (DragSession class + sortable() factory)
- `src/adapters/alpine.ts` -- Alpine.js directive wrapper (`mini-sortable/alpine`)
- `src/adapters/hooks.ts` -- React/Preact hook factory (`mini-sortable/hooks`)
- `src/adapters/phoenix.ts` -- Phoenix LiveView hook (`mini-sortable/phoenix`)
- `test.html`, `test-react.html` -- test pages; import from `dist/`, so build before serving
- `index.html` -- GitHub Pages demo
- `tests/sortable.spec.ts` -- Playwright suite (mouse + touch-emulation projects)

## Commands

- `make build` -- esbuild bundles + tsc declarations into `dist/`
- `make check` -- type-check src and tests (strict mode, no emit)
- `make test` -- Playwright suite (starts its own server; run `make build` first)
- `make serve` -- dev server on port 3813 (then open /test.html)
- `make fmt` -- prettier over src and tests

## Type checking

Strict TypeScript. Run `make check` before committing. Fix all type errors -- do not use `@ts-ignore` or weaken the tsconfig.

## Architecture

- `DragSession` manages one drag: pointer capture, placeholder insertion, FLIP animation, auto-scroll, cross-container transfer; created on drag threshold, discarded after drop settles
- The library only moves the placeholder -- consumers reorder their own data/DOM in `onReorder`/`onTransfer` callbacks (fired after the drop animation settles)
- Adapters map framework idioms onto data attributes and callbacks; each is dependency-free and exposed as a package subpath export
- Groups (`opts.group`) enable cross-container drag via a module-level `Map<string, Set<SortableInstance>>`
- Dragging moves the element with the CSS `translate` property so consumer transforms compose

## Conventions

- No `_` prefix on methods -- just descriptive names
- Every item needs a stable DOM id when used with morphdom-based frameworks (LiveView)

// Framework-agnostic hook factory for the vanilla sortable library.
// Works with React, Preact, or any library with compatible useEffect/useRef hooks.
//
// Usage:
//   import { createUseSortable } from './hooks-sortable.js';
//
//   // React
//   import { useEffect, useRef } from 'react';
//   // Preact
//   import { useEffect, useRef } from 'preact/hooks';
//
//   const useSortable = createUseSortable({ useEffect, useRef });

import { sortable, arrMove } from './sortable.js';
export { arrMove };

/**
 * @template T
 * @typedef {{ current: T }} Ref
 */

/**
 * @typedef {{
 *   handle?: boolean,
 *   group?: string | null,
 *   disabled?: ((el: HTMLElement) => boolean) | null,
 *   onReorder?: ((event: import('./sortable.js').ReorderEvent) => void) | null,
 *   onTransfer?: ((event: import('./sortable.js').TransferEvent) => void) | null,
 *   spliceOut?: ((i: number) => any) | null,
 *   spliceIn?: ((i: number, item: any) => void) | null,
 * }} UseSortableOptions
 */

/**
 * @param {{ useEffect: Function, useRef: Function }} hooks
 * @returns {(opts?: UseSortableOptions) => Ref<HTMLElement | null>}
 */
export function createUseSortable({ useEffect, useRef }) {
  /**
   * @param {UseSortableOptions} [opts]
   * @returns {Ref<HTMLElement | null>}
   */
  return function useSortable(opts = {}) {
    const ref = useRef(null);
    const optsRef = useRef(opts);
    optsRef.current = opts;

    useEffect(() => {
      if (!ref.current) return;
      const s = sortable(ref.current, {
        handle:   optsRef.current.handle   ? "[data-sortable-handle]" : null,
        group:    optsRef.current.group    ?? null,
        onReorder: (/** @type {import('./sortable.js').ReorderEvent} */ e) => optsRef.current.onReorder?.(e),
        onTransfer: (/** @type {import('./sortable.js').TransferEvent} */ e) => {
          const item = e.sourceContainer.meta.spliceOut?.(e.from);
          if (item !== undefined) e.targetContainer.meta.spliceIn?.(e.to, item);
          optsRef.current.onTransfer?.(e);
        },
      });
      s.meta.spliceOut = (/** @type {number} */ i)                    => optsRef.current.spliceOut?.(i);
      s.meta.spliceIn  = (/** @type {number} */ i, /** @type {any} */ item) => optsRef.current.spliceIn?.(i, item);
      return () => s.destroy();
    }, []);

    return ref;
  };
}

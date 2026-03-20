// Framework-agnostic hook factory for the vanilla sortable library.
// Works with React, Preact, or any library with compatible useEffect/useRef hooks.
//
// Usage:
//   import { createUseSortable } from 'mini-sortable/hooks';
//   import { useEffect, useRef } from 'react'; // or 'preact/hooks'
//   const useSortable = createUseSortable({ useEffect, useRef });

import {
  sortable,
  arrMove,
  type SortableInstance,
  type SpliceBinding,
  type ReorderEvent,
  type TransferEvent,
} from "./sortable.js";

export { arrMove };

type Ref<T> = { current: T };

export type UseSortableOptions = {
  handle?: boolean;
  group?: string | null;
  disabled?: ((el: HTMLElement) => boolean) | null;
  onReorder?: ((event: ReorderEvent) => void) | null;
  onTransfer?: ((event: TransferEvent) => void) | null;
  spliceOut?: ((i: number) => any) | null;
  spliceIn?: ((i: number, item: any) => void) | null;
};

const bindings = new WeakMap<SortableInstance, SpliceBinding>();

export function createUseSortable({
  useEffect,
  useRef,
}: {
  useEffect: (effect: () => void | (() => void), deps?: any[]) => void;
  useRef: <T>(initial: T) => Ref<T>;
}) {
  return function useSortable(opts: UseSortableOptions = {}): Ref<HTMLElement | null> {
    const ref = useRef<HTMLElement | null>(null);
    const optsRef = useRef(opts);
    optsRef.current = opts;

    useEffect(() => {
      if (!ref.current) return;
      const s = sortable(ref.current, {
        handle: optsRef.current.handle ? "[data-sortable-handle]" : null,
        group: optsRef.current.group ?? null,
        onReorder: (e: ReorderEvent) => optsRef.current.onReorder?.(e),
        onTransfer: (e: TransferEvent) => {
          const src = bindings.get(e.sourceContainer);
          const tgt = bindings.get(e.targetContainer);
          if (src && tgt) {
            const item = src.spliceOut(e.from);
            if (item !== undefined) tgt.spliceIn(e.to, item);
          }
          optsRef.current.onTransfer?.(e);
        },
      });
      bindings.set(s, {
        spliceOut: (i) => optsRef.current.spliceOut?.(i),
        spliceIn: (i, item) => optsRef.current.spliceIn?.(i, item),
      });
      return () => s.destroy();
    }, []);

    return ref;
  };
}

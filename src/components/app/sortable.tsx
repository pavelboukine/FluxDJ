"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

/** Moves list[from] to position `to`. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

type Drag = { from: number; insertAt: number };

/**
 * Drag-and-drop reordering for a short vertical list, without a library:
 * pointer events on a handle (mouse and touch), a line showing where the item
 * will land, Escape to cancel, and the arrow keys on the focused handle as
 * the keyboard alternative. The list scrolls the page near its edges.
 */
export function useSortable(count: number, onMove: (from: number, to: number) => void) {
  const rows = useRef<(HTMLElement | null)[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const handleIds = useRef<string[]>([]);
  const focusAfterMove = useRef<number | null>(null);
  const base = useId();

  const update = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  // After a keyboard move the list re-renders; keep focus on the moved item's handle.
  useEffect(() => {
    if (focusAfterMove.current === null) return;
    document.getElementById(`${base}-handle-${focusAfterMove.current}`)?.focus();
    focusAfterMove.current = null;
  });

  const insertionAt = useCallback(
    (y: number) => {
      for (let i = 0; i < count; i++) {
        const rect = rows.current[i]?.getBoundingClientRect();
        if (rect && y < rect.top + rect.height / 2) return i;
      }
      return count;
    },
    [count],
  );

  function finish(commit: boolean) {
    const d = dragRef.current;
    update(null);
    if (!commit || !d) return;
    const to = d.insertAt > d.from ? d.insertAt - 1 : d.insertAt;
    if (to !== d.from) onMove(d.from, to);
  }

  useEffect(() => {
    if (!drag) return;
    const cancel = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  });

  function handleProps(index: number, label: string) {
    const id = `${base}-handle-${index}`;
    handleIds.current[index] = id;
    return {
      id,
      type: "button" as const,
      "aria-label": `Reorder ${label}`,
      "aria-describedby": `${base}-help`,
      onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus();
        update({ from: index, insertAt: index });
      },
      onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
        if (!dragRef.current) return;
        const edge = 48;
        if (e.clientY < edge) window.scrollBy(0, -12);
        else if (e.clientY > window.innerHeight - edge) window.scrollBy(0, 12);
        const insertAt = insertionAt(e.clientY);
        if (insertAt !== dragRef.current.insertAt) update({ ...dragRef.current, insertAt });
      },
      onPointerUp: () => finish(true),
      onPointerCancel: () => finish(false),
      onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
        const to = e.key === "ArrowUp" ? index - 1 : e.key === "ArrowDown" ? index + 1 : null;
        if (to === null) return;
        e.preventDefault();
        if (to < 0 || to >= count) return;
        focusAfterMove.current = to;
        onMove(index, to);
      },
    };
  }

  return {
    dragging: drag !== null,
    rowRef: (index: number) => (el: HTMLElement | null) => {
      rows.current[index] = el;
    },
    /** The dragged row is dimmed; a line marks where it will land. */
    rowClass: (index: number) =>
      cn(
        "relative",
        drag?.from === index && "opacity-50",
        drag && drag.insertAt === index && drag.insertAt !== drag.from && drag.insertAt !== drag.from + 1 && "before:absolute before:inset-x-0 before:-top-px before:h-0.5 before:bg-primary",
        drag && index === count - 1 && drag.insertAt === count && drag.from !== count - 1 && "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-primary",
      ),
    handleProps,
    helpId: `${base}-help`,
  };
}

/** The visible drag handle (a button, so it is focusable and its arrow keys move the item). */
export function DragHandle(props: ReturnType<ReturnType<typeof useSortable>["handleProps"]> & { className?: string }) {
  const { className, ...rest } = props;
  return (
    <button
      {...rest}
      className={cn(
        "flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing",
        className,
      )}
    >
      <GripVertical aria-hidden className="size-4" />
    </button>
  );
}

/** Screen-reader instructions for the handles (render once per list). */
export function SortableHelp({ id }: { id: string }) {
  return (
    <p id={id} className="sr-only">
      Drag to reorder, or focus the handle and use the up and down arrow keys.
    </p>
  );
}

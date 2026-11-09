import type { ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// A vertical list the user rearranges by dragging each row's handle (mouse or touch) or with the
// keyboard (Tab to a handle, space to pick it up, arrows to move, space to drop), with what
// happens read out to screen readers by name. Used by the embed customiser's platform list and
// the artist edit page's links and page sections.
//
// Only the handle starts a drag, so everything else in a row (inputs, checkboxes, buttons) works
// as normal, and on a phone the page still scrolls under a finger anywhere but the handle.

interface SortableListProps<T> {
  items: T[];
  /** Stable across renders and reorders: a list index is not an id. */
  getId: (item: T) => string;
  /** What the row is called, for the handle's label and the screen-reader announcements. */
  getLabel: (item: T) => string;
  onReorder: (items: T[]) => void;
  /** The row's content; put `handle` where the grip should go. */
  renderItem: (item: T, handle: ReactNode, isDragging: boolean) => ReactNode;
  className?: string;
}

function DragHandle({ label, setRef, props }: {
  label: string;
  setRef: (element: HTMLElement | null) => void;
  props: Record<string, unknown>;
}) {
  return (
    <button
      ref={setRef}
      type="button"
      {...props}
      aria-label={`Move ${label}`}
      // touch-none stops the browser scrolling the page while the handle is held.
      className="touch-none cursor-grab active:cursor-grabbing p-1 -m-1 rounded text-text-muted hover:text-text-primary bg-transparent border-none shrink-0"
    >
      <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <circle cx="5.5" cy="3.5" r="1.25" />
        <circle cx="10.5" cy="3.5" r="1.25" />
        <circle cx="5.5" cy="8" r="1.25" />
        <circle cx="10.5" cy="8" r="1.25" />
        <circle cx="5.5" cy="12.5" r="1.25" />
        <circle cx="10.5" cy="12.5" r="1.25" />
      </svg>
    </button>
  );
}

function SortableRow({ id, label, children }: {
  id: string;
  label: string;
  children: (handle: ReactNode, isDragging: boolean) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const handle = (
    <DragHandle label={label} setRef={setActivatorNodeRef} props={{ ...attributes, ...listeners }} />
  );
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'relative z-10' : undefined}
    >
      {children(handle, isDragging)}
    </li>
  );
}

export function SortableList<T>({ items, getId, getLabel, onReorder, renderItem, className }: SortableListProps<T>) {
  const sensors = useSensors(
    // A few pixels of movement before a drag starts, so a tap on the handle isn't a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids = items.map(getId);
  const labelOf = (id: UniqueIdentifier) => {
    const item = items[ids.indexOf(String(id))];
    return item === undefined ? String(id) : getLabel(item);
  };

  // dnd-kit's own announcements read out the raw ids.
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${labelOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${labelOf(active.id)} is over ${labelOf(over.id)}.` : `${labelOf(active.id)} is not over a row.`,
    onDragEnd: ({ active, over }) =>
      over ? `${labelOf(active.id)} dropped at ${labelOf(over.id)}'s place.` : `${labelOf(active.id)} dropped.`,
    onDragCancel: ({ active }) => `Moving ${labelOf(active.id)} cancelled.`,
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onReorder(arrayMove(items, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      accessibility={{ announcements }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className={`list-none p-0 m-0 ${className ?? ''}`}>
          {items.map((item) => (
            <SortableRow key={getId(item)} id={getId(item)} label={getLabel(item)}>
              {(handle, isDragging) => renderItem(item, handle, isDragging)}
            </SortableRow>
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

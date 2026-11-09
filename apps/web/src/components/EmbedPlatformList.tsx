import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { sources } from '../services/sources';
import type { SourceId } from '../types';
import { PlatformIcon } from './PlatformIcon';

const nameOf = (id: unknown) => sources[id as SourceId]?.name ?? String(id);

// What a screen reader hears while a row is moved with the keyboard (space to pick up, arrows
// to move, space to drop). dnd-kit's defaults read out the raw ids.
const announcements: Announcements = {
  onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}.`,
  onDragOver: ({ active, over }) =>
    over ? `${nameOf(active.id)} is over ${nameOf(over.id)}.` : `${nameOf(active.id)} is not over a platform.`,
  onDragEnd: ({ active, over }) =>
    over ? `${nameOf(active.id)} dropped at ${nameOf(over.id)}'s place.` : `${nameOf(active.id)} dropped.`,
  onDragCancel: ({ active }) => `Moving ${nameOf(active.id)} cancelled.`,
};

function PlatformRow({ id, included, onToggle }: {
  id: SourceId;
  included: boolean;
  onToggle: (id: SourceId) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const name = sources[id].name;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 px-2 py-1.5 rounded border text-xs bg-bg-primary ${
        isDragging ? 'relative z-10 shadow-lg border-accent-primary/60' : 'border-border'
      } ${included ? 'text-text-primary' : 'text-text-muted'}`}
    >
      {/* The handle alone starts a drag, so the checkbox and the page still scroll and tap
          normally on a phone; touch-none stops the browser scrolling while it's held. */}
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Move ${name}`}
        className="touch-none cursor-grab active:cursor-grabbing p-1 -m-1 rounded text-text-muted hover:text-text-primary bg-transparent border-none"
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
      <label className="flex flex-1 items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={included}
          onChange={() => onToggle(id)}
          className="accent-accent-primary"
        />
        <PlatformIcon
          sourceId={id}
          color="currentColor"
          emoji={sources[id].icon}
          className="w-3.5 h-3.5"
          emojiClassName=""
        />
        {name}
      </label>
    </li>
  );
}

/** The embed's platforms, in embed order: tick to include, drag (or keyboard) to reorder. */
export function EmbedPlatformList({ order, excluded, onReorder, onToggle }: {
  order: SourceId[];
  excluded: Set<SourceId>;
  onReorder: (order: SourceId[]) => void;
  onToggle: (id: SourceId) => void;
}) {
  const sensors = useSensors(
    // A few pixels of movement before a drag starts, so a tap on the handle isn't a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onReorder(arrayMove(order, order.indexOf(active.id as SourceId), order.indexOf(over.id as SourceId)));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      accessibility={{ announcements }}
    >
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <ul className="flex flex-col gap-1.5 list-none p-0 m-0 max-w-sm">
          {order.map((id) => (
            <PlatformRow key={id} id={id} included={!excluded.has(id)} onToggle={onToggle} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

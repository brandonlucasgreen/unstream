import { sources } from '../services/sources';
import type { SourceId } from '../types';
import { PlatformIcon } from './PlatformIcon';
import { SortableList } from './SortableList';

/** The embed's platforms, in embed order: tick to include, drag (or keyboard) to reorder. */
export function EmbedPlatformList({ order, excluded, onReorder, onToggle }: {
  order: SourceId[];
  excluded: Set<SourceId>;
  onReorder: (order: SourceId[]) => void;
  onToggle: (id: SourceId) => void;
}) {
  return (
    <SortableList
      items={order}
      getId={(id) => id}
      getLabel={(id) => sources[id].name}
      onReorder={onReorder}
      className="flex flex-col gap-1.5 max-w-sm"
      renderItem={(id, handle, isDragging) => {
        const included = !excluded.has(id);
        return (
          <div
            className={`flex items-center gap-2 px-2 py-1.5 rounded border text-xs bg-bg-primary ${
              isDragging ? 'shadow-lg border-accent-primary/60' : 'border-border'
            } ${included ? 'text-text-primary' : 'text-text-muted'}`}
          >
            {handle}
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
              {sources[id].name}
            </label>
          </div>
        );
      }}
    />
  );
}

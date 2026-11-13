import { sources } from '../services/sources';
import type { SourceId } from '../types';
import { PlatformIcon } from './PlatformIcon';
import { SortableList } from './SortableList';

/**
 * The embed's platforms and custom links, in embed order: tick to include, drag (or keyboard) to
 * reorder. A custom link (other_0, other_1, ...) carries the 'other' icon and its own label.
 */
export function EmbedPlatformList({ order, excluded, labelFor, onReorder, onToggle }: {
  order: string[];
  excluded: Set<string>;
  labelFor: (id: string) => string;
  onReorder: (order: string[]) => void;
  onToggle: (id: string) => void;
}) {
  return (
    <SortableList
      items={order}
      getId={(id) => id}
      getLabel={labelFor}
      onReorder={onReorder}
      className="flex flex-col gap-1.5 max-w-sm"
      renderItem={(id, handle, isDragging) => {
        const included = !excluded.has(id);
        const iconId: SourceId = id in sources ? (id as SourceId) : 'other';
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
                sourceId={iconId}
                color="currentColor"
                emoji={sources[iconId].icon}
                className="w-3.5 h-3.5"
                emojiClassName=""
              />
              {labelFor(id)}
            </label>
          </div>
        );
      }}
    />
  );
}

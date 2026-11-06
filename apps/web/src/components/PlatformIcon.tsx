import { PLATFORM_MARKS, type PlatformMark } from '../../../../api/shared/platform-logos';
import { SOCIAL_ICON_PATHS } from '../../../../api/shared/social-icon-paths';
import type { SourceId } from '../types';

// The platform marks live in api/shared/platform-logos.ts, which says where each comes from,
// because the edge-rendered pages draw them too.
export type SimpleIcon = PlatformMark;

export const SIMPLE_ICON_PATHS: Partial<Record<SourceId, SimpleIcon>> = PLATFORM_MARKS;

interface PlatformIconProps {
  sourceId: SourceId;
  color: string;
  emoji: string;
  className?: string;
  /** For the emoji fallback; '' lets it inherit the surrounding text size. */
  emojiClassName?: string;
}

export function PlatformIcon({ sourceId, color, emoji, className = 'w-4 h-4', emojiClassName = 'text-base' }: PlatformIconProps) {
  // The social marks live in api/shared/ because the crawler-rendered artist page draws them too.
  // Without them this fell through to the emoji below — and for a social platform that "emoji" is
  // the platform's own name in sources.ts, so a YouTube link rendered the word `youtube`.
  const icon = SIMPLE_ICON_PATHS[sourceId] ?? SOCIAL_ICON_PATHS[sourceId];

  if (icon) {
    // Only the hand-carved marks here carry a fillRule (Ampwall's knob slot); the shared social
    // paths are plain Simple Icons geometry and have none.
    const fillRule = 'fillRule' in icon ? icon.fillRule : undefined;
    return (
      <svg className={className} viewBox="0 0 24 24" fill={color}>
        <path d={icon.d} fillRule={fillRule} clipRule={fillRule} />
      </svg>
    );
  }

  return <span className={emojiClassName}>{emoji}</span>;
}

import type { Source } from '../types';

interface SourceBadgeProps {
  source: Source;
  url: string;
}

export function SourceBadge({ source, url }: SourceBadgeProps) {
  const isSearchOnly = source.searchOnly ?? false;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="source-badge hover:scale-105 transition-all ring-1 ring-offset-1 ring-offset-bg-primary"
      style={{
        backgroundColor: `${source.color}30`,
        color: source.color,
        borderColor: source.color,
        borderWidth: '1px',
      }}
      title={isSearchOnly ? `Search on ${source.name}` : `View on ${source.name}`}
    >
      <span className="text-base">
        {isSearchOnly ? '🔍' : source.icon}
      </span>
      <span className="flex items-center gap-1">
        {isSearchOnly ? `Search ${source.name}` : source.name}
        {!isSearchOnly && (
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        )}
      </span>
    </a>
  );
}

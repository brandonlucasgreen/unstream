import { useState } from 'react';
import * as Sentry from '@sentry/react';
import type { EmbedData } from './ResultCardTypes';

interface ResultCardPreviewProps {
  resultName: string;
  canPlay: boolean;
  previewUrl: string | undefined;
}

export function ResultCardPreview({ resultName, canPlay, previewUrl }: ResultCardPreviewProps) {
  const [showPlayer, setShowPlayer] = useState(false);
  const [embedData, setEmbedData] = useState<EmbedData | null>(null);
  const [embedLoading, setEmbedLoading] = useState(false);
  const [embedError, setEmbedError] = useState(false);

  const handlePlayClick = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (showPlayer && embedData) {
      setShowPlayer(false);
      return;
    }

    if (embedData) {
      setShowPlayer(true);
      return;
    }

    if (!previewUrl) return;

    setEmbedLoading(true);
    setEmbedError(false);

    try {
      const response = await fetch(`/api/embed/bandcamp?url=${encodeURIComponent(previewUrl)}`);
      if (!response.ok) throw new Error('Failed to fetch embed');
      const data: EmbedData = await response.json();
      setEmbedData(data);
      setShowPlayer(true);
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'resultCard.embedPreview' } });
      console.error('Embed error:', err);
      setEmbedError(true);
    } finally {
      setEmbedLoading(false);
    }
  };

  if (!canPlay) return null;

  return (
    <div>
      {showPlayer && embedData ? (
        <div className="flex items-center gap-2">
          <iframe
            src={embedData.embedUrl}
            seamless
            className="flex-1 border-0 rounded"
            style={{ height: '42px' }}
            title={`${resultName} - ${embedData.title}`}
          />
          <button
            onClick={(e) => { e.stopPropagation(); setShowPlayer(false); }}
            className="flex-shrink-0 p-1.5 rounded text-text-muted hover:text-text-primary transition-colors"
            title="Close preview"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : embedError ? (
        <p className="text-xs text-red-400">Could not load preview</p>
      ) : (
        <button
          onClick={handlePlayClick}
          disabled={embedLoading}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-sm bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 transition-colors ${embedLoading ? 'opacity-50 cursor-wait' : ''}`}
        >
          {embedLoading ? (
            <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
          ) : (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
          <span>Preview</span>
        </button>
      )}
    </div>
  );
}

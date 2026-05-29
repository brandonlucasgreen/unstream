import { Link } from 'react-router-dom';
import { useState } from 'react';
import type { SearchResult } from '../types';
import { getSource } from './ResultCardUtils';
import { analytics } from '../services/analytics';

interface ResultCardActionsProps {
  result: SearchResult;
}

export function ResultCardActions({ result }: ResultCardActionsProps) {
  const [showReportForm, setShowReportForm] = useState(false);
  const [reportText, setReportText] = useState('');

  const handleReportSubmit = (e: React.MouseEvent) => {
    e.stopPropagation();
    analytics.trackReportIssue();
    const platformList = result.platforms.map(p => `- ${getSource(p.sourceId)?.name}: ${p.url}`).join('\n');
    const subject = encodeURIComponent(`Issue Report: ${result.name}`);
    const body = encodeURIComponent(
      `Artist/Result: ${result.name}\n` +
      `Type: ${result.type}\n` +
      `Match Confidence: ${result.matchConfidence || 'N/A'}\n\n` +
      `Platforms:\n${platformList}\n\n` +
      `Issue Description:\n${reportText}\n`
    );
    window.location.href = `mailto:support@unstream.stream?subject=${subject}&body=${body}`;
    setShowReportForm(false);
    setReportText('');
  };

  return (
    <>
      {/* Claim + Report + Save */}
      <div className="pt-3 mt-3 border-t border-border/50">
        {showReportForm ? (
          <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
            <label className="text-xs text-text-secondary block">
              What's wrong with this result?
            </label>
            <textarea
              value={reportText}
              onChange={(e) => setReportText(e.target.value)}
              placeholder="e.g., Wrong artist, mismatched platforms, broken link..."
              className="w-full px-3 py-2 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary/50 resize-none"
              rows={3}
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={handleReportSubmit}
                disabled={!reportText.trim()}
                className="px-3 py-1.5 text-xs font-medium bg-accent-primary/10 text-accent-primary rounded-lg hover:bg-accent-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Send Report
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setShowReportForm(false); setReportText(''); }}
                className="px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            {/* Claim - left */}
            {result.type === 'artist' && result.matchConfidence !== 'claimed' ? (
              <Link
                to={`/claim/${result.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`}
                className="text-xs text-text-muted hover:text-accent-primary transition-colors flex items-center gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                Are you {result.name}? Claim your artist page
              </Link>
            ) : (
              <div />
            )}
            {/* Report - right */}
            <button
              onClick={(e) => { e.stopPropagation(); setShowReportForm(true); }}
              className="text-xs text-text-muted hover:text-text-secondary transition-colors flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              Report this result
            </button>
          </div>
        )}
      </div>
    </>
  );
}

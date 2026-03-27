import { useState, useMemo, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import type { SearchResult } from '../types';
import { sources } from '../services/sources';

interface MergeLink {
  id: string;
  sourceId: string;
  url: string;
  included: boolean;
}

export function AdminMergePage() {
  const { isAdmin, session } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const selectedResults: SearchResult[] = (location.state as { results?: SearchResult[] })?.results || [];

  // Build initial link superset, deduped by normalized URL
  const initialLinks = useMemo(() => {
    const seen = new Set<string>();
    const links: MergeLink[] = [];
    for (const result of selectedResults) {
      for (const p of result.platforms) {
        const normalized = p.url.replace(/\/+$/, '').toLowerCase();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          links.push({
            id: `${result.id}-${p.sourceId}-${links.length}`,
            sourceId: p.sourceId,
            url: p.url,
            included: true,
          });
        }
      }
    }
    return links;
  }, [selectedResults]);

  const [artistName, setArtistName] = useState(selectedResults[0]?.name || '');
  const [imageUrl, setImageUrl] = useState(
    selectedResults.find(r => r.imageUrl)?.imageUrl || ''
  );
  const [links, setLinks] = useState<MergeLink[]>(initialLinks);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleLink = useCallback((id: string) => {
    setLinks(prev => prev.map(l => l.id === id ? { ...l, included: !l.included } : l));
  }, []);

  const updateLinkUrl = useCallback((id: string, url: string) => {
    setLinks(prev => prev.map(l => l.id === id ? { ...l, url } : l));
  }, []);

  const removeLink = useCallback((id: string) => {
    setLinks(prev => prev.filter(l => l.id !== id));
  }, []);

  const includedLinks = links.filter(l => l.included);
  const excludedLinks = links.filter(l => !l.included);

  const handleSave = async () => {
    if (!artistName.trim()) {
      setError('Artist name is required.');
      return;
    }

    const platformUrls = includedLinks.map(l => l.url);
    if (platformUrls.length < 2) {
      setError('At least 2 platform URLs must be included.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/merge-override', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          group_name: artistName.trim(),
          platform_urls: platformUrls,
          excluded_urls: excludedLinks.map(l => l.url),
          canonical_image_url: imageUrl.trim() || null,
          notes: notes.trim() || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to save (${response.status})`);
      }

      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save merge override.');
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-text-muted">Not authorized.</p>
      </div>
    );
  }

  if (selectedResults.length === 0) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-text-muted">No results selected for merging.</p>
        <button onClick={() => navigate('/')} className="text-accent-primary hover:underline">
          Back to search
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-bold text-text-primary">
            Merge Artists
          </h1>
          <button
            onClick={() => navigate(-1)}
            className="text-sm text-text-muted hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
        </div>

        <p className="text-text-secondary text-sm">
          Merging {selectedResults.length} results: {selectedResults.map(r => r.name).join(', ')}
        </p>

        {/* Artist name */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-text-primary">Artist Name</label>
          <input
            type="text"
            value={artistName}
            onChange={(e) => setArtistName(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
          />
        </div>

        {/* Image URL */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-text-primary">Image URL (optional)</label>
          <div className="flex gap-3 items-center">
            {imageUrl && (
              <img src={imageUrl} alt="" className="w-12 h-12 rounded object-cover flex-shrink-0" />
            )}
            <input
              type="text"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://..."
              className="flex-1 px-3 py-2 rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
            />
          </div>
        </div>

        {/* Platform links */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-text-primary">
            Platform Links ({includedLinks.length} included, {excludedLinks.length} excluded)
          </label>
          <div className="space-y-2">
            {links.map((link) => {
              const source = sources[link.sourceId as keyof typeof sources];
              return (
                <div
                  key={link.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                    link.included
                      ? 'bg-surface border-border'
                      : 'bg-surface/50 border-border/50 opacity-60'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={link.included}
                    onChange={() => toggleLink(link.id)}
                    className="w-4 h-4 rounded border-border text-accent-primary focus:ring-accent-primary/50 cursor-pointer flex-shrink-0"
                  />
                  <span
                    className="text-sm font-medium flex-shrink-0 w-24"
                    style={{ color: source?.color }}
                  >
                    {source?.icon} {source?.name || link.sourceId}
                  </span>
                  <input
                    type="text"
                    value={link.url}
                    onChange={(e) => updateLinkUrl(link.id, e.target.value)}
                    className="flex-1 px-2 py-1 rounded bg-bg-secondary border border-border/50 text-text-primary text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary/50"
                  />
                  <button
                    onClick={() => removeLink(link.id)}
                    className="text-text-muted hover:text-red-400 transition-colors flex-shrink-0"
                    title="Remove link"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Notes */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-text-primary">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Reason for this merge..."
            rows={3}
            className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/50 resize-none"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={saving || includedLinks.length < 2}
            className="px-6 py-2.5 rounded-xl bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save Merge Override'}
          </button>
          <button
            onClick={() => navigate(-1)}
            className="px-6 py-2.5 rounded-xl bg-surface border border-border text-text-primary hover:bg-surface-secondary transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

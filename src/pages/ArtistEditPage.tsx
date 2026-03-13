import { useState, useEffect } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { getSession } from '../services/auth';
import { sources } from '../services/sources';
import { ArtistAuthBar } from '../components/ArtistAuthBar';
import { Footer } from '../components/Footer';
import type { SourceId } from '../types';

interface LinkEntry {
  platform: string;
  url: string;
  displayName?: string;
}

// All platforms available for adding, plus "other"
const ALL_PLATFORMS: { id: string; name: string; category: string }[] = [
  ...(Object.values(sources) as { id: SourceId; name: string; category: string }[])
    .map(s => ({ id: s.id, name: s.name, category: s.category })),
  { id: 'other', name: 'Other', category: 'other' },
];

// Streaming service URL patterns for soft warnings
const STREAMING_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /open\.spotify\.com|spotify\.link/i, name: 'Spotify' },
  { pattern: /music\.apple\.com|itunes\.apple\.com/i, name: 'Apple Music' },
  { pattern: /music\.amazon\.|amazon\.com\/music/i, name: 'Amazon Music' },
  { pattern: /deezer\.com/i, name: 'Deezer' },
  { pattern: /tidal\.com\/(?:browse|track|album|artist)/i, name: 'Tidal' },
  { pattern: /music\.youtube\.com/i, name: 'YouTube Music' },
];

function getStreamingWarning(url: string): string | null {
  if (!url.trim()) return null;
  for (const { pattern, name } of STREAMING_PATTERNS) {
    if (pattern.test(url)) {
      return `This looks like a ${name} link. Unstream focuses on platforms where artists earn a higher share of revenue. You can still add this link, but consider prioritizing direct-support platforms.`;
    }
  }
  return null;
}

export function ArtistEditPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [artistName, setArtistName] = useState('');
  const [currentSlug, setCurrentSlug] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [bio, setBio] = useState('');
  const [featuredEmbed, setFeaturedEmbed] = useState('');
  const [links, setLinks] = useState<LinkEntry[]>([]);

  // Load current artist data
  useEffect(() => {
    async function load() {
      const session = await getSession();
      if (!session) {
        navigate('/artist-login', { replace: true });
        return;
      }

      if (!slug) return;

      try {
        const response = await fetch(`/api/artist?slug=${encodeURIComponent(slug)}`);
        if (!response.ok) {
          setError('Artist not found');
          setLoading(false);
          return;
        }

        const data = await response.json();
        setArtistName(data.name || '');
        setCurrentSlug(slug);
        setNewSlug(slug);
        setBio(data.profile?.bio ?? '');
        setFeaturedEmbed(data.profile?.featuredEmbed ?? '');

        // Load existing links
        const existingLinks: LinkEntry[] = (data.platforms || []).map(
          (p: { sourceId: string; url: string; displayName?: string }) => ({
            platform: p.sourceId,
            url: p.url,
            displayName: p.displayName || '',
          })
        );
        setLinks(existingLinks);
      } catch {
        setError('Failed to load artist data');
      }
      setLoading(false);
    }
    load();
  }, [slug, navigate]);

  function addLink() {
    // Find first platform not already used
    const usedPlatforms = new Set(links.map(l => l.platform));
    const available = ALL_PLATFORMS.find(p => !usedPlatforms.has(p.id));
    setLinks([...links, { platform: available?.id || 'other', url: '', displayName: '' }]);
  }

  function addOtherLink() {
    setLinks([...links, { platform: 'other', url: '', displayName: '' }]);
  }

  function updateLink(index: number, field: 'platform' | 'url' | 'displayName', value: string) {
    const updated = [...links];
    updated[index] = { ...updated[index], [field]: value };
    setLinks(updated);
  }

  function removeLink(index: number) {
    setLinks(links.filter((_, i) => i !== index));
  }

  function moveLink(index: number, direction: -1 | 1) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= links.length) return;
    const updated = [...links];
    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    setLinks(updated);
  }

  async function handleSave() {
    setError(null);
    setSuccess(null);
    setSaving(true);

    const session = await getSession();
    if (!session) {
      setError('Session expired. Please sign in again.');
      setSaving(false);
      return;
    }

    // Validate links
    const validLinks = links.filter(l => l.url.trim());
    for (const link of validLinks) {
      try {
        new URL(link.url);
      } catch {
        const name = link.platform === 'other'
          ? (link.displayName || 'Other')
          : (sources[link.platform as SourceId]?.name || link.platform);
        setError(`Invalid URL for ${name}: ${link.url}`);
        setSaving(false);
        return;
      }
      if (link.platform === 'other' && !link.displayName?.trim()) {
        setError('Please provide a name for each custom link.');
        setSaving(false);
        return;
      }
    }

    try {
      const response = await fetch('/api/artist-profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          slug: currentSlug,
          newSlug: newSlug !== currentSlug ? newSlug : undefined,
          bio,
          featuredEmbed: featuredEmbed || null,
          links: validLinks.map(l => ({
            platform: l.platform,
            url: l.url,
            displayName: l.displayName || undefined,
          })),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Failed to save changes');
        setSaving(false);
        return;
      }

      // If slug changed, update state and navigate
      if (data.slug !== currentSlug) {
        setCurrentSlug(data.slug);
        setSuccess('Changes saved! Slug updated.');
        // Replace URL so back button works
        navigate(`/artist-edit/${data.slug}`, { replace: true });
      } else {
        setSuccess('Changes saved!');
      }
    } catch {
      setError('Network error. Please try again.');
    }
    setSaving(false);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="text-text-muted">Loading...</div>
      </div>
    );
  }

  const usedPlatforms = new Set(links.map(l => l.platform));

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <ArtistAuthBar />

      <main className="flex-1 p-6">
        <div className="max-w-2xl mx-auto space-y-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">Edit {artistName}</h1>
              <Link
                to={`/a/${currentSlug}`}
                className="text-sm text-accent-primary hover:underline"
              >
                View live profile
              </Link>
            </div>
            <Link
              to="/artist-dashboard"
              className="text-sm text-text-muted hover:text-text-primary transition-colors"
            >
              Back to dashboard
            </Link>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {success && (
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
              {success}
            </div>
          )}

          {/* Slug */}
          <section className="space-y-2">
            <label htmlFor="slug" className="block text-sm font-medium">
              Profile URL
            </label>
            <div className="flex items-center gap-1">
              <span className="text-text-muted text-sm">unstream.stream/a/</span>
              <input
                id="slug"
                type="text"
                value={newSlug}
                onChange={e => setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                className="flex-1 px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary focus:outline-none focus:border-accent-primary"
              />
            </div>
            {newSlug !== currentSlug && (
              <p className="text-xs text-amber-400">
                Changing your slug will update your profile URL. Old links will stop working.
              </p>
            )}
          </section>

          {/* Bio */}
          <section className="space-y-2">
            <label htmlFor="bio" className="block text-sm font-medium">
              Bio <span className="text-text-muted font-normal">({bio.length}/500)</span>
            </label>
            <textarea
              id="bio"
              value={bio}
              onChange={e => setBio(e.target.value.slice(0, 500))}
              rows={3}
              placeholder="Tell fans about your music..."
              className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary resize-none"
            />
          </section>

          {/* Featured Embed */}
          <section className="space-y-2">
            <label htmlFor="embed" className="block text-sm font-medium">
              Featured Release
            </label>
            <p className="text-xs text-text-muted">
              Paste an embed code from Bandcamp, Faircamp, Spotify, SoundCloud, or other platforms. Only <code className="bg-bg-secondary px-1 rounded">&lt;iframe&gt;</code> embeds are supported.
            </p>
            <textarea
              id="embed"
              value={featuredEmbed}
              onChange={e => setFeaturedEmbed(e.target.value)}
              rows={3}
              placeholder='<iframe style="border: 0; width: 100%; height: 120px;" src="https://bandcamp.com/EmbeddedPlayer/..." seamless></iframe>'
              className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary resize-none font-mono text-xs"
            />
            {featuredEmbed && (
              <div className="space-y-2">
                <p className="text-xs text-text-muted">Preview:</p>
                <div
                  className="rounded-lg overflow-hidden border border-border"
                  dangerouslySetInnerHTML={{ __html: featuredEmbed }}
                />
                <button
                  onClick={() => setFeaturedEmbed('')}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  Remove embed
                </button>
              </div>
            )}
          </section>

          {/* Platform Links */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Platform Links</h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={addLink}
                  className="text-sm text-accent-primary hover:underline"
                >
                  + Add platform
                </button>
                <button
                  onClick={addOtherLink}
                  className="text-sm text-text-muted hover:text-text-primary transition-colors"
                >
                  + Add other link
                </button>
              </div>
            </div>

            <p className="text-xs text-text-muted">
              Unstream highlights platforms where artists earn a larger share. We recommend prioritizing direct-support platforms like Bandcamp, Mirlo, and Faircamp over major streaming services.
            </p>

            {links.length === 0 && (
              <p className="text-text-muted text-sm py-4 text-center">
                No links yet. Click "Add platform" to add your first link.
              </p>
            )}

            <div className="space-y-2">
              {links.map((link, index) => {
                const streamingWarning = getStreamingWarning(link.url);
                const isOther = link.platform === 'other';

                return (
                  <div key={index} className="space-y-1">
                    <div
                      className={`flex items-center gap-2 p-3 rounded-lg bg-bg-secondary border ${streamingWarning ? 'border-amber-500/30' : 'border-border'}`}
                    >
                      {/* Reorder buttons */}
                      <div className="flex flex-col gap-0.5">
                        <button
                          onClick={() => moveLink(index, -1)}
                          disabled={index === 0}
                          className="text-text-muted hover:text-text-primary disabled:opacity-20 text-xs leading-none"
                          title="Move up"
                        >
                          ▲
                        </button>
                        <button
                          onClick={() => moveLink(index, 1)}
                          disabled={index === links.length - 1}
                          className="text-text-muted hover:text-text-primary disabled:opacity-20 text-xs leading-none"
                          title="Move down"
                        >
                          ▼
                        </button>
                      </div>

                      {isOther ? (
                        /* Custom link: name input + URL */
                        <div className="flex-1 flex items-center gap-2 min-w-0">
                          <input
                            type="text"
                            value={link.displayName || ''}
                            onChange={e => updateLink(index, 'displayName', e.target.value)}
                            placeholder="Link name"
                            className="w-28 px-2 py-1.5 rounded bg-bg-primary border border-border text-text-primary placeholder-text-muted text-sm focus:outline-none focus:border-accent-primary"
                          />
                          <input
                            type="url"
                            value={link.url}
                            onChange={e => updateLink(index, 'url', e.target.value)}
                            placeholder="https://..."
                            className="flex-1 px-2 py-1.5 rounded bg-bg-primary border border-border text-text-primary placeholder-text-muted text-sm focus:outline-none focus:border-accent-primary min-w-0"
                          />
                        </div>
                      ) : (
                        /* Platform link: selector + URL */
                        <>
                          <select
                            value={link.platform}
                            onChange={e => updateLink(index, 'platform', e.target.value)}
                            className="px-2 py-1.5 rounded bg-bg-primary border border-border text-text-primary text-sm focus:outline-none focus:border-accent-primary"
                          >
                            {ALL_PLATFORMS.filter(p => p.id !== 'other').map(p => (
                              <option
                                key={p.id}
                                value={p.id}
                                disabled={usedPlatforms.has(p.id) && p.id !== link.platform}
                              >
                                {p.name}
                              </option>
                            ))}
                          </select>

                          <input
                            type="url"
                            value={link.url}
                            onChange={e => updateLink(index, 'url', e.target.value)}
                            placeholder="https://..."
                            className="flex-1 px-2 py-1.5 rounded bg-bg-primary border border-border text-text-primary placeholder-text-muted text-sm focus:outline-none focus:border-accent-primary min-w-0"
                          />
                        </>
                      )}

                      {/* Remove button */}
                      <button
                        onClick={() => removeLink(index)}
                        className="text-text-muted hover:text-red-400 transition-colors p-1"
                        title="Remove link"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>

                    {/* Streaming service warning */}
                    {streamingWarning && (
                      <p className="text-xs text-amber-400 px-3">
                        {streamingWarning}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* Save */}
          <div className="flex items-center gap-4 pt-4 border-t border-border">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-6 py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save changes'}
            </button>
            <Link
              to="/artist-dashboard"
              className="text-sm text-text-muted hover:text-text-primary transition-colors"
            >
              Cancel
            </Link>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}

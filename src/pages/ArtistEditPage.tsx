import { useState, useEffect } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { getSession } from '../services/auth';
import { sources } from '../services/sources';
import { ArtistAuthBar } from '../components/ArtistAuthBar';
import type { SourceId } from '../types';

interface LinkEntry {
  platform: string;
  url: string;
}

// All platforms available for adding
const ALL_PLATFORMS: { id: SourceId; name: string; category: string }[] = (
  Object.values(sources) as { id: SourceId; name: string; category: string }[]
).map(s => ({ id: s.id, name: s.name, category: s.category }));

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
        setBio(data.profile?.bio || '');

        // Load existing links
        const existingLinks: LinkEntry[] = (data.platforms || []).map(
          (p: { sourceId: string; url: string }) => ({
            platform: p.sourceId,
            url: p.url,
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
    setLinks([...links, { platform: available?.id || 'bandcamp', url: '' }]);
  }

  function updateLink(index: number, field: 'platform' | 'url', value: string) {
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
        setError(`Invalid URL for ${sources[link.platform as SourceId]?.name || link.platform}: ${link.url}`);
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
          links: validLinks,
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

          {/* Platform Links */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Platform Links</h2>
              <button
                onClick={addLink}
                className="text-sm text-accent-primary hover:underline"
              >
                + Add link
              </button>
            </div>

            {links.length === 0 && (
              <p className="text-text-muted text-sm py-4 text-center">
                No links yet. Click "Add link" to add your first platform.
              </p>
            )}

            <div className="space-y-2">
              {links.map((link, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 p-3 rounded-lg bg-bg-secondary border border-border"
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

                  {/* Platform selector */}
                  <select
                    value={link.platform}
                    onChange={e => updateLink(index, 'platform', e.target.value)}
                    className="px-2 py-1.5 rounded bg-bg-primary border border-border text-text-primary text-sm focus:outline-none focus:border-accent-primary"
                  >
                    {ALL_PLATFORMS.map(p => (
                      <option
                        key={p.id}
                        value={p.id}
                        disabled={usedPlatforms.has(p.id) && p.id !== link.platform}
                      >
                        {p.name}
                      </option>
                    ))}
                  </select>

                  {/* URL input */}
                  <input
                    type="url"
                    value={link.url}
                    onChange={e => updateLink(index, 'url', e.target.value)}
                    placeholder={`https://...`}
                    className="flex-1 px-2 py-1.5 rounded bg-bg-primary border border-border text-text-primary placeholder-text-muted text-sm focus:outline-none focus:border-accent-primary min-w-0"
                  />

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
              ))}
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

      <footer className="p-4 text-center text-xs text-text-muted border-t border-border">
        <Link to="/" className="hover:text-text-primary transition-colors">Unstream</Link>
        {' · '}
        <Link to="/privacy-policy" className="hover:text-text-primary transition-colors">Privacy</Link>
      </footer>
    </div>
  );
}

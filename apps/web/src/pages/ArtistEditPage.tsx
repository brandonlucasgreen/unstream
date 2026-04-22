import { useReducer, useEffect } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { sources } from '../services/sources';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import type { SourceId } from '../types';

interface LinkEntry {
  platform: string;
  url: string;
  displayName?: string;
}

// All platforms available for adding (sourced from the shared catalog).
// The "other" entry is overridden here so its dropdown label reads "Other"
// instead of the search-result label "Link".
const ALL_PLATFORMS: { id: string; name: string; category: string }[] = [
  ...(Object.values(sources) as { id: SourceId; name: string; category: string }[])
    .filter(s => s.id !== 'other')
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

// Platforms that support avatar scraping
const AVATAR_PLATFORMS = new Set(['bandcamp', 'youtube', 'mirlo']);

// Check how similar two strings are (0-1 scale, Levenshtein-based)
function stringSimilarity(a: string, b: string): number {
  const la = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lb = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (la === lb) return 1;
  if (!la || !lb) return 0;
  const longer = la.length >= lb.length ? la : lb;
  const shorter = la.length >= lb.length ? lb : la;
  const matrix: number[][] = [];
  for (let i = 0; i <= shorter.length; i++) matrix[i] = [i];
  for (let j = 0; j <= longer.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= shorter.length; i++) {
    for (let j = 1; j <= longer.length; j++) {
      matrix[i][j] = shorter[i - 1] === longer[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return 1 - matrix[shorter.length][longer.length] / longer.length;
}

function getNameChangeWarning(original: string, updated: string): 'error' | 'warn' | null {
  if (!updated.trim()) return 'error';
  if (original.toLowerCase().replace(/[^a-z0-9]/g, '') === updated.toLowerCase().replace(/[^a-z0-9]/g, '')) return null;
  const sim = stringSimilarity(original, updated);
  if (sim >= 0.7) return null;
  return 'warn';
}

interface FormState {
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  originalName: string;
  artistName: string;
  nameWarningConfirmed: boolean;
  currentSlug: string;
  newSlug: string;
  bio: string;
  featuredEmbed: string;
  imageUrl: string | null;
  customImageUrl: string | null;
  fetchingAvatar: string | null;
  links: LinkEntry[];
  city: string;
  country: string;
}

type FormAction =
  | { type: 'SET'; field: keyof FormState; value: FormState[keyof FormState] }
  | { type: 'LOAD_DATA'; data: Partial<FormState> };

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'SET':
      return { ...state, [action.field]: action.value };
    case 'LOAD_DATA':
      return { ...state, ...action.data };
  }
}

const initialFormState: FormState = {
  loading: true,
  saving: false,
  error: null,
  success: null,
  originalName: '',
  artistName: '',
  nameWarningConfirmed: false,
  currentSlug: '',
  newSlug: '',
  bio: '',
  featuredEmbed: '',
  imageUrl: null,
  customImageUrl: null,
  fetchingAvatar: null,
  links: [],
  city: '',
  country: '',
};

export function ArtistEditPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { session, isLoading: authLoading } = useAuth();
  const [form, dispatch] = useReducer(formReducer, initialFormState);

  // Convenience setters
  const set = <K extends keyof FormState>(field: K, value: FormState[K]) =>
    dispatch({ type: 'SET', field, value });

  // Load current artist data
  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      navigate('/artist-login', { replace: true });
      return;
    }
    if (!slug) return;

    async function load() {
      try {
        const response = await fetch(`/api/artist?slug=${encodeURIComponent(slug!)}`);
        if (!response.ok) {
          dispatch({ type: 'LOAD_DATA', data: { error: 'Artist not found', loading: false } });
          return;
        }

        const data = await response.json();
        const existingLinks: LinkEntry[] = (data.platforms || []).map(
          (p: { sourceId: string; url: string; displayName?: string }) => ({
            platform: p.sourceId.startsWith('other') ? 'other' : p.sourceId,
            url: p.url,
            displayName: p.displayName || '',
          })
        );

        dispatch({
          type: 'LOAD_DATA',
          data: {
            originalName: data.name || '',
            artistName: data.name || '',
            currentSlug: slug!,
            newSlug: slug!,
            imageUrl: data.imageUrl || null,
            customImageUrl: data.profile?.customImageUrl || null,
            bio: data.profile?.bio ?? '',
            featuredEmbed: data.profile?.featuredEmbed ?? '',
            links: existingLinks,
            city: data.location?.city ?? '',
            country: data.location?.country ?? data.location?.countryCode ?? '',
            loading: false,
          },
        });
      } catch {
        dispatch({ type: 'LOAD_DATA', data: { error: 'Failed to load artist data', loading: false } });
      }
    }
    load();
  }, [slug, session?.user?.id, authLoading, navigate]);

  function addLink() {
    const usedPlatforms = new Set(form.links.map(l => l.platform));
    const available = ALL_PLATFORMS.find(p => !usedPlatforms.has(p.id));
    set('links', [...form.links, { platform: available?.id || 'other', url: '', displayName: '' }]);
  }

  function addOtherLink() {
    set('links', [...form.links, { platform: 'other', url: '', displayName: '' }]);
  }

  function updateLink(index: number, field: 'platform' | 'url' | 'displayName', value: string) {
    const updated = [...form.links];
    updated[index] = { ...updated[index], [field]: value };
    set('links', updated);
  }

  function removeLink(index: number) {
    set('links', form.links.filter((_, i) => i !== index));
  }

  async function handleFetchAvatar(platform: string, url: string) {
    set('fetchingAvatar', platform);
    set('error', null);

    if (!session) {
      set('error', 'Session expired. Please sign in again.');
      set('fetchingAvatar', null);
      return;
    }

    try {
      const response = await fetch('/api/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ action: 'fetch-avatar', platform, url }),
      });

      const data = await response.json();
      if (response.ok && data.imageUrl) {
        set('customImageUrl', data.imageUrl);
      } else {
        set('error', data.error || 'Could not find a profile photo on that page');
      }
    } catch {
      set('error', 'Network error. Please try again.');
    }
    set('fetchingAvatar', null);
  }

  function moveLink(index: number, direction: -1 | 1) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= form.links.length) return;
    const updated = [...form.links];
    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    set('links', updated);
  }

  async function handleSave() {
    set('error', null);
    set('success', null);
    set('saving', true);

    if (!session) {
      set('error', 'Session expired. Please sign in again.');
      set('saving', false);
      return;
    }

    const nameLevel = getNameChangeWarning(form.originalName, form.artistName);
    if (nameLevel === 'error') {
      set('error', 'Artist name cannot be empty.');
      set('saving', false);
      return;
    }
    if (nameLevel === 'warn' && !form.nameWarningConfirmed) {
      set('error', `This is a significant name change from "${form.originalName}". Click save again to confirm.`);
      set('nameWarningConfirmed', true);
      set('saving', false);
      return;
    }

    const validLinks = form.links.filter(l => l.url.trim());
    for (const link of validLinks) {
      try {
        new URL(link.url);
      } catch {
        const name = link.platform === 'other'
          ? (link.displayName || 'Other')
          : (sources[link.platform as SourceId]?.name || link.platform);
        set('error', `Invalid URL for ${name}: ${link.url}`);
        set('saving', false);
        return;
      }
      if (link.platform === 'other' && !link.displayName?.trim()) {
        set('error', 'Please provide a name for each custom link.');
        set('saving', false);
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
          slug: form.currentSlug,
          newSlug: form.newSlug !== form.currentSlug ? form.newSlug : undefined,
          newName: form.artistName !== form.originalName ? form.artistName.trim() : undefined,
          bio: form.bio,
          featuredEmbed: form.featuredEmbed || null,
          customImageUrl: form.customImageUrl,
          location: { city: form.city, country: form.country },
          links: validLinks.map(l => ({
            platform: l.platform,
            url: l.url,
            displayName: l.displayName || undefined,
          })),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        set('error', data.error || 'Failed to save changes');
        set('saving', false);
        return;
      }

      if (form.artistName !== form.originalName) {
        set('originalName', form.artistName);
        set('nameWarningConfirmed', false);
      }
      if (data.slug !== form.currentSlug) {
        set('currentSlug', data.slug);
        set('success', 'Changes saved! Slug updated.');
        navigate(`/artist-edit/${data.slug}`, { replace: true });
      } else {
        set('success', 'Changes saved!');
      }
    } catch {
      set('error', 'Network error. Please try again.');
    }
    set('saving', false);
  }

  if (form.loading) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="text-text-muted">Loading...</div>
      </div>
    );
  }

  const usedPlatforms = new Set(form.links.map(l => l.platform));

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">

      <Header />

      <main className="flex-1 p-6">
        <div className="max-w-2xl mx-auto space-y-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">Edit {form.artistName}</h1>
              <Link
                to={`/a/${form.currentSlug}`}
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

          {form.error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {form.error}
            </div>
          )}

          {form.success && (
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
              {form.success}
            </div>
          )}

          {/* Artist Name */}
          <section className="space-y-2">
            <label htmlFor="name" className="block text-sm font-medium">
              Artist Name
            </label>
            <input
              id="name"
              type="text"
              value={form.artistName}
              onChange={e => {
                set('artistName', e.target.value);
                set('nameWarningConfirmed', false);
              }}
              className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary focus:outline-none focus:border-accent-primary"
            />
            {form.artistName !== form.originalName && (() => {
              const level = getNameChangeWarning(form.originalName, form.artistName);
              if (level === 'error') {
                return <p className="text-xs text-red-400">Artist name cannot be empty.</p>;
              }
              if (level === 'warn') {
                return <p className="text-xs text-amber-400">This is a significant change from "{form.originalName}". You'll be asked to confirm when saving.</p>;
              }
              return <p className="text-xs text-text-muted">Name will be updated from "{form.originalName}".</p>;
            })()}
          </section>

          {/* Profile Photo */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium">Profile Photo</h2>
            <div className="flex items-start gap-4">
              {(form.customImageUrl || form.imageUrl) ? (
                <img
                  src={form.customImageUrl || form.imageUrl || ''}
                  alt={form.artistName}
                  className="w-20 h-20 rounded-full object-cover border border-border"
                />
              ) : (
                <div className="w-20 h-20 rounded-full bg-bg-secondary border border-border flex items-center justify-center text-text-muted text-2xl">
                  {form.artistName.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex-1 space-y-2">
                <p className="text-xs text-text-muted">
                  Pull a photo from one of your linked platforms, or it will use the default from your search results.
                </p>
                <div className="flex flex-wrap gap-2">
                  {form.links
                    .filter(l => AVATAR_PLATFORMS.has(l.platform) && l.url.trim())
                    .map(l => {
                      const platformLabel = ALL_PLATFORMS.find(p => p.id === l.platform)?.name || l.platform;
                      return (
                        <button
                          key={l.platform}
                          onClick={() => handleFetchAvatar(l.platform, l.url)}
                          disabled={form.fetchingAvatar !== null}
                          className="px-3 py-1.5 rounded-lg bg-bg-secondary border border-border text-sm text-text-muted hover:text-text-primary hover:border-border-hover transition-colors disabled:opacity-50"
                        >
                          {form.fetchingAvatar === l.platform ? 'Loading...' : `Use ${platformLabel} photo`}
                        </button>
                      );
                    })}
                  {form.links.filter(l => AVATAR_PLATFORMS.has(l.platform) && l.url.trim()).length === 0 && (
                    <p className="text-xs text-text-muted">
                      Add a Bandcamp, YouTube, or Mirlo link to pull a photo from that platform.
                    </p>
                  )}
                </div>
                {form.customImageUrl && (
                  <button
                    onClick={() => set('customImageUrl', null)}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    Remove custom photo
                  </button>
                )}
              </div>
            </div>
          </section>

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
                value={form.newSlug}
                onChange={e => set('newSlug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                className="flex-1 px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary focus:outline-none focus:border-accent-primary"
              />
            </div>
            {form.newSlug !== form.currentSlug && (
              <p className="text-xs text-amber-400">
                Changing your slug will update your profile URL. Old links will stop working.
              </p>
            )}
          </section>

          {/* Bio */}
          <section className="space-y-2">
            <label htmlFor="bio" className="block text-sm font-medium">
              Bio <span className="text-text-muted font-normal">({form.bio.length}/500)</span>
            </label>
            <textarea
              id="bio"
              value={form.bio}
              onChange={e => set('bio', e.target.value.slice(0, 500))}
              rows={3}
              placeholder="Tell fans about your music..."
              className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary resize-none"
            />
          </section>

          {/* Location */}
          <section className="space-y-2">
            <label className="block text-sm font-medium">Location</label>
            <p className="text-xs text-text-muted">
              Helps fans find you and disambiguates you from other artists with the same name.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                id="city"
                type="text"
                value={form.city}
                onChange={e => set('city', e.target.value.slice(0, 100))}
                placeholder="City"
                aria-label="City"
                className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
              />
              <input
                id="country"
                type="text"
                value={form.country}
                onChange={e => set('country', e.target.value.slice(0, 100))}
                placeholder="Country"
                aria-label="Country"
                className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
              />
            </div>
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
              value={form.featuredEmbed}
              onChange={e => set('featuredEmbed', e.target.value)}
              rows={3}
              placeholder='<iframe style="border: 0; width: 100%; height: 120px;" src="https://bandcamp.com/EmbeddedPlayer/..." seamless></iframe>'
              className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary resize-none font-mono text-xs"
            />
            {form.featuredEmbed && (
              <div className="space-y-2">
                <p className="text-xs text-text-muted">Preview:</p>
                <div
                  className="rounded-lg overflow-hidden border border-border"
                  dangerouslySetInnerHTML={{ __html: form.featuredEmbed }}
                />
                <button
                  onClick={() => set('featuredEmbed', '')}
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

            {form.links.length === 0 && (
              <p className="text-text-muted text-sm py-4 text-center">
                No links yet. Click "Add platform" to add your first link.
              </p>
            )}

            <div className="space-y-2">
              {form.links.map((link, index) => {
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
                          disabled={index === form.links.length - 1}
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
              disabled={form.saving}
              className="px-6 py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
            >
              {form.saving ? 'Saving...' : 'Save changes'}
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

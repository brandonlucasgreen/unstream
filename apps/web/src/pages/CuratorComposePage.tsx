import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';

/**
 * Compose a post that tags the artists a curator is championing
 * (docs/specs/curator-posts-spec.md).
 *
 * Open to any signed-in curator who has connected their own Buffer account, behind the
 * `curatorPosts` flag. The server rebuilds every fact — handles, payouts, links, cards — from
 * the artist slugs this page sends, so nothing here is trusted: what the page controls is
 * *which* artists and *what the curator wrote*, and nothing else.
 */

const NETWORKS = ['instagram', 'facebook'] as const;
type Network = (typeof NETWORKS)[number];

const NETWORK_LABEL: Record<Network, string> = { instagram: 'Instagram', facebook: 'Facebook' };

const DEFAULT_TEMPLATE = {
  postText: "Tonight on {show}:\n\n{artists}\n\nBuy their music, don't just stream it: {link}",
  lineText: '{artist} – {release}',
};

interface Suggestion { slug: string; name: string; imageUrl: string | null }
interface Mention { slug: string; name: string; imageUrl: string | null }

interface PreviewArtist {
  slug: string;
  name: string;
  release: string | null;
  payout: string | null;
  platform: string | null;
  handles: Record<Network, string | null>;
}

interface NetworkPreview {
  caption: string;
  tags: { handle: string; x: number; y: number }[];
  untagged: string[];
  problem: string | null;
}

interface BufferChannelInfo { id: string; name: string; service: string; supported: boolean }

interface BufferConnectionState {
  available: boolean;
  connected: boolean;
  channels?: BufferChannelInfo[];
  selectedChannelIds?: string[];
  reason?: string;
}

/** What the OAuth callback tells us by sending the curator back with ?buffer=… */
const RETURN_MESSAGES: Record<string, string> = {
  cancelled: 'Buffer connection cancelled.',
  failed: 'Buffer couldn’t be connected. Try again.',
  expired: 'That connection attempt timed out. Try again.',
  unavailable: 'Curator posts aren’t switched on yet.',
};

interface PreviewResponse {
  available?: boolean;
  networks?: Record<Network, NetworkPreview>;
  artists?: PreviewArtist[];
  missing?: string[];
  tooManyForOneCarousel?: boolean;
}

export function CuratorComposePage() {
  const { session } = useAuth();
  const navigate = useNavigate();

  const [mentions, setMentions] = useState<Mention[]>([]);
  const [showName, setShowName] = useState('');
  const [curatorHandle, setCuratorHandle] = useState('');
  const [postText, setPostText] = useState(DEFAULT_TEMPLATE.postText);
  const [lineText, setLineText] = useState(DEFAULT_TEMPLATE.lineText);
  const [typedHandles, setTypedHandles] = useState<Record<string, string>>({});

  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [network, setNetwork] = useState<Network>('instagram');
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [captionOpen, setCaptionOpen] = useState(false);
  const [connection, setConnection] = useState<BufferConnectionState | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ results: Record<string, { postId?: string; error?: string }>; draft: boolean } | null>(null);

  const token = session?.access_token;

  const post = useCallback(async (action: string, body: unknown) => {
    const path = action.startsWith('me/') ? `/api/${action}` : `/api/curator/${action}`;
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
    return data;
  }, [token]);

  /** What the server needs to rebuild the post. Sent as-is by preview, cards and send. */
  const composeBody = useMemo(() => ({
    artists: mentions.map(m => ({ slug: m.slug })),
    template: { postText, lineText, hashtags: [] },
    curator: { showName: showName.trim() || null, handles: { instagram: curatorHandle.trim() || null } },
    handles: Object.fromEntries(Object.entries(typedHandles)
      .filter(([, h]) => h.trim())
      .map(([slug, h]) => [slug, { instagram: h.trim() }])),
  }), [mentions, postText, lineText, showName, curatorHandle, typedHandles]);

  // --- The Buffer connection ------------------------------------------------------------------

  const loadConnection = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch('/api/me/buffer', { headers: { Authorization: `Bearer ${token}` } });
      setConnection(await response.json());
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'curator.connection' } });
      setConnection({ available: true, connected: false, reason: 'Could not read your Buffer connection.' });
    }
  }, [token]);

  useEffect(() => { loadConnection(); }, [loadConnection]);

  // The callback redirects back here with the outcome; say it once, then take it out of the URL
  // so a reload doesn't repeat it.
  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get('buffer');
    if (!outcome) return;
    if (outcome !== 'connected') setError(RETURN_MESSAGES[outcome] ?? 'Buffer couldn’t be connected.');
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const { authorizeUrl } = await post('me/buffer/start', {});
      window.location.assign(authorizeUrl);
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'curator.connect' } });
      setError(err instanceof Error ? err.message : 'Could not start the Buffer connection.');
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await fetch('/api/me/buffer', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      setConnection({ available: true, connected: false });
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'curator.disconnect' } });
    }
  };

  // --- Typeahead -----------------------------------------------------------------------------

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) { setSuggestions([]); return; }
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/suggest?q=${encodeURIComponent(term)}`);
        const data = await response.json();
        setSuggestions((data.artists ?? []).slice(0, 6));
      } catch {
        setSuggestions([]);   // A typeahead that can't reach the server simply offers nothing.
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  // --- Preview, on a debounce ----------------------------------------------------------------

  useEffect(() => {
    if (mentions.length === 0) { setPreview(null); return; }
    const timer = setTimeout(async () => {
      try {
        setPreview(await post('preview', composeBody));
        setError(null);
      } catch (err) {
        Sentry.captureException(err, { extra: { context: 'curator.preview' } });
        setError(err instanceof Error ? err.message : 'Could not render the preview.');
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [composeBody, mentions.length, post]);

  // --- The cover card ------------------------------------------------------------------------
  //
  // Keyed on the facts the card draws from, not the caption: editing the wording redraws
  // nothing, which matters because a card is ~130ms of CPU on the server.

  const coverKey = useMemo(
    () => JSON.stringify([mentions.map(m => m.slug), showName.trim(), curatorHandle.trim(), typedHandles]),
    [mentions, showName, curatorHandle, typedHandles],
  );
  const drawnKey = useRef<string | null>(null);

  useEffect(() => {
    if (mentions.length === 0) { setCoverUrl(null); drawnKey.current = null; return; }
    if (drawnKey.current === coverKey) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        setBusy('Drawing the cover card…');
        const data = await post('cards', { ...composeBody, slide: 'cover' });
        if (cancelled) return;
        drawnKey.current = coverKey;
        setCoverUrl(data.url);
      } catch (err) {
        if (!cancelled) {
          Sentry.captureException(err, { extra: { context: 'curator.coverCard' } });
          setError(err instanceof Error ? err.message : 'Could not draw the cover card.');
        }
      } finally {
        if (!cancelled) setBusy(null);
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [coverKey, composeBody, mentions.length, post]);

  // --- Actions -------------------------------------------------------------------------------

  const addMention = (s: Suggestion) => {
    setMentions(prev => prev.some(m => m.slug === s.slug) ? prev : [...prev, s]);
    setQuery('');
    setSuggestions([]);
  };

  const removeMention = (slug: string) => setMentions(prev => prev.filter(m => m.slug !== slug));

  /**
   * Draw every card, then send.
   *
   * The artist cards are drawn here rather than during preview: only the cover is shown, so
   * drawing the rest earlier would spend server CPU on images nobody looks at.
   */
  const handleSend = async (mode: 'draft' | 'now') => {
    setError(null);
    setSent(null);
    try {
      setBusy('Drawing cards…');
      const cardUrls: string[] = [];
      const cover = await post('cards', { ...composeBody, slide: 'cover' });
      cardUrls.push(cover.url);
      for (const mention of mentions.slice(0, 9)) {
        const card = await post('cards', { ...composeBody, slide: 'curator-artist', artistSlug: mention.slug });
        cardUrls.push(card.url);
      }

      setBusy(mode === 'now' ? 'Sending…' : 'Saving the draft…');
      const result = await post('send', { ...composeBody, cardUrls, mode });
      setSent({ results: result.results, draft: result.draft });
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'curator.send' } });
      setError(err instanceof Error ? err.message : 'Could not send the post.');
    } finally {
      setBusy(null);
    }
  };

  // --- Render --------------------------------------------------------------------------------

  if (!session) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-text-muted">Sign in to post about the artists you champion.</p>
        <button onClick={() => navigate('/login?next=/curator/new')} className="text-link hover:underline">Sign in</button>
      </div>
    );
  }

  // The flag fails closed, so "not available" is the normal state until it is switched on.
  if (connection && !connection.available) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-text-muted">Curator posts aren’t switched on yet.</p>
        <button onClick={() => navigate('/')} className="text-link hover:underline">Back to search</button>
      </div>
    );
  }

  if (connection && !connection.connected) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="max-w-xl mx-auto px-4 py-12 space-y-4">
          <h1 className="font-display text-2xl font-bold text-text-primary">Connect Buffer</h1>
          <p className="text-text-secondary text-sm">
            Unstream posts to your own Instagram and Facebook through Buffer. You’ll approve the
            connection in Buffer, and can disconnect any time.
          </p>
          {connection.reason && <p className="text-text-muted text-sm">{connection.reason}</p>}
          {error && <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-error text-sm">{error}</div>}
          <button onClick={handleConnect} disabled={connecting}
            className="px-4 py-2 rounded-lg bg-accent text-black font-medium text-sm disabled:opacity-50">
            {connecting ? 'Opening Buffer…' : 'Connect Buffer'}
          </button>
        </div>
      </div>
    );
  }

  const current = preview?.networks?.[network];
  const bySlug = new Map((preview?.artists ?? []).map(a => [a.slug, a]));
  const supportedChannels = (connection?.channels ?? []).filter(c => c.supported);

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="font-display text-2xl font-bold text-text-primary">Curator post</h1>
          <p className="text-text-secondary text-sm">
            Posting to {supportedChannels.map(c => c.name).join(' and ') || 'your Buffer channels'}
            {' · '}
            <button onClick={handleDisconnect} className="text-link hover:underline">disconnect</button>
          </p>
        </div>

        {supportedChannels.length === 0 && connection && (
          <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm text-text-secondary">
            Your Buffer account has no Instagram or Facebook channel connected. Add one in Buffer,
            then reload.
          </div>
        )}
        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-error text-sm">{error}</div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Left: who's on the post */}
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="block text-text-secondary mb-1">Your show or label</span>
                <input value={showName} onChange={e => setShowName(e.target.value)} placeholder="Night Shift"
                  className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-text-primary" />
              </label>
              <label className="text-sm">
                <span className="block text-text-secondary mb-1">Your Instagram handle</span>
                <input value={curatorHandle} onChange={e => setCuratorHandle(e.target.value)} placeholder="nightshift"
                  className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-text-primary" />
              </label>
            </div>

            <div className="relative">
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Add an artist…"
                className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-text-primary" />
              {suggestions.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full rounded-lg bg-surface border border-border overflow-hidden">
                  {suggestions.map(s => (
                    <li key={s.slug}>
                      <button onClick={() => addMention(s)} className="w-full text-left px-3 py-2 hover:bg-white/5 text-text-primary text-sm">
                        {s.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {mentions.length === 0 ? (
              <p className="text-text-muted text-sm">No artists yet. Search above to add the ones you’re playing.</p>
            ) : (
              <ul className="space-y-2">
                {mentions.map(mention => {
                  const info = bySlug.get(mention.slug);
                  const igHandle = info?.handles.instagram ?? null;
                  return (
                    <li key={mention.slug} className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-border">
                      {mention.imageUrl
                        ? <img src={mention.imageUrl} alt="" className="w-10 h-10 rounded object-cover" />
                        : <div className="w-10 h-10 rounded bg-white/5" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-text-primary text-sm truncate">{mention.name}</p>
                        <p className="text-text-muted text-xs truncate">
                          {info?.release ?? 'No release we hold'}
                          {info?.payout && info.platform ? ` · ${info.payout} on ${info.platform}` : ''}
                        </p>
                      </div>

                      {/* Instagram is the only network that tags, so it is the only circle that
                          promises one. Facebook just says whether we hold their page. */}
                      <span title={igHandle ? `Tagged as @${igHandle}` : 'No Instagram handle'}
                        className={`text-xs px-2 py-1 rounded-full border ${igHandle ? 'border-accent text-accent' : 'border-dashed border-amber-500/60 text-amber-500'}`}>
                        IG
                      </span>
                      <span title={info?.handles.facebook ? 'We have their Facebook page (not a tag)' : 'No Facebook page'}
                        className={`text-xs px-2 py-1 rounded-full border ${info?.handles.facebook ? 'border-border text-text-secondary' : 'border-dashed border-border text-text-muted'}`}>
                        FB
                      </span>

                      <button onClick={() => removeMention(mention.slug)} className="text-text-muted hover:text-error text-sm px-1" aria-label={`Remove ${mention.name}`}>✕</button>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* A handle the curator types is used for this post only and never stored on the
                artist, because a handle typed by a stranger is unverified. */}
            {mentions.filter(m => bySlug.get(m.slug) && !bySlug.get(m.slug)!.handles.instagram).map(m => (
              <label key={m.slug} className="block text-sm">
                <span className="block text-text-secondary mb-1">{m.name} — add their Instagram handle</span>
                <input value={typedHandles[m.slug] ?? ''} onChange={e => setTypedHandles(prev => ({ ...prev, [m.slug]: e.target.value }))}
                  placeholder="handle, without the @"
                  className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-text-primary" />
              </label>
            ))}

            {preview?.tooManyForOneCarousel && (
              <p className="text-amber-500 text-sm">
                More than nine artists. Instagram takes ten images, so only the first nine get a card.
              </p>
            )}
            {preview?.missing && preview.missing.length > 0 && (
              <p className="text-text-muted text-sm">Not found: {preview.missing.join(', ')}</p>
            )}
          </div>

          {/* Right: what gets posted */}
          <div className="space-y-4">
            <div className="flex gap-2">
              {NETWORKS.map(n => (
                <button key={n} onClick={() => setNetwork(n)}
                  className={`px-3 py-1.5 rounded-lg text-sm border ${network === n ? 'border-accent text-accent' : 'border-border text-text-secondary'}`}>
                  {NETWORK_LABEL[n]}
                </button>
              ))}
            </div>

            {network === 'instagram' && (
              coverUrl
                ? <img src={coverUrl} alt="The cover card as it will be posted" className="w-full max-w-sm rounded-lg border border-border" />
                : <div className="w-full max-w-sm aspect-[4/5] rounded-lg border border-dashed border-border flex items-center justify-center text-text-muted text-sm">
                    {busy ?? 'The cover card appears here'}
                  </div>
            )}

            {current && (
              <div className="p-3 rounded-lg bg-surface border border-border">
                <button onClick={() => setCaptionOpen(o => !o)} className="w-full text-left text-text-primary text-sm">
                  {captionOpen ? 'Caption ▾' : `${current.caption.split('\n')[0].slice(0, 60)}… ▸`}
                </button>
                {captionOpen && <pre className="mt-2 whitespace-pre-wrap text-text-secondary text-sm font-sans">{current.caption}</pre>}
                <p className="mt-2 text-text-muted text-xs">
                  {current.caption.length} characters
                  {network === 'instagram' && current.tags.length > 0 && ` · tagging ${current.tags.length}`}
                  {current.untagged.length > 0 && network === 'instagram' && ` · ${current.untagged.length} untagged`}
                </p>
                {current.problem && <p className="mt-2 text-error text-sm">{current.problem}</p>}
              </div>
            )}

            <details className="text-sm">
              <summary className="text-text-secondary cursor-pointer">Edit the template</summary>
              <div className="mt-2 space-y-2">
                <textarea value={postText} onChange={e => setPostText(e.target.value)} rows={5}
                  className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-text-primary font-mono text-xs" />
                <input value={lineText} onChange={e => setLineText(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-text-primary font-mono text-xs" />
                <p className="text-text-muted text-xs">
                  {'{show} {artists} {link}'} in the post · {'{artist} {release} {payout} {location}'} in each line
                </p>
              </div>
            </details>

            <div className="flex gap-2">
              <button onClick={() => handleSend('draft')} disabled={!!busy || mentions.length === 0 || !!current?.problem}
                className="px-4 py-2 rounded-lg bg-accent text-black font-medium text-sm disabled:opacity-50">
                {busy ?? 'Save as Buffer draft'}
              </button>
              <button onClick={() => handleSend('now')} disabled={!!busy || mentions.length === 0 || !!current?.problem}
                className="px-4 py-2 rounded-lg border border-border text-text-secondary text-sm disabled:opacity-50">
                Share now
              </button>
            </div>

            {sent && (
              <div className="p-3 rounded-lg bg-surface border border-border text-sm space-y-1">
                <p className="text-text-primary">{sent.draft ? 'Saved to Buffer as drafts.' : 'Sent.'}</p>
                {NETWORKS.map(n => sent.results[n] && (
                  <p key={n} className={sent.results[n].error ? 'text-error' : 'text-text-secondary'}>
                    {NETWORK_LABEL[n]}: {sent.results[n].error ?? sent.results[n].postId}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

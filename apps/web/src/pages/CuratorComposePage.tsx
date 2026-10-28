import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';
import { SuggestionList } from '../components/SuggestionList';
import { useArtistSuggestions, type ArtistSuggestion } from '../hooks/useArtistSuggestions';

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

type Mention = ArtistSuggestion;

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
interface BufferOrganizationInfo { id: string; name: string }

interface BufferConnectionState {
  available: boolean;
  connected: boolean;
  /** Every organization the Buffer account belongs to. */
  organizations?: BufferOrganizationInfo[];
  /** Null until the curator picks one; nothing can post before that. */
  organizationId?: string | null;
  channels?: BufferChannelInfo[];
  selectedChannelIds?: string[];
  reason?: string;
}

interface ChannelResult { service: string; name: string; postId?: string; error?: string }

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
  const [postText, setPostText] = useState(DEFAULT_TEMPLATE.postText);
  const [lineText, setLineText] = useState(DEFAULT_TEMPLATE.lineText);
  const [typedHandles, setTypedHandles] = useState<Record<string, string>>({});

  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [network, setNetwork] = useState<Network>('instagram');
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [captionOpen, setCaptionOpen] = useState(false);
  const [connection, setConnection] = useState<BufferConnectionState | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [choosingOrganization, setChoosingOrganization] = useState(false);
  const [pickedOrganization, setPickedOrganization] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ results: Record<string, ChannelResult>; draft: boolean } | null>(null);

  const token = session?.access_token;

  // The channels the curator ticked, as Buffer still lists them. The first Instagram one signs
  // the cards ("via @…"): its name in Buffer is the account's handle, so nobody types it.
  const tickedChannels = useMemo(() => {
    const ticked = new Set(connection?.selectedChannelIds ?? []);
    return (connection?.channels ?? []).filter(c => c.supported && ticked.has(c.id));
  }, [connection]);
  const curatorHandle = tickedChannels.find(c => c.service === 'instagram')?.name ?? '';

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
    curator: { showName: showName.trim() || null, handles: { instagram: curatorHandle || null } },
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

  const handleChooseOrganization = async (organizationId: string) => {
    setError(null);
    try {
      await post('me/buffer/organization', { organizationId });
      setChoosingOrganization(false);
      setPickedOrganization(null);
      await loadConnection();
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'curator.organization' } });
      setError(err instanceof Error ? err.message : 'Could not switch organization.');
    }
  };

  /** Tick or untick a channel. Shown at once, and the server's answer is what stays. */
  const toggleChannel = async (channelId: string) => {
    const current = connection?.selectedChannelIds ?? [];
    const next = current.includes(channelId) ? current.filter(id => id !== channelId) : [...current, channelId];
    setConnection(prev => prev && { ...prev, selectedChannelIds: next });
    try {
      const { selectedChannelIds } = await post('me/buffer/channels', { channelIds: next });
      setConnection(prev => prev && { ...prev, selectedChannelIds });
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'curator.channels' } });
      setError(err instanceof Error ? err.message : 'Could not save your channels.');
      setConnection(prev => prev && { ...prev, selectedChannelIds: current });
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
  //
  // The site's own (useArtistSuggestions), so it searches what the header search does. Picking
  // adds the artist to the post instead of running a search.

  const addMention = useCallback((s: ArtistSuggestion) => {
    setMentions(prev => prev.some(m => m.slug === s.slug) ? prev : [...prev, s]);
    setQuery('');
  }, []);

  const suggest = useArtistSuggestions(addMention);

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
    () => JSON.stringify([mentions.map(m => m.slug), showName.trim(), curatorHandle, typedHandles]),
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
            className="px-4 py-2 rounded-lg bg-accent-primary text-accent-foreground font-medium text-sm hover:bg-accent-primary/90 transition-colors disabled:opacity-50">
            {connecting ? 'Opening Buffer…' : 'Connect Buffer'}
          </button>
        </div>
      </div>
    );
  }

  const organizations = connection?.organizations ?? [];
  const organizationName = organizations.find(o => o.id === connection?.organizationId)?.name;

  // Every channel and post belongs to one organization, so with none chosen there is nothing
  // else to show. A Buffer account in several gets asked rather than given the first: the first
  // was somebody else's workspace often enough to post in the wrong place.
  if (connection?.connected && (!connection.organizationId || choosingOrganization)) {
    const picked = pickedOrganization ?? connection.organizationId ?? null;
    const cancelSwitch = () => { setChoosingOrganization(false); setPickedOrganization(null); };
    return (
      <div className="min-h-screen">
        <Header />
        <div className="max-w-xl mx-auto px-4 py-12 space-y-4">
          <h1 className="font-display text-2xl font-bold text-text-primary">Choose a Buffer organization</h1>
          {organizations.length === 0 ? (
            <p className="text-text-secondary text-sm">
              Your Buffer account isn’t part of any organization, so there’s nowhere to post.
            </p>
          ) : (
            <>
              <p className="text-text-secondary text-sm">
                Your Buffer account belongs to more than one organization. Unstream posts through the
                one you choose, to the channels you tick in it. You can change this later.
              </p>
              <fieldset className="space-y-2">
                <legend className="sr-only">Buffer organization</legend>
                {organizations.map(o => (
                  <label key={o.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer text-sm transition-colors ${picked === o.id ? 'border-accent-primary text-text-primary' : 'border-border text-text-secondary hover:border-text-muted'}`}>
                    <input type="radio" name="organization" value={o.id} checked={picked === o.id}
                      onChange={() => setPickedOrganization(o.id)} className="accent-accent-primary" />
                    {o.name}
                  </label>
                ))}
              </fieldset>
            </>
          )}
          {error && <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-error text-sm">{error}</div>}
          <div className="flex gap-2">
            {organizations.length > 0 && (
              <button disabled={!picked}
                // Re-choosing the current one would clear its ticked channels for nothing.
                onClick={() => picked === connection.organizationId ? cancelSwitch() : picked && handleChooseOrganization(picked)}
                className="px-4 py-2 rounded-lg bg-accent-primary text-accent-foreground font-medium text-sm hover:bg-accent-primary/90 transition-colors disabled:opacity-50">
                Continue
              </button>
            )}
            {choosingOrganization && connection.organizationId ? (
              <button onClick={cancelSwitch} className="px-4 py-2 rounded-lg border border-border text-text-secondary text-sm">Cancel</button>
            ) : (
              <button onClick={handleDisconnect} className="px-4 py-2 rounded-lg border border-border text-text-secondary text-sm">Disconnect Buffer</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const bySlug = new Map((preview?.artists ?? []).map(a => [a.slug, a]));
  const supportedChannels = (connection?.channels ?? []).filter(c => c.supported);
  const unsupportedCount = (connection?.channels ?? []).length - supportedChannels.length;
  const ticked = new Set(connection?.selectedChannelIds ?? []);

  // A tab for each network the post is going to; both while nothing is ticked, so the preview
  // still has something to show.
  const tickedNetworks = NETWORKS.filter(n => tickedChannels.some(c => c.service === n));
  const tabs = tickedNetworks.length > 0 ? tickedNetworks : [...NETWORKS];
  const shown: Network = tabs.includes(network) ? network : tabs[0];
  const current = preview?.networks?.[shown];
  const cannotSend = !!busy || mentions.length === 0 || tickedChannels.length === 0 || !!current?.problem;

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="font-display text-2xl font-bold text-text-primary">Curator post</h1>
          <p className="text-text-secondary text-sm">
            Buffer: {organizationName}
            {organizations.length > 1 && (
              <>{' · '}<button onClick={() => setChoosingOrganization(true)} className="text-link hover:underline">change</button></>
            )}
            {' · '}
            <button onClick={handleDisconnect} className="text-link hover:underline">disconnect</button>
          </p>
        </div>

        <section className="space-y-2" aria-labelledby="curator-post-to">
          <h2 id="curator-post-to" className="text-sm text-text-secondary">Post to</h2>
          {supportedChannels.length === 0 ? (
            <div className="p-3 rounded-lg bg-warning/10 border border-warning/30 text-sm text-text-secondary">
              {organizationName ?? 'This organization'} has no Instagram or Facebook channel in Buffer.
              Add one there, then reload.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {supportedChannels.map(c => {
                const on = ticked.has(c.id);
                return (
                  <label key={c.id}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm cursor-pointer transition-colors ${on ? 'border-accent-primary text-text-primary' : 'border-border text-text-secondary hover:border-text-muted'}`}>
                    <input type="checkbox" checked={on} onChange={() => toggleChannel(c.id)} className="accent-accent-primary" />
                    <span className="text-text-muted">{NETWORK_LABEL[c.service as Network]}</span>
                    {c.service === 'instagram' ? `@${c.name}` : c.name}
                  </label>
                );
              })}
            </div>
          )}
          {unsupportedCount > 0 && (
            <p className="text-text-muted text-xs">
              Curator posts are made for Instagram and Facebook, so your other {unsupportedCount} Buffer
              {unsupportedCount === 1 ? ' channel isn’t' : ' channels aren’t'} listed.
            </p>
          )}
        </section>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-error text-sm">{error}</div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Left: who's on the post */}
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="block text-text-secondary mb-1">Your show or label</span>
              <input value={showName} onChange={e => setShowName(e.target.value)} placeholder="Night Shift"
                className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-text-primary" />
            </label>

            <div className="relative">
              <input value={query}
                onChange={e => { setQuery(e.target.value); suggest.query(e.target.value); }}
                onKeyDown={suggest.handleKeyDown}
                onFocus={() => suggest.reopen(query)}
                onBlur={suggest.close}
                placeholder="Add an artist…"
                aria-label="Add an artist"
                role="combobox"
                aria-expanded={suggest.isOpen}
                aria-controls="curator-artist-suggestions"
                aria-activedescendant={suggest.highlightIndex >= 0 ? `curator-artist-suggestion-${suggest.highlightIndex}` : undefined}
                aria-autocomplete="list"
                className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:border-accent-primary transition-colors" />
              {suggest.isOpen && (
                <SuggestionList
                  idPrefix="curator-artist"
                  suggestions={suggest.suggestions}
                  highlightIndex={suggest.highlightIndex}
                  onHighlight={suggest.setHighlightIndex}
                  onPick={suggest.pick}
                />
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
                        className={`text-xs px-2 py-1 rounded-full border ${igHandle ? 'border-accent-primary text-link' : 'border-dashed border-warning/60 text-warning'}`}>
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
              <p className="text-warning text-sm">
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
              {tabs.map(n => (
                <button key={n} onClick={() => setNetwork(n)}
                  className={`px-3 py-1.5 rounded-lg text-sm border ${shown === n ? 'border-accent-primary text-link' : 'border-border text-text-secondary'}`}>
                  {NETWORK_LABEL[n]}
                </button>
              ))}
            </div>

            {shown === 'instagram' && (
              coverUrl
                ? <img src={coverUrl} alt="The cover card as it will be posted" className="w-full max-w-sm rounded-lg border border-border" />
                : <div className="w-full max-w-sm aspect-[4/5] rounded-lg border border-dashed border-border flex items-center justify-center text-text-muted text-sm">
                    {busy ?? 'The cover card appears here'}
                  </div>
            )}
            {shown === 'instagram' && curatorHandle && (
              <p className="text-text-muted text-xs">Cards are signed @{curatorHandle}, your first ticked Instagram account.</p>
            )}

            {current && (
              <div className="p-3 rounded-lg bg-surface border border-border">
                <button onClick={() => setCaptionOpen(o => !o)} className="w-full text-left text-text-primary text-sm">
                  {captionOpen ? 'Caption ▾' : `${current.caption.split('\n')[0].slice(0, 60)}… ▸`}
                </button>
                {captionOpen && <pre className="mt-2 whitespace-pre-wrap text-text-secondary text-sm font-sans">{current.caption}</pre>}
                <p className="mt-2 text-text-muted text-xs">
                  {current.caption.length} characters
                  {shown === 'instagram' && current.tags.length > 0 && ` · tagging ${current.tags.length}`}
                  {current.untagged.length > 0 && shown === 'instagram' && ` · ${current.untagged.length} untagged`}
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

            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => handleSend('draft')} disabled={cannotSend}
                className="px-4 py-2 rounded-lg bg-accent-primary text-accent-foreground font-medium text-sm hover:bg-accent-primary/90 transition-colors disabled:opacity-50">
                {busy ?? 'Save as Buffer draft'}
              </button>
              <button onClick={() => handleSend('now')} disabled={cannotSend}
                className="px-4 py-2 rounded-lg border border-border text-text-secondary text-sm disabled:opacity-50">
                Share now
              </button>
              {tickedChannels.length === 0 && supportedChannels.length > 0 && (
                <span className="text-text-muted text-xs">Tick a channel under “Post to” first.</span>
              )}
            </div>

            {sent && (
              <div className="p-3 rounded-lg bg-surface border border-border text-sm space-y-1">
                <p className="text-text-primary">{sent.draft ? 'Saved to Buffer as drafts.' : 'Sent.'}</p>
                {Object.entries(sent.results).map(([id, r]) => (
                  <p key={id} className={r.error ? 'text-error' : 'text-text-secondary'}>
                    {NETWORK_LABEL[r.service as Network] ?? r.service} {r.service === 'instagram' ? `@${r.name}` : r.name}:{' '}
                    {r.error ?? (sent.draft ? 'draft saved' : 'sent')}
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

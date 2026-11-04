import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { TabSkeleton, useReportArtistName } from './ArtistSettingsLayout';
import { CampaignEditor, type ImageChoice } from '../components/CampaignEditor';
import { PromoteBufferChannels, PromoteChannelPicker } from '../components/PromoteBufferChannels';
import { networkName } from '../../../../api/shared/autopost-networks';
import { addDays } from '../../../../api/shared/calendar-dates';
import { BUFFER_OUTCOMES } from '../data/buffer';
import { DEFAULT_RUN_WEEKS, DEFAULT_RUNWAY_WEEKS, RUN_WEEKS, RUNWAY_WEEKS } from '../../../../api/shared/campaign-steps';
import {
  campaignOverlay,
  cancelCampaign,
  getCampaignsPage,
  PromoteApiError,
  proposeCampaign,
  saveCampaign,
  startBufferConnection,
  type AutopostDay,
  type CampaignPostDraft,
  type CampaignsPage,
} from '../services/promote';

// /promote/:slug/campaigns — release campaigns, a tab of the Promote page
// (docs/specs/release-autopost-spec.md, "Release campaigns"; Brandon, 2026-11-02).
//
// The artist picks a release and confirms its date. Before release they choose how far ahead to
// start; once it's out, how long to keep going from tomorrow (Brandon, 2026-11-03: a countdown
// made no sense for a release already out). Unstream proposes a timeline of posts from
// best-practice steps, written in the artist's voice from templates (no LLM), and shows where
// autopost's posts fall around them. Autopost steps aside on campaign days
// and the day either side, so no network gets two posts on a day. Nothing is scheduled until the
// artist presses Schedule; posts then go to Buffer 72 hours ahead, as autopost's do.
//
// **Each campaign picks its own channels** (Brandon, 2026-11-03): a launch may want Instagram and
// TikTok where the weekly rhythm only wants Bluesky. Only the Buffer connection and organization
// are shared with autopost, and both can be set up here, so an artist who comes to Campaigns
// first never has to open the Autopost tab.

type Loaded = Extract<CampaignsPage, { available: true }>;

/** The campaign being planned or edited. `id` is null until it's scheduled. */
interface Draft {
  id: string | null;
  releaseId: string;
  releaseDate: string;
  /** This campaign's own Buffer channels, not autopost's. */
  channelIds: string[];
  /** Counts down to release day, rather than running from after it (see CampaignEditor). */
  anchoredToRelease: boolean;
  posts: CampaignPostDraft[];
  autopost: AutopostDay[];
}

const SECTION = 'space-y-3 rounded-xl border border-border bg-bg-secondary/40 p-4';
const PRIMARY_BUTTON = 'px-3 py-2 text-sm rounded-lg bg-accent-primary text-accent-foreground disabled:opacity-50';
const SECONDARY_BUTTON = 'px-3 py-2 text-sm rounded-lg border border-border hover:bg-bg-secondary disabled:opacity-50';
const OVERLAY_DEBOUNCE_MS = 600;

/**
 * Whether a saved campaign counts down to release day. One planned once the release was out runs
 * from the day after it was planned, so every post comes after release day; any post on or before
 * it means the campaign was built around it.
 */
function countsDownToRelease(c: { releaseDate: string; posts: { date: string }[] }): boolean {
  return c.posts.length === 0 || c.posts.some(p => p.date <= c.releaseDate);
}

function formatDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function PromoteCampaignsPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { session, isLoading: authLoading } = useAuth();
  const [page, setPage] = useState<CampaignsPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problems, setProblems] = useState<Record<string, string[]> | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The new-campaign form.
  const [releaseId, setReleaseId] = useState('');
  const [releaseDate, setReleaseDate] = useState('');
  const [runway, setRunway] = useState<number>(DEFAULT_RUNWAY_WEEKS);
  const [runWeeks, setRunWeeks] = useState<number>(DEFAULT_RUN_WEEKS);
  // The channels a new campaign will post to, chosen on this step with the release and the run
  // (Brandon, 2026-11-03), not left to the editor. Null until the artist touches them, and until
  // then the server's default stands in: autopost's channels where they have them, else everything
  // they've connected. A starting point the artist changes before scheduling, not a rule.
  const [newChannelIds, setNewChannelIds] = useState<string[] | null>(null);
  // Which Buffer organization to post from, when the artist has more than one and hasn't settled
  // it yet. Null until the page loads; the server stores it with the first campaign saved.
  const [chosenOrg, setChosenOrg] = useState<string | null>(null);
  // Read once: the address loses the parameter straight after.
  const [bufferOutcome] = useState(() => searchParams.get('buffer'));
  useReportArtistName(page?.available ? page.artist.name : undefined);

  useEffect(() => {
    if (!searchParams.has('buffer')) return;
    const rest = new URLSearchParams(searchParams);
    rest.delete('buffer');
    setSearchParams(rest, { replace: true });
  }, [searchParams, setSearchParams]);

  const tokenRef = useRef(session?.access_token);
  tokenRef.current = session?.access_token;
  const userId = session?.user?.id;

  useEffect(() => {
    if (authLoading) return;
    if (!userId || !tokenRef.current) {
      if (slug) navigate(`/login?next=${encodeURIComponent(`/promote/${encodeURIComponent(slug)}/campaigns`)}`, { replace: true });
      return;
    }
    if (!slug) return;
    let cancelled = false;
    getCampaignsPage(tokenRef.current, slug)
      .then(p => {
        if (cancelled) return;
        setPage(p);
        if (p.available && p.buffer.connected) setChosenOrg(p.buffer.organizationId);
      })
      .catch(err => {
        if (cancelled) return;
        if (!(err instanceof PromoteApiError) || err.status >= 500) Sentry.captureException(err, { extra: { context: 'PromoteCampaignsPage.load', slug } });
        setLoadError(err instanceof Error ? err.message : 'Couldn’t load this right now. Try refreshing.');
      });
    return () => { cancelled = true; };
  }, [authLoading, userId, slug, navigate]);

  // Where autopost falls moves as post dates change: asked again once the dates settle.
  const draftDates = draft ? draft.posts.map(p => p.date).sort().join(',') : '';
  const overlayKey = useRef('');
  useEffect(() => {
    if (!draft || !slug || !tokenRef.current) return;
    const key = `${draft.releaseId}|${draftDates}`;
    if (key === overlayKey.current) return;
    const timer = window.setTimeout(() => {
      overlayKey.current = key;
      campaignOverlay(tokenRef.current!, slug, { releaseId: draft.releaseId, dates: draftDates.split(',').filter(Boolean), campaignId: draft.id })
        .then(({ autopost }) => setDraft(d => (d && d.releaseId === draft.releaseId ? { ...d, autopost } : d)))
        .catch(err => Sentry.captureException(err, { extra: { context: 'PromoteCampaignsPage.overlay', slug } }));
    }, OVERLAY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // Only the dates and the release matter here; the rest of the draft changes as the artist types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftDates, draft?.releaseId, draft?.id, slug]);

  if (!slug) return null;
  if (loadError) return <p className="text-sm text-error">{loadError}</p>;
  if (!page || !session) return <TabSkeleton label="Loading" />;
  if (!page.available) return <p className="text-sm text-text-muted">Campaigns aren’t available on Unstream yet.</p>;

  const loaded: Loaded = page;
  const token = session.access_token;
  const buffer = loaded.buffer;
  /** The channels Buffer has for the chosen organization that Unstream can post to. */
  const available = buffer.connected && buffer.organizationId === chosenOrg ? buffer.channels.filter(c => c.supported) : [];
  const canPost = available.length > 0;
  const serviceOf = new Map(available.map(c => [c.id, c.service]));
  const nameOf = new Map(available.map(c => [c.id, `${c.name} · ${networkName(c.service)}`]));
  const newChannels = (newChannelIds ?? (loaded.defaultChannelIds.length ? loaded.defaultChannelIds : available.map(c => c.id)))
    .filter(id => serviceOf.has(id));
  const withCampaign = new Set(loaded.campaigns.map(c => c.releaseId));
  const choosable = loaded.releases.filter(r => !withCampaign.has(r.id));
  const chosen = loaded.releases.find(r => r.id === releaseId) ?? null;
  // Out by today means the first post, tomorrow, comes after release: no countdown to plan.
  const alreadyOut = Boolean(releaseDate) && releaseDate <= loaded.today;

  const pickRelease = (id: string) => {
    setReleaseId(id);
    const r = loaded.releases.find(x => x.id === id);
    // A known exact date is offered as is; anything less precise the artist confirms.
    setReleaseDate(r?.releaseDate && r.datePrecision === 'day' ? r.releaseDate : '');
  };

  const fail = (err: unknown, context: string, fallback: string) => {
    if (err instanceof PromoteApiError) {
      setError(err.message);
      setProblems(err.problems);
      if (err.status >= 500) Sentry.captureException(err, { extra: { context, slug } });
    } else {
      Sentry.captureException(err, { extra: { context, slug } });
      setError(fallback);
    }
  };

  const propose = async () => {
    if (!chosen || !releaseDate) return;
    setBusy(true);
    setError(null);
    setProblems(undefined);
    try {
      const proposal = await proposeCampaign(token, slug, alreadyOut
        ? { releaseId: chosen.id, releaseDate, runWeeks }
        : { releaseId: chosen.id, releaseDate, startDate: addDays(releaseDate, -7 * runway) });
      overlayKey.current = `${chosen.id}|${proposal.posts.map(p => p.date).sort().join(',')}`;
      setDraft({
        id: null, releaseId: chosen.id, releaseDate, channelIds: newChannels, anchoredToRelease: !alreadyOut,
        posts: proposal.posts, autopost: proposal.autopost,
      });
    } catch (err) {
      fail(err, 'PromoteCampaignsPage.propose', 'Couldn’t propose posts just now. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setProblems(undefined);
    try {
      setPage(await saveCampaign(token, slug, { ...draft, organizationId: chosenOrg }));
      setDraft(null);
      setReleaseId('');
      setReleaseDate('');
      setNewChannelIds(null);
    } catch (err) {
      fail(err, 'PromoteCampaignsPage.save', 'Couldn’t save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    if (!window.confirm('Stop this campaign? Posts not yet in Buffer are deleted. Posts already in Buffer stay there.')) return;
    setBusy(true);
    setError(null);
    try {
      setPage(await cancelCampaign(token, slug, id));
      if (draft?.id === id) setDraft(null);
    } catch (err) {
      fail(err, 'PromoteCampaignsPage.stop', 'Couldn’t stop it. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    try {
      window.location.href = await startBufferConnection(token, slug, 'campaigns');
    } catch (err) {
      fail(err, 'PromoteCampaignsPage.connect', 'Couldn’t reach Buffer.');
      setBusy(false);
    }
  };

  /**
   * Ask Buffer again: after the artist connects channels there, and when they pick a different
   * organization, whose channels only the server can list. Nothing is saved by looking.
   */
  const refresh = async (organizationId: string | null = chosenOrg) => {
    setBusy(true);
    try {
      const fresh = await getCampaignsPage(token, slug, organizationId);
      setPage(fresh);
      if (fresh.available && fresh.buffer.connected) setChosenOrg(fresh.buffer.organizationId);
    } catch (err) {
      fail(err, 'PromoteCampaignsPage.refresh', 'Couldn’t check Buffer just now. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const draftRelease = draft ? loaded.releases.find(r => r.id === draft.releaseId) ?? null : null;
  // The networks this campaign posts to, so the editor can check each post's length against them.
  const draftServices = [...new Set((draft?.channelIds ?? []).flatMap(id => serviceOf.get(id) ?? []))];
  const images: ImageChoice[] = [
    ...(draftRelease?.artworkUrl ? [{ key: 'cover', url: draftRelease.artworkUrl, label: 'Cover art', instagramOk: true }] : []),
    ...(loaded.artist.photoUrl ? [{ key: 'photo', url: loaded.artist.photoUrl, label: 'Your photo', instagramOk: true }] : []),
    ...loaded.uploads.map((u, i) => ({ key: `upload:${u.id}`, url: u.url, label: `Upload ${i + 1}`, instagramOk: u.instagramOk })),
  ];

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-secondary">
        Plan a run of posts for a release, before it comes out or after. Unstream proposes them and you edit before anything is
        scheduled. Autopost steps aside on campaign days.
      </p>

      {loaded.pausedReason && (
        <p className="text-sm text-error" role="alert">
          Posting has stopped. <Link to={`/promote/${encodeURIComponent(slug)}`} className="underline">See the Autopost tab</Link>.
        </p>
      )}
      {bufferOutcome && BUFFER_OUTCOMES[bufferOutcome] && (
        <p className="text-sm text-text-secondary" role="status">{BUFFER_OUTCOMES[bufferOutcome]}</p>
      )}

      {/* Until there's somewhere to post, setting that up is the whole page. After that the
          channels are chosen campaign by campaign, in the editor. */}
      {!canPost && (
        <section className={SECTION} aria-labelledby="campaigns-buffer">
          <h3 id="campaigns-buffer" className="font-medium text-text-primary">Where campaign posts go</h3>
          <p className="text-sm text-text-secondary">
            Campaign posts are scheduled and published through{' '}
            <a href="https://buffer.com" target="_blank" rel="noopener noreferrer" className="text-link hover:underline">Buffer</a>,
            the same connection autopost uses. You pick which channels each campaign posts to when you plan it.
          </p>
          <PromoteBufferChannels
            buffer={buffer}
            organizationId={chosenOrg}
            channelIds={[]}
            busy={busy}
            what="campaign posts"
            onConnect={connect}
            onCheckAgain={() => refresh()}
            onChange={({ organizationId }) => {
              setChosenOrg(organizationId);
              if (organizationId) void refresh(organizationId);
            }}
          />
        </section>
      )}

      {loaded.campaigns.length > 0 && !draft && (
        <section className={SECTION} aria-labelledby="campaigns-running">
          <h3 id="campaigns-running" className="font-medium text-text-primary">Your campaigns</h3>
          <ul className="space-y-3">
            {loaded.campaigns.map(c => {
              const inBuffer = c.posts.filter(p => p.status === 'pushed').length;
              // Still to go to Buffer: not there or on its way, and not a failure that won't be retried.
              const waiting = c.posts.filter(p => p.status !== 'pushed' && p.status !== 'pushing' && !p.gaveUp && p.date > loaded.today);
              const next = waiting[0];
              // Its channels all gone from Buffer, or never set: the sweep holds its posts back, and
              // without saying so here the artist would only find out when nothing appeared.
              const noChannels = canPost && waiting.length > 0 && !c.channelIds.some(id => serviceOf.has(id));
              return (
                <li key={c.id} className="flex items-center gap-3">
                  {c.release?.artworkUrl
                    ? <img src={c.release.artworkUrl} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
                    : <div className="h-12 w-12 shrink-0 rounded bg-bg-secondary" aria-hidden="true" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary truncate">{c.release?.title ?? 'A release no longer listed'}</p>
                    <p className="text-xs text-text-muted">
                      Out {formatDate(c.releaseDate)} · {c.posts.length} post{c.posts.length === 1 ? '' : 's'}
                      {inBuffer ? `, ${inBuffer} in Buffer` : ''}{next ? ` · next ${formatDate(next.date)}` : ''}
                    </p>
                    {noChannels && (
                      <p className="text-xs text-warning">Not posting: none of its channels is in Buffer. Edit it to choose where it posts.</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setProblems(undefined);
                        overlayKey.current = `${c.releaseId}|${c.posts.map(p => p.date).sort().join(',')}`;
                        setDraft({
                          id: c.id,
                          releaseId: c.releaseId,
                          releaseDate: c.releaseDate,
                          // A channel removed in Buffer since it was ticked drops out here, so the
                          // ticks are what would actually be saved.
                          channelIds: c.channelIds.filter(id => serviceOf.has(id)),
                          // Decided once, from the campaign as saved: worked out live, typing a new
                          // year digit by digit could flip it halfway and strand the posts.
                          anchoredToRelease: countsDownToRelease(c),
                          posts: c.posts,
                          autopost: c.autopost,
                        });
                      }}
                      className={SECONDARY_BUTTON}
                    >
                      Edit
                    </button>
                    <button type="button" disabled={busy} onClick={() => stop(c.id)} className="px-2 text-sm text-text-muted hover:text-error disabled:opacity-50">
                      Stop
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {!draft && (
        <section className={SECTION} aria-labelledby="campaigns-new">
          <h3 id="campaigns-new" className="font-medium text-text-primary">New campaign</h3>
          {choosable.length === 0 ? (
            <p className="text-sm text-text-secondary">
              {loaded.releases.length === 0 ? 'Unstream hasn’t found any releases it can post about yet.' : 'Every release already has a campaign.'}
            </p>
          ) : (
            <div className="space-y-3">
              <label className="flex flex-wrap items-center gap-2 text-sm">
                Release
                <select
                  value={releaseId}
                  onChange={e => pickRelease(e.target.value)}
                  className="min-w-0 max-w-full px-2 py-1 bg-bg-primary border border-border rounded-lg"
                >
                  <option value="">Choose…</option>
                  {choosable.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
                </select>
              </label>
              {chosen && (
                <>
                  <label className="flex flex-wrap items-center gap-2 text-sm">
                    Release date
                    <input
                      type="date"
                      value={releaseDate}
                      onChange={e => setReleaseDate(e.target.value)}
                      className="px-2 py-1 bg-bg-primary border border-border rounded-lg"
                    />
                  </label>
                  {alreadyOut ? (
                    <label className="flex flex-wrap items-center gap-2 text-sm">
                      Promote for
                      <select
                        value={runWeeks}
                        onChange={e => setRunWeeks(Number(e.target.value))}
                        className="px-2 py-1 bg-bg-primary border border-border rounded-lg"
                      >
                        {RUN_WEEKS.map(w => (
                          <option key={w} value={w}>{w} weeks from tomorrow{w === DEFAULT_RUN_WEEKS ? ' (recommended)' : ''}</option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label className="flex flex-wrap items-center gap-2 text-sm">
                      Start promoting
                      <select
                        value={runway}
                        onChange={e => setRunway(Number(e.target.value))}
                        className="px-2 py-1 bg-bg-primary border border-border rounded-lg"
                      >
                        {RUNWAY_WEEKS.map(w => (
                          <option key={w} value={w}>{w} week{w === 1 ? '' : 's'} before{w === DEFAULT_RUNWAY_WEEKS ? ' (recommended)' : ''}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {canPost ? (
                    <>
                      <PromoteChannelPicker
                        channels={available}
                        channelIds={newChannels}
                        what="campaign posts"
                        onChange={setNewChannelIds}
                      />
                      {newChannels.length === 0 && (
                        <p className="text-xs text-error" role="alert">Tick at least one channel for this campaign.</p>
                      )}
                    </>
                  ) : (
                    // Nothing to tick yet: the way forward is the Buffer section above, not an alert here.
                    <p className="text-sm text-text-secondary">Connect Buffer above to choose where this campaign posts.</p>
                  )}
                  <button type="button" disabled={busy || !releaseDate || newChannels.length === 0} onClick={propose} className={PRIMARY_BUTTON}>
                    {busy ? 'Planning…' : 'Next: plan posts'}
                  </button>
                </>
              )}
            </div>
          )}
          {error && <p className="text-sm text-error" role="alert">{error}</p>}
        </section>
      )}

      {draft && draftRelease && (
        <section className={SECTION} aria-labelledby="campaign-editor">
          <h3 id="campaign-editor" className="font-medium text-text-primary">{draftRelease.title}</h3>
          {draft.posts.length === 0 && (
            <p className="text-sm text-text-secondary">Nothing to propose for these dates. Add a post of your own.</p>
          )}
          <div className="space-y-1 border-b border-border pb-3">
            <p className="text-sm text-text-secondary">
              Where this campaign posts. Autopost’s channels are set separately, on the{' '}
              <Link to={`/promote/${encodeURIComponent(slug)}`} className="text-link hover:underline">Autopost tab</Link>.
            </p>
            {draft.id && !canPost ? (
              // As on the new-campaign step: nothing to tick until Buffer is back.
              <p className="text-sm text-text-secondary">Connect Buffer above to choose where this campaign posts.</p>
            ) : draft.id ? (
              <>
                <PromoteChannelPicker
                  channels={available}
                  channelIds={draft.channelIds}
                  what="campaign posts"
                  onChange={channelIds => setDraft({ ...draft, channelIds })}
                />
                {draft.channelIds.length === 0 && (
                  <p className="text-xs text-error" role="alert">Tick at least one channel for this campaign.</p>
                )}
              </>
            ) : (
              <p className="text-sm text-text-primary">
                {draft.channelIds.map(id => nameOf.get(id) ?? '').filter(Boolean).join(', ')}
              </p>
            )}
          </div>
          <CampaignEditor
            release={draftRelease}
            releaseDate={draft.releaseDate}
            anchoredToRelease={draft.anchoredToRelease}
            posts={draft.posts}
            autopost={draft.autopost}
            today={loaded.today}
            services={draftServices}
            images={images}
            artist={loaded.artist}
            problems={problems}
            onChange={next => setDraft({ ...draft, ...next })}
          />
          <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t border-border bg-bg-primary px-1 py-3">
            <button type="button" disabled={busy || draft.channelIds.length === 0 || draft.posts.length === 0} onClick={save} className={PRIMARY_BUTTON}>
              {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Schedule campaign'}
            </button>
            <button type="button" disabled={busy} onClick={() => { setDraft(null); setError(null); setProblems(undefined); }} className={SECONDARY_BUTTON}>
              {draft.id ? 'Cancel' : 'Discard'}
            </button>
            {error && <span className="text-xs text-error" role="alert">{error}</span>}
          </div>
        </section>
      )}
    </div>
  );
}

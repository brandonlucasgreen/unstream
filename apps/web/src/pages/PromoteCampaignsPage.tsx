import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { TabSkeleton, useReportArtistName } from './ArtistSettingsLayout';
import { CampaignEditor, type ImageChoice } from '../components/CampaignEditor';
import { DEFAULT_RUNWAY_WEEKS, RUNWAY_WEEKS } from '../../../../api/shared/campaign-steps';
import {
  campaignOverlay,
  cancelCampaign,
  getCampaignsPage,
  PromoteApiError,
  proposeCampaign,
  saveCampaign,
  type AutopostDay,
  type CampaignPostDraft,
  type CampaignsPage,
} from '../services/promote';

// /promote/:slug/campaigns — release campaigns, a tab of the Promote page
// (docs/specs/release-autopost-spec.md, "Release campaigns"; Brandon, 2026-11-02).
//
// The artist picks a release, confirms its date and how far ahead to start; Unstream proposes a
// timeline of posts from best-practice steps, written in the artist's voice from templates (no
// LLM), and shows where autopost's posts fall around them. Autopost steps aside on campaign days
// and the day either side, so no network gets two posts on a day. Nothing is scheduled until the
// artist presses Schedule; posts then go to Buffer 72 hours ahead, as autopost's do.

type Loaded = Extract<CampaignsPage, { available: true }>;

/** The campaign being planned or edited. `id` is null until it's scheduled. */
interface Draft {
  id: string | null;
  releaseId: string;
  releaseDate: string;
  posts: CampaignPostDraft[];
  autopost: AutopostDay[];
}

const SECTION = 'space-y-3 rounded-xl border border-border bg-bg-secondary/40 p-4';
const PRIMARY_BUTTON = 'px-3 py-2 text-sm rounded-lg bg-accent-primary text-accent-foreground disabled:opacity-50';
const SECONDARY_BUTTON = 'px-3 py-2 text-sm rounded-lg border border-border hover:bg-bg-secondary disabled:opacity-50';
const OVERLAY_DEBOUNCE_MS = 600;

function formatDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function PromoteCampaignsPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
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
  useReportArtistName(page?.available ? page.artist.name : undefined);

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
      .then(p => { if (!cancelled) setPage(p); })
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
  const canPost = loaded.bufferConnected && loaded.services.length > 0;
  const withCampaign = new Set(loaded.campaigns.map(c => c.releaseId));
  const choosable = loaded.releases.filter(r => !withCampaign.has(r.id));
  const chosen = loaded.releases.find(r => r.id === releaseId) ?? null;

  const pickRelease = (id: string) => {
    setReleaseId(id);
    const r = loaded.releases.find(x => x.id === id);
    // A known future date is offered as is; anything else the artist confirms.
    setReleaseDate(r?.releaseDate && r.datePrecision === 'day' && r.releaseDate > loaded.today ? r.releaseDate : '');
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
      const startDate = addDays(releaseDate, -7 * runway);
      const proposal = await proposeCampaign(token, slug, { releaseId: chosen.id, releaseDate, startDate });
      overlayKey.current = `${chosen.id}|${proposal.posts.map(p => p.date).sort().join(',')}`;
      setDraft({ id: null, releaseId: chosen.id, releaseDate, posts: proposal.posts, autopost: proposal.autopost });
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
      setPage(await saveCampaign(token, slug, draft));
      setDraft(null);
      setReleaseId('');
      setReleaseDate('');
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

  const draftRelease = draft ? loaded.releases.find(r => r.id === draft.releaseId) ?? null : null;
  const images: ImageChoice[] = [
    ...(draftRelease?.artworkUrl ? [{ key: 'cover', url: draftRelease.artworkUrl, label: 'Cover art', instagramOk: true }] : []),
    ...(loaded.artist.photoUrl ? [{ key: 'photo', url: loaded.artist.photoUrl, label: 'Your photo', instagramOk: true }] : []),
    ...loaded.uploads.map((u, i) => ({ key: `upload:${u.id}`, url: u.url, label: `Upload ${i + 1}`, instagramOk: u.instagramOk })),
  ];

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-secondary">
        Plan a run of posts for a new release. Unstream proposes them and you edit before anything is scheduled. Autopost steps
        aside on campaign days.
      </p>

      {loaded.pausedReason && (
        <p className="text-sm text-error" role="alert">
          Posting has stopped. <Link to={`/promote/${encodeURIComponent(slug)}`} className="underline">See the Autopost tab</Link>.
        </p>
      )}
      {!canPost && (
        <p className="text-sm text-text-secondary">
          Campaign posts go to the channels you choose on the{' '}
          <Link to={`/promote/${encodeURIComponent(slug)}`} className="text-link hover:underline">Autopost tab</Link>. Choose them
          there first.
        </p>
      )}

      {loaded.campaigns.length > 0 && !draft && (
        <section className={SECTION} aria-labelledby="campaigns-running">
          <h3 id="campaigns-running" className="font-medium text-text-primary">Your campaigns</h3>
          <ul className="space-y-3">
            {loaded.campaigns.map(c => {
              const inBuffer = c.posts.filter(p => p.status === 'pushed').length;
              const next = c.posts.find(p => p.status !== 'pushed' && p.date > loaded.today);
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
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setProblems(undefined);
                        overlayKey.current = `${c.releaseId}|${c.posts.map(p => p.date).sort().join(',')}`;
                        setDraft({ id: c.id, releaseId: c.releaseId, releaseDate: c.releaseDate, posts: c.posts, autopost: c.autopost });
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
                      min={addDays(loaded.today, 1)}
                      onChange={e => setReleaseDate(e.target.value)}
                      className="px-2 py-1 bg-bg-primary border border-border rounded-lg"
                    />
                  </label>
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
                  <button type="button" disabled={busy || !releaseDate} onClick={propose} className={PRIMARY_BUTTON}>
                    {busy ? 'Planning…' : 'Propose posts'}
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
            <p className="text-sm text-text-secondary">Nothing to propose for these dates. Add a post, or pick an earlier start.</p>
          )}
          <CampaignEditor
            release={draftRelease}
            releaseDate={draft.releaseDate}
            posts={draft.posts}
            autopost={draft.autopost}
            today={loaded.today}
            services={loaded.services}
            images={images}
            artist={loaded.artist}
            problems={problems}
            onChange={next => setDraft({ ...draft, ...next })}
          />
          <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t border-border bg-bg-primary px-1 py-3">
            <button type="button" disabled={busy || !canPost || draft.posts.length === 0} onClick={save} className={PRIMARY_BUTTON}>
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

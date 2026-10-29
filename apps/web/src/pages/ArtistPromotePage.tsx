import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { TabSkeleton, useReportArtistName } from './ArtistSettingsLayout';
import { KIND_COPY, PromoteTemplatesEditor } from '../components/PromoteTemplatesEditor';
import { networkName } from '../../../../api/shared/autopost-networks';
import { InfoTip } from '../components/InfoTip';
import {
  getPromotePage,
  PromoteApiError,
  savePromoteSettings,
  startBufferConnection,
  type PromotePage,
  type PromoteSettingsInput,
} from '../services/promote';

// /promote/:slug — release autopost (docs/specs/release-autopost-spec.md, "UI: the Promote
// page"), reached from the Promote button on /my-artists and rendered inside ArtistSettingsLayout.
// Its own page rather than a tab under Edit, because it isn't about the artist's profile (Brandon,
// 2026-10-29). Admin-only while the releaseAutopost flag is off: the server answers
// { available: false } to anyone else.
//
// The settings are edited here and saved together; "Coming up" is the server's plan from the
// saved settings, so it's exactly what will post, and it refreshes on every save.

type Loaded = Extract<PromotePage, { available: true }>;

const SECTION = 'space-y-3 rounded-xl border border-border bg-bg-secondary/40 p-4';
const PRIMARY_BUTTON = 'px-3 py-2 text-sm rounded-lg bg-accent-primary text-accent-foreground disabled:opacity-50';
const SECONDARY_BUTTON = 'px-3 py-2 text-sm rounded-lg border border-border hover:bg-bg-secondary disabled:opacity-50';

const BUFFER_OUTCOMES: Record<string, string> = {
  connected: 'Buffer is connected.',
  cancelled: 'Buffer wasn’t connected: the connection was stopped before it finished.',
  expired: 'That took too long and the connection expired. Try again.',
  failed: 'Buffer couldn’t be connected. Try again.',
  unavailable: 'Buffer isn’t available right now.',
};

/** Where a Buffer user connects their social accounts. */
const BUFFER_CHANNELS_URL = 'https://publish.buffer.com/settings/channels';

const PAUSED: Record<string, string> = {
  buffer_disconnected: 'Posting has stopped because Buffer was disconnected. Reconnect it, then save to start again.',
};

function inputFrom(page: Loaded): PromoteSettingsInput {
  const s = page.settings;
  return {
    enabled: s.enabled,
    postsPerWeek: s.postsPerWeek,
    // A first visit takes the browser's timezone; after that, what was saved.
    timezone: page.saved ? s.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || s.timezone,
    postTime: s.postTime,
    organizationId: page.buffer.connected ? page.buffer.organizationId : s.organizationId,
    channelIds: s.channelIds,
    kindsOff: s.kindsOff,
    templates: s.templates,
  };
}

function formatDay(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function cadenceLine(releases: number, perWeek: number): string {
  if (releases === 0) return 'Unstream hasn’t found any releases it can post about yet.';
  const weeks = Math.max(2, Math.round(releases / perWeek));
  const plural = releases === 1 ? 'release' : 'releases';
  return `You have ${releases} ${plural}. At ${perWeek} a week, each comes up about every ${weeks} weeks.`;
}

export function ArtistPromotePage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { session, isLoading: authLoading } = useAuth();
  const [page, setPage] = useState<PromotePage | null>(null);
  const [form, setForm] = useState<PromoteSettingsInput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string[]> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // Read once: the address loses the parameter straight after.
  const [bufferOutcome] = useState(() => searchParams.get('buffer'));
  useReportArtistName(page?.available ? page.artist.name : undefined);

  useEffect(() => {
    if (!searchParams.has('buffer')) return;
    const rest = new URLSearchParams(searchParams);
    rest.delete('buffer');
    setSearchParams(rest, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      if (slug) navigate(`/login?next=${encodeURIComponent(`/promote/${encodeURIComponent(slug)}`)}`, { replace: true });
      return;
    }
    if (!slug) return;
    let cancelled = false;
    getPromotePage(session.access_token, slug)
      .then(p => {
        if (cancelled) return;
        apply(p);
      })
      .catch(err => {
        if (cancelled) return;
        if (!(err instanceof PromoteApiError) || err.status >= 500) Sentry.captureException(err, { extra: { context: 'ArtistPromotePage.load', slug } });
        setLoadError(err instanceof Error ? err.message : 'Couldn’t load this right now. Try refreshing.');
      });
    return () => { cancelled = true; };
  }, [authLoading, session, slug, navigate]);

  function apply(p: PromotePage) {
    setPage(p);
    if (p.available) setForm(inputFrom(p));
  }

  if (!slug) return null;
  if (loadError) return <p className="text-sm text-error">{loadError}</p>;
  if (!page || !session) return <TabSkeleton label="Loading" />;
  if (!page.available || !form) return <p className="text-sm text-text-muted">Release autopost isn’t available on Unstream yet.</p>;

  const token = session.access_token;
  const update = (patch: Partial<PromoteSettingsInput>) => {
    setForm({ ...form, ...patch });
    setSaved(false);
  };

  const save = async (next: PromoteSettingsInput = form) => {
    setBusy(true);
    setSaveError(null);
    setProblems(undefined);
    try {
      const result = await savePromoteSettings(token, slug, next);
      setPage(result);
      if (result.available) setForm(inputFrom(result));
      setSaved(true);
    } catch (err) {
      if (err instanceof PromoteApiError) {
        setSaveError(err.message);
        setProblems(err.problems);
        if (err.status >= 500) Sentry.captureException(err, { extra: { context: 'ArtistPromotePage.save', slug } });
      } else {
        Sentry.captureException(err, { extra: { context: 'ArtistPromotePage.save', slug } });
        setSaveError('Couldn’t save. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  // After connecting accounts in Buffer: read the channels again, keeping any unsaved edits.
  const refresh = async () => {
    setBusy(true);
    try {
      const fresh = await getPromotePage(token, slug);
      setPage(fresh);
      if (fresh.available && fresh.buffer.connected && !form.organizationId) setForm({ ...form, organizationId: fresh.buffer.organizationId });
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'ArtistPromotePage.refresh', slug } });
      setSaveError('Couldn’t check Buffer just now. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    try {
      window.location.href = await startBufferConnection(token, slug);
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'ArtistPromotePage.connect', slug } });
      setSaveError(err instanceof Error ? err.message : 'Couldn’t reach Buffer.');
      setBusy(false);
    }
  };

  const buffer = page.buffer;
  const recommended = Math.max(1, page.recommendedPerWeek);
  const perWeek = form.postsPerWeek ?? recommended;
  const ticked = new Set(form.channelIds);
  const tickedServices = buffer.connected ? buffer.channels.filter(c => ticked.has(c.id)).map(c => c.service) : [];
  const canSwitchOn = Boolean(form.organizationId) && form.channelIds.length > 0;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-text-secondary">
          Posts about your releases, on a gentle weekly rhythm, scheduled to your own Buffer. Unstream writes nothing with AI: each
          post is one of the templates below, filled with facts about the release.{' '}
          {form.postTime === null
            ? 'Each post joins your Buffer queue on its day, where you can change or delete it before it goes out.'
            : 'Every post lands in Buffer three days before it goes out, where you can change or delete it.'}
        </p>
      </div>

      {bufferOutcome && BUFFER_OUTCOMES[bufferOutcome] && (
        <p className="text-sm text-text-secondary" role="status">{BUFFER_OUTCOMES[bufferOutcome]}</p>
      )}
      {page.settings.pausedReason && (
        <p className="text-sm text-error" role="alert">{PAUSED[page.settings.pausedReason] ?? 'Posting has stopped. Save to start again.'}</p>
      )}

      <section className={SECTION} aria-labelledby="promote-buffer">
        <h3 id="promote-buffer" className="font-medium text-text-primary">Where it posts</h3>
        {!buffer.connected ? (
          <div className="space-y-2">
            <p className="text-sm text-text-secondary">
              Unstream posts through Buffer, to the social accounts you connect there. Buffer’s free plan is enough.
            </p>
            <p className="text-sm text-text-secondary">
              <span className="font-medium text-text-primary">New to Buffer?</span> You can make a free account on the next
              screen. Then connect your social accounts in Buffer, since Unstream can only post to accounts connected there.
            </p>
            <button type="button" disabled={busy} onClick={connect} className={PRIMARY_BUTTON}>Connect Buffer</button>
          </div>
        ) : buffer.organizations.length === 0 ? (
          <NoChannels busy={busy} onCheckAgain={refresh} />
        ) : (
          <div className="space-y-3">
            {buffer.organizations.length > 1 && (
              <label className="flex flex-wrap items-center gap-2 text-sm">
                Buffer organization
                <select
                  value={form.organizationId ?? ''}
                  onChange={e => update({ organizationId: e.target.value || null, channelIds: [] })}
                  className="px-2 py-1 bg-bg-primary border border-border rounded-lg"
                >
                  <option value="">Choose…</option>
                  {buffer.organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
            )}
            {form.organizationId && form.organizationId !== buffer.organizationId && (
              <p className="text-xs text-text-muted">Save to see this organization’s channels.</p>
            )}
            {form.organizationId && form.organizationId === buffer.organizationId && (
              buffer.channels.filter(c => c.supported).length === 0 ? (
                <NoChannels busy={busy} onCheckAgain={refresh} hasOthers={buffer.channels.length > 0} />
              ) : (
                <fieldset className="space-y-1">
                  <legend className="text-sm text-text-secondary mb-1">Channels</legend>
                  {buffer.channels.filter(c => c.supported).map(c => (
                    <label key={c.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={ticked.has(c.id)}
                        onChange={e => update({ channelIds: e.target.checked ? [...form.channelIds, c.id] : form.channelIds.filter(id => id !== c.id) })}
                      />
                      {c.name} <span className="text-text-muted">· {networkName(c.service)}</span>
                    </label>
                  ))}
                  {/* Unstream's choice, not Buffer's: autopost posts text with an image, so networks that
                      need a video or extra setup aren't offered. Named once, out of the way. */}
                  {buffer.channels.some(c => !c.supported) && (
                    <p className="pt-1 text-xs text-text-muted">
                      Not available for autopost:{' '}
                      {buffer.channels.filter(c => !c.supported).map(c => `${c.name} (${networkName(c.service)})`).join(', ')}.
                      {' '}Autopost posts text with an image, so it leaves out networks that need a video or extra setup.
                    </p>
                  )}
                  <a href={BUFFER_CHANNELS_URL} target="_blank" rel="noopener noreferrer" className="inline-block pt-1 text-xs text-link hover:underline">
                    Connect another account in Buffer ↗
                  </a>
                </fieldset>
              )
            )}
            {tickedServices.includes('instagram') && (
              <p className="text-xs text-text-secondary">
                Instagram needs an image on every post. Autopost uses your release covers and your artist photo, and won’t show
                the same one on Instagram twice in four weeks. When nothing fresh is left, that post skips Instagram and goes to
                your other channels.
              </p>
            )}
          </div>
        )}
      </section>

      <section className={SECTION} aria-labelledby="promote-rhythm">
        <h3 id="promote-rhythm" className="font-medium text-text-primary">How often</h3>
        <div className="space-y-1">
          <label htmlFor="promote-per-week" className="flex items-baseline justify-between text-sm">
            <span>Posts a week</span>
            <span>
              <span className="font-medium text-text-primary">{perWeek}</span>
              {perWeek === recommended && <span className="text-text-muted"> (recommended)</span>}
            </span>
          </label>
          <input
            id="promote-per-week"
            type="range"
            min={1}
            max={7}
            step={1}
            value={perWeek}
            aria-valuetext={`${perWeek} a week${perWeek === recommended ? ', recommended' : ''}`}
            // Landing back on the recommendation stores "Recommended", which grows with the catalog.
            onChange={e => update({ postsPerWeek: Number(e.target.value) === recommended ? null : Number(e.target.value) })}
            className="w-full accent-[var(--color-accent-primary)]"
          />
          <div className="flex justify-between text-xs text-text-muted" aria-hidden="true">
            {[1, 2, 3, 4, 5, 6, 7].map(n => (
              <span key={n} className={n === recommended ? 'font-medium text-text-primary' : ''}>{n}</span>
            ))}
          </div>
        </div>
        <p className="text-xs text-text-muted">
          {cadenceLine(page.releaseCount, perWeek)} Fridays always post; more a week adds Monday to Thursday first.
          {perWeek !== recommended && (
            <>
              {' '}
              <button type="button" onClick={() => update({ postsPerWeek: null })} className="text-link hover:underline">
                Back to {recommended} (recommended)
              </button>
            </>
          )}
        </p>
        <fieldset className="space-y-2">
          <legend className="text-sm mb-1">Posting time</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="post-time" checked={form.postTime === null} onChange={() => update({ postTime: null })} className="mt-1" />
            <span>
              Recommended: your Buffer queue
              <span className="block text-xs text-text-muted">
                Each post joins that channel’s queue in Buffer on its day and goes out at the next time in your posting
                schedule. Buffer sets those times from when your audience is most likely to see a post, and you can change them
                in Buffer.
              </span>
            </span>
          </label>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <input type="radio" name="post-time" checked={form.postTime !== null} onChange={() => update({ postTime: form.postTime ?? '10:00' })} />
            At a set time
            {form.postTime !== null && (
              <>
                <input
                  type="time"
                  aria-label="Time"
                  value={form.postTime}
                  onChange={e => update({ postTime: e.target.value || '10:00' })}
                  className="px-2 py-1 bg-bg-primary border border-border rounded-lg"
                />
                <span className="text-xs text-text-muted">{form.timezone}</span>
              </>
            )}
          </label>
        </fieldset>
      </section>

      <section className={SECTION} aria-labelledby="promote-words">
        <h3 id="promote-words" className="font-medium text-text-primary">What to say</h3>
        <PromoteTemplatesEditor
          templates={form.templates ?? {}}
          kindsOff={form.kindsOff}
          previewRelease={page.previewRelease}
          artist={page.artist}
          takesTips={page.takesTips}
          problems={problems}
          onChange={({ templates, kindsOff }) => update({ templates: Object.keys(templates).length ? templates : null, kindsOff })}
        />
      </section>

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t border-border bg-bg-primary px-1 py-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={!canSwitchOn && !form.enabled}
            onChange={e => update({ enabled: e.target.checked })}
          />
          Post automatically
        </label>
        <InfoTip label="What does Post automatically do?">
          <span className="block">
            <strong className="text-text-primary">On:</strong> Unstream adds each planned post to your Buffer{' '}
            {form.postTime === null ? 'on its day, in your queue' : 'three days before it goes out, at your set time'}.
          </span>
          <span className="mt-2 block">
            <strong className="text-text-primary">Off:</strong> nothing more goes to Buffer, and nothing is saved as a draft.
            Your settings stay, and Coming up still shows what would post. Posts already in Buffer stay there, where you can
            edit or delete them.
          </span>
        </InfoTip>
        <button type="button" disabled={busy} onClick={() => save()} className={PRIMARY_BUTTON}>{busy ? 'Saving…' : 'Save'}</button>
        {saved && <span className="text-xs text-text-muted" role="status">Saved</span>}
        {!canSwitchOn && !form.enabled && <span className="text-xs text-text-muted">Choose at least one channel to switch it on.</span>}
        {saveError && <span className="text-xs text-error" role="alert">{saveError}</span>}
      </div>

      <section className={SECTION} aria-labelledby="promote-coming-up">
        <h3 id="promote-coming-up" className="font-medium text-text-primary">Coming up</h3>
        <p className="text-xs text-text-muted">
          {page.settings.enabled ? 'The next four weeks, exactly as they’ll post.' : 'What the next four weeks would look like if you switched it on now.'}
          {' '}From your saved settings.
        </p>
        {page.comingUp.length === 0 ? (
          <p className="text-sm text-text-secondary">Nothing to post in the next four weeks.</p>
        ) : (
          <ol className="space-y-3">
            {page.comingUp.map(post => (
              <li key={post.at} className="flex gap-3">
                {post.imageUrl ? (
                  <img src={post.imageUrl} alt="" loading="lazy" className="h-14 w-14 shrink-0 rounded object-cover bg-bg-secondary" />
                ) : (
                  <div className="h-14 w-14 shrink-0 rounded bg-bg-secondary" aria-hidden="true" />
                )}
                <div className="min-w-0 space-y-0.5">
                  <p className="text-xs text-text-muted">
                    {formatDay(post.date)} · {KIND_COPY[post.kind].label}
                    {post.release ? ` · ${post.release.title}` : ''}
                    {tickedServices.includes('instagram') && !post.imageOnInstagram ? ' · skips Instagram' : ''}
                  </p>
                  <p className="text-sm text-text-primary whitespace-pre-line break-words">{post.text ?? 'No template could be filled for this one, so it won’t post.'}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {page.recent.length > 0 && (
        <section className={SECTION} aria-labelledby="promote-recent">
          <h3 id="promote-recent" className="font-medium text-text-primary">Sent to Buffer</h3>
          <ul className="space-y-2 text-sm">
            {page.recent.map(post => (
              <li key={post.slotAt}>
                <span className="text-text-secondary">{formatDay(post.slotAt.slice(0, 10))} · {KIND_COPY[post.kind].label}{post.releaseTitle ? ` · ${post.releaseTitle}` : ''}</span>
                {' '}
                <span className={post.status === 'failed' ? 'text-error' : 'text-text-muted'}>
                  {post.status === 'pushed' ? `in Buffer on ${post.channels} channel${post.channels === 1 ? '' : 's'}` : post.status === 'failed' ? 'didn’t reach Buffer' : 'sending'}
                </span>
                {post.error && <span className="block text-xs text-text-muted">{post.error}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * A connected Buffer with no social accounts autopost can post to. Signing up through Buffer's
 * own screen during the connection makes an account with none, so this is where a new Buffer
 * user lands: send them to connect one there, then check again.
 */
function NoChannels({ busy, onCheckAgain, hasOthers = false }: { busy: boolean; onCheckAgain: () => void; hasOthers?: boolean }) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-bg-primary p-3">
      <p className="text-sm text-text-primary">
        {hasOthers
          ? 'None of the accounts connected in Buffer are ones autopost can post to.'
          : 'Your Buffer doesn’t have any social accounts connected yet.'}
      </p>
      <p className="text-sm text-text-secondary">
        Connect your Instagram, Facebook, Threads, Bluesky, Mastodon, LinkedIn or Substack in Buffer first, then come back
        here and check again.
      </p>
      <div className="flex flex-wrap gap-2">
        <a href={BUFFER_CHANNELS_URL} target="_blank" rel="noopener noreferrer" className={PRIMARY_BUTTON}>
          Connect accounts in Buffer ↗
        </a>
        <button type="button" disabled={busy} onClick={onCheckAgain} className={SECONDARY_BUTTON}>Check again</button>
      </div>
    </div>
  );
}

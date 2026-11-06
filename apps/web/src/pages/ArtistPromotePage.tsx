import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { TabSkeleton, useReportArtistName } from './ArtistSettingsLayout';
import { PromoteTemplatesEditor } from '../components/PromoteTemplatesEditor';
import { PromoteComingUp, ScheduledPostItem } from '../components/PromoteComingUp';
import { PromoteBufferChannels } from '../components/PromoteBufferChannels';
import { BUFFER_OUTCOMES, BUFFER_URL } from '../data/buffer';
import { isImageFirstNetwork, networkName } from '../../../../api/shared/autopost-networks';
import {
  getPromotePage,
  getPromoteSchedule,
  PromoteApiError,
  savePromoteSettings,
  startBufferConnection,
  type PromotePage,
  type PromoteSettingsInput,
} from '../services/promote';

// /promote/:slug — release autopost (docs/specs/release-autopost-spec.md, "UI: the Promote
// page"), reached from the Promote button on /my-artists and rendered inside ArtistSettingsLayout,
// as the Autopost tab of the Promote page's tools (components/PromoteTabs.tsx).
// Its own page rather than a tab under Edit, because it isn't about the artist's profile (Brandon,
// 2026-10-29). Behind the releaseAutopost flag (the admin always gets in): the server answers
// { available: false } to anyone the flag shuts out.
//
// The settings are edited here and saved together; "Coming up" is the server's plan from the
// saved settings, so it's exactly what will post, and it refreshes on every save. Each post says
// where it stands (not in Buffer yet, scheduled there, posted, failed), and since that changes on
// its own, "Coming up" and "Recent" are polled while the page is in view (SCHEDULE_POLL_MS).

type Loaded = Extract<PromotePage, { available: true }>;

/**
 * How often "Coming up" and "Recent" are read again while the page is in view, and on coming back
 * to the tab. Each read is a rate-limit command and two Buffer calls, so not every few seconds:
 * the sweep only runs every six hours, and Buffer's own statuses change at posting times.
 */
const SCHEDULE_POLL_MS = 2 * 60_000;

const SECTION = 'space-y-3 rounded-xl border border-border bg-bg-secondary/40 p-4';
const PRIMARY_BUTTON = 'px-3 py-2 text-sm rounded-lg bg-accent-primary text-accent-foreground disabled:opacity-50';

/**
 * Why posting stopped, and what starts it again. A reconnect resumes it by itself, but not for
 * someone already connected again (or connected to a different Buffer login): for them it's Save.
 */
function pausedMessage(reason: string, bufferConnected: boolean): string {
  if (reason === 'buffer_disconnected') {
    return bufferConnected
      ? 'Posting stopped while Buffer was disconnected. Check where it posts, then save changes to start again.'
      : 'Posting has stopped because Buffer was disconnected. Reconnect it to start again.';
  }
  return 'Posting has stopped. Save changes to start again.';
}

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
  // Which Save row was pressed last, so "Saved" or the error shows beside the button that was used
  // rather than in both rows at once.
  const [savedFrom, setSavedFrom] = useState<SaveRowPlace>('footer');
  // Read once: the address loses the parameter straight after.
  const [bufferOutcome] = useState(() => searchParams.get('buffer'));
  useReportArtistName(page?.available ? page.artist.name : undefined);

  useEffect(() => {
    if (!searchParams.has('buffer')) return;
    const rest = new URLSearchParams(searchParams);
    rest.delete('buffer');
    setSearchParams(rest, { replace: true });
  }, [searchParams, setSearchParams]);

  // Loaded once per signed-in user, not again whenever the sign-in token refreshes. A refreshed
  // token is a new session object, and reloading on it sent two requests at once on a hard
  // refresh. Both could refresh the Buffer token together, and Buffer revokes a connection whose
  // refresh token is sent twice (see usableAccessToken in api/functions/buffer-db.ts).
  const tokenRef = useRef(session?.access_token);
  tokenRef.current = session?.access_token;
  const userId = session?.user?.id;

  useEffect(() => {
    if (authLoading) return;
    if (!userId || !tokenRef.current) {
      if (slug) navigate(`/login?next=${encodeURIComponent(`/promote/${encodeURIComponent(slug)}`)}`, { replace: true });
      return;
    }
    if (!slug) return;
    let cancelled = false;
    getPromotePage(tokenRef.current, slug)
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
  }, [authLoading, userId, slug, navigate]);

  function apply(p: PromotePage) {
    setPage(p);
    if (p.available) setForm(inputFrom(p));
  }

  // Polling the schedule. A poll never overlaps a save or a refresh, and its answer is dropped if
  // one happened meanwhile: theirs is newer, from the settings just saved.
  const busyRef = useRef(false);
  const writes = useRef(0);
  const pollReported = useRef(false);
  const loaded = page?.available === true;
  useEffect(() => {
    if (!loaded || !slug) return;
    let inFlight = false;
    const poll = async () => {
      const token = tokenRef.current;
      if (document.visibilityState !== 'visible' || inFlight || busyRef.current || !token) return;
      inFlight = true;
      const seen = writes.current;
      try {
        const s = await getPromoteSchedule(token, slug);
        if (writes.current !== seen) return;
        setPage(p => (p?.available
          ? { ...p, today: s.today, comingUp: s.comingUp, recent: s.recent, settings: { ...p.settings, pausedReason: s.pausedReason } }
          : p));
      } catch (err) {
        // The next poll tries again; reported once per visit, so a page left open on a bad day
        // doesn't send Sentry an event every two minutes.
        if (!pollReported.current) {
          pollReported.current = true;
          Sentry.captureException(err, { extra: { context: 'ArtistPromotePage.poll', slug } });
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(poll, SCHEDULE_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loaded, slug]);
  busyRef.current = busy;

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
    writes.current++;
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
    writes.current++;
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
  /** Instagram and TikTok, if ticked: they need an image on every post. */
  const imageFirstTicked = [...new Set(tickedServices.filter(isImageFirstNetwork))].map(networkName);
  const canSwitchOn = Boolean(form.organizationId) && form.channelIds.length > 0;
  // Everything past "Where it posts" is about posting, which needs somewhere to post. Until Buffer
  // is connected with a channel autopost can use, it stays hidden (Brandon, 2026-10-29).
  const ready = buffer.connected && Boolean(form.organizationId) && form.organizationId === buffer.organizationId
    && buffer.channels.some(c => c.supported);

  const posting = !page.settings.enabled ? 'off' : page.settings.pausedReason ? 'paused' : 'on';

  // The channel picker gets a Save of its own, inside "Where it posts" (Brandon, 2026-11-06). The
  // page's other Save sits below the templates, a long way from the channels, and isn't there at
  // all until autopost is ready — so someone choosing between Buffer organizations, told "Save to
  // see this organization's channels", had nothing to press. Shown whenever there's a choice of
  // organization or channels to save; not beside "connect your channels in Buffer first".
  const choosingChannels = buffer.connected && Boolean(form.organizationId)
    && (form.organizationId !== buffer.organizationId || buffer.channels.some(c => c.supported));
  const saveFrom = (place: SaveRowPlace) => {
    setSavedFrom(place);
    void save();
  };

  // The switch saves straight away, with whatever else is on the page: a switch that needed a
  // separate Save would look on while doing nothing.
  const toggle = () => save({ ...form, enabled: !form.enabled });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-text-secondary">
          Set up an automatic, AI-free weekly schedule of posts about your releases for any of your social profiles. Scheduling,
          publishing and analytics on your posts are powered by{' '}
          <a href="https://buffer.com" target="_blank" rel="noopener noreferrer" className="text-link hover:underline">Buffer</a>.
        </p>
      </div>

      {bufferOutcome && BUFFER_OUTCOMES[bufferOutcome] && (
        <p className="text-sm text-text-secondary" role="status">{BUFFER_OUTCOMES[bufferOutcome]}</p>
      )}
      {page.settings.pausedReason && (
        <p className="text-sm text-error" role="alert">{pausedMessage(page.settings.pausedReason, buffer.connected)}</p>
      )}

      {!choosingChannels && saveError && <p className="text-sm text-error" role="alert">{saveError}</p>}

      <section
        className={SECTION}
        {...(buffer.connected ? { 'aria-labelledby': 'promote-buffer' } : { 'aria-label': 'Connect Buffer' })}
      >
        {ready && (
          <AutopostSwitch
            on={form.enabled}
            busy={busy}
            canSwitchOn={canSwitchOn}
            channels={form.channelIds.length}
            onToggle={toggle}
          />
        )}
        {/* Nothing to say where it posts until there's a Buffer to post through. */}
        {buffer.connected && <h3 id="promote-buffer" className="font-medium text-text-primary">Where it posts</h3>}
        <PromoteBufferChannels
          buffer={buffer}
          organizationId={form.organizationId}
          channelIds={form.channelIds}
          busy={busy}
          what="autopost"
          onConnect={connect}
          onCheckAgain={refresh}
          onChange={update}
        />
        {choosingChannels && (
          <SaveRow
            label="Save"
            busy={busy}
            saved={saved && savedFrom === 'channels'}
            error={savedFrom === 'channels' || !ready ? saveError : null}
            onSave={() => saveFrom('channels')}
          />
        )}
      </section>

      {ready ? (
        <>
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
                Pick days &amp; times for me
                <span className="block text-xs text-text-muted">
                  Rely on Buffer’s posting schedule and recommended times algorithm to publish each post.
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

        <div className="sticky bottom-0 -mx-1 border-t border-border bg-bg-primary px-1 py-3">
          <SaveRow
            label="Save changes"
            busy={busy}
            saved={saved && savedFrom === 'footer'}
            error={savedFrom === 'footer' ? saveError : null}
            onSave={() => saveFrom('footer')}
          />
        </div>

        <section className={SECTION} aria-labelledby="promote-coming-up">
          <h3 id="promote-coming-up" className="font-medium text-text-primary">Coming up</h3>
          {page.comingUp.length === 0 ? (
            <p className="text-sm text-text-secondary">Nothing to post in the next four weeks.</p>
          ) : (
            <PromoteComingUp today={page.today} posts={page.comingUp} imageFirstTicked={imageFirstTicked} posting={posting} />
          )}
        </section>
        </>
      ) : (
        <section className={`${SECTION} text-sm text-text-secondary`} aria-label="What comes next">
          Once Buffer is connected with at least one channel, you’ll choose how often to post and what the posts say, and see
          the next four weeks exactly as they’ll go out, before anything is posted.
        </section>
      )}

      {page.recent.length > 0 && (
        <section className={SECTION} aria-labelledby="promote-recent">
          <h3 id="promote-recent" className="font-medium text-text-primary">Recent</h3>
          <ol className="space-y-3">
            {page.recent.map(post => <ScheduledPostItem key={`${post.kind}-${post.at}`} post={post} imageFirstTicked={[]} posting={posting} />)}
          </ol>
        </section>
      )}
    </div>
  );
}

type SaveRowPlace = 'channels' | 'footer';

/** A Save button with what happened beside it. Both rows save the whole form. */
function SaveRow({ label, busy, saved, error, onSave }: {
  label: string;
  busy: boolean;
  saved: boolean;
  error: string | null;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" disabled={busy} onClick={onSave} className={PRIMARY_BUTTON}>{busy ? 'Saving…' : label}</button>
      {saved && <span className="text-xs text-text-muted" role="status">Saved</span>}
      {error && <span className="text-xs text-error" role="alert">{error}</span>}
    </div>
  );
}

/**
 * The on/off switch for autopost, at the top with the channels it posts to (Brandon, 2026-10-29).
 * It says in plain words what each position means, so nobody has to guess whether "off" leaves
 * drafts behind: it doesn't.
 */
function AutopostSwitch({ on, busy, canSwitchOn, channels, onToggle }: {
  on: boolean;
  busy: boolean;
  canSwitchOn: boolean;
  channels: number;
  onToggle: () => void;
}) {
  const disabled = busy || (!on && !canSwitchOn);
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
      <div className="space-y-1">
        <p id="autopost-switch-label" className="text-lg font-semibold text-text-primary">Autopost is {on ? 'on' : 'off'}</p>
        <p className="text-sm text-text-secondary">
          {on
            ? (
              <>
                Posting to {channels} channel{channels === 1 ? '' : 's'}.{' '}
                Each post lands in Buffer three days before it goes out, where you can change or delete it.{' '}
                <a href={BUFFER_URL} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">Open Buffer ↗</a>
              </>
            )
            : canSwitchOn
              ? 'Nothing goes to Buffer while it’s off, and nothing is saved as a draft. Your settings are kept.'
              : 'Tick at least one channel below, then switch it on.'}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby="autopost-switch-label"
        disabled={disabled}
        onClick={onToggle}
        className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
          on ? 'bg-accent-primary' : 'bg-bg-secondary border border-border'
        }`}
      >
        <span className={`inline-block h-6 w-6 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-7' : 'translate-x-1'}`} />
      </button>
    </div>
  );
}

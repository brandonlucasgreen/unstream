import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { TabSkeleton, useReportArtistName } from './ArtistSettingsLayout';
import { KIND_COPY, PromoteTemplatesEditor } from '../components/PromoteTemplatesEditor';
import {
  getPromotePage,
  PromoteApiError,
  savePromoteSettings,
  startBufferConnection,
  type PromotePage,
  type PromoteSettingsInput,
} from '../services/promote';

// /artist-edit/:slug/promote — release autopost (docs/specs/release-autopost-spec.md, "UI: a
// Promote tab"), rendered inside ArtistSettingsLayout. Admin-only while the releaseAutopost flag
// is off: the server answers { available: false } to anyone else.
//
// The settings are edited here and saved together; "Coming up" is the server's plan from the
// saved settings, so it's exactly what will post, and it refreshes on every save.

type Loaded = Extract<PromotePage, { available: true }>;

const SECTION = 'space-y-3 rounded-xl border border-border bg-bg-secondary/40 p-4';
const PRIMARY_BUTTON = 'px-3 py-2 text-sm rounded-lg bg-accent-primary text-accent-foreground disabled:opacity-50';
const SECONDARY_BUTTON = 'px-3 py-2 text-sm rounded-lg border border-border hover:bg-bg-secondary disabled:opacity-50';

const BUFFER_OUTCOMES: Record<string, string> = {
  connected: 'Buffer is connected.',
  cancelled: 'Buffer wasn’t connected: the connection was cancelled.',
  expired: 'That took too long and the connection expired. Try again.',
  failed: 'Buffer couldn’t be connected. Try again.',
  unavailable: 'Buffer isn’t available right now.',
};

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
  if (releases === 0) return 'Unstream hasn’t catalogued any releases it can post about yet.';
  const weeks = Math.max(2, Math.round(releases / perWeek));
  const plural = releases === 1 ? 'release' : 'releases';
  return `You have ${releases} ${plural}. At ${perWeek} a week, each comes round about every ${weeks} weeks.`;
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
      if (slug) navigate(`/login?next=${encodeURIComponent(`/artist-edit/${encodeURIComponent(slug)}/promote`)}`, { replace: true });
      return;
    }
    if (!slug) return;
    let cancelled = false;
    getPromotePage(session.access_token, slug)
      .then(p => {
        if (cancelled) return;
        setPage(p);
        if (p.available) setForm(inputFrom(p));
      })
      .catch(err => {
        if (cancelled) return;
        if (!(err instanceof PromoteApiError) || err.status >= 500) Sentry.captureException(err, { extra: { context: 'ArtistPromotePage.load', slug } });
        setLoadError(err instanceof Error ? err.message : 'Couldn’t load this right now. Try refreshing.');
      });
    return () => { cancelled = true; };
  }, [authLoading, session, slug, navigate]);

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
  const perWeek = form.postsPerWeek ?? page.recommendedPerWeek;
  const ticked = new Set(form.channelIds);
  const tickedServices = buffer.connected ? buffer.channels.filter(c => ticked.has(c.id)).map(c => c.service) : [];
  const canSwitchOn = Boolean(form.organizationId) && form.channelIds.length > 0;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-text-primary">Promote</h2>
        <p className="text-sm text-text-secondary">
          Posts about your releases, on a gentle weekly rhythm, scheduled to your own Buffer. Unstream writes nothing with AI: each
          post is one of the templates below, filled with facts about the release. Every post lands in Buffer three days before it
          goes out, where you can change or delete it.
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
            <p className="text-sm text-text-secondary">Connect the Buffer account that holds your band’s channels. Buffer’s free plan is enough.</p>
            <button type="button" disabled={busy} onClick={connect} className={PRIMARY_BUTTON}>Connect Buffer</button>
          </div>
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
            {buffer.organizations.length === 1 && !form.organizationId && (
              <button type="button" onClick={() => update({ organizationId: buffer.organizations[0].id })} className={SECONDARY_BUTTON}>
                Use {buffer.organizations[0].name}
              </button>
            )}
            {form.organizationId && form.organizationId !== buffer.organizationId && (
              <p className="text-xs text-text-muted">Save to see this organization’s channels.</p>
            )}
            {form.organizationId && form.organizationId === buffer.organizationId && (
              buffer.channels.length === 0 ? (
                <p className="text-sm text-text-secondary">This organization has no channels in Buffer yet.</p>
              ) : (
                <fieldset className="space-y-1">
                  <legend className="text-sm text-text-secondary mb-1">Channels</legend>
                  {buffer.channels.map(c => (
                    <label key={c.id} className={`flex items-center gap-2 text-sm ${c.supported ? '' : 'text-text-muted'}`}>
                      <input
                        type="checkbox"
                        disabled={!c.supported}
                        checked={ticked.has(c.id)}
                        onChange={e => update({ channelIds: e.target.checked ? [...form.channelIds, c.id] : form.channelIds.filter(id => id !== c.id) })}
                      />
                      {c.name} <span className="text-text-muted">({c.service}{c.supported ? '' : ', not supported'})</span>
                    </label>
                  ))}
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
        <label className="flex flex-wrap items-center gap-2 text-sm">
          Posts a week
          <select
            value={form.postsPerWeek ?? ''}
            onChange={e => update({ postsPerWeek: e.target.value ? Number(e.target.value) : null })}
            className="px-2 py-1 bg-bg-primary border border-border rounded-lg"
          >
            <option value="">Recommended ({page.recommendedPerWeek || 1} a week)</option>
            {[1, 2, 3, 4, 5, 6, 7].map(n => <option key={n} value={n}>{n} a week</option>)}
          </select>
        </label>
        <p className="text-xs text-text-muted">{cadenceLine(page.releaseCount, perWeek || 1)} Fridays always post; more a week adds Monday to Thursday first.</p>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          Posting time
          <input type="time" value={form.postTime} onChange={e => update({ postTime: e.target.value })} className="px-2 py-1 bg-bg-primary border border-border rounded-lg" />
          <span className="text-xs text-text-muted">{form.timezone}</span>
        </label>
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

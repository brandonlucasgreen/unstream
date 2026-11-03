import { useEffect, useMemo, useRef } from 'react';
import { isImageFirstNetwork, networkName } from '../../../../api/shared/autopost-networks';
import { releaseTemplateVars, renderTemplate, templateProblems } from '../../../../api/shared/autopost-templates';
import { stepLabel } from '../../../../api/shared/campaign-steps';
import type { AutopostDay, CampaignPostDraft, CampaignRelease } from '../services/promote';

// One release campaign being planned or edited, on the Campaigns tab of the Promote page: a
// calendar of its weeks showing where its posts and autopost's fall, then one card per post with
// its date, words, a live preview and its image. Posts already in Buffer are shown, not edited.
// The template language and its facts are the shared ones, so the preview is what will post.

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function formatDate(date: string, options: Intl.DateTimeFormatOptions) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
}

const sent = (p: CampaignPostDraft) => p.status === 'pushed' || p.status === 'pushing';

export interface ImageChoice {
  key: string;
  url: string | null;
  label: string;
  /** False for an upload outside Instagram's shape range. */
  instagramOk: boolean;
}

export function CampaignEditor({
  release, releaseDate, posts, autopost, today, services, images, artist, problems, onChange,
}: {
  release: CampaignRelease;
  releaseDate: string;
  posts: CampaignPostDraft[];
  autopost: AutopostDay[];
  today: string;
  /** The networks campaign posts go to. */
  services: string[];
  images: ImageChoice[];
  artist: { name: string; slug: string };
  /** What the server refused, by the post's place among the unsent ones. */
  problems?: Record<string, string[]>;
  onChange: (next: { releaseDate: string; posts: CampaignPostDraft[] }) => void;
}) {
  const ordered = useMemo(() => [...posts].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)), [posts]);
  const imageFirst = services.filter(isImageFirstNetwork);

  const setPost = (target: CampaignPostDraft, patch: Partial<CampaignPostDraft>) =>
    onChange({ releaseDate, posts: posts.map(p => (p === target ? { ...p, ...patch } : p)) });

  // Moving release day moves every post not yet in Buffer with it.
  const moveRelease = (next: string) => {
    if (!next) return;
    const shift = daysBetween(releaseDate, next);
    onChange({ releaseDate: next, posts: posts.map(p => (sent(p) ? p : { ...p, date: addDays(p.date, shift) })) });
  };

  const addPost = () => {
    const taken = new Set(posts.map(p => p.date));
    let date = ordered.length ? addDays(ordered[ordered.length - 1].date, 2) : addDays(today, 1);
    while (taken.has(date)) date = addDays(date, 1);
    onChange({ releaseDate, posts: [...posts, { step: 'custom', date, text: '', imageKey: images[0]?.key ?? null }] });
  };

  // Problems arrive numbered among the unsent posts, in the order they were sent.
  const unsent = posts.filter(p => !sent(p));
  const problemsFor = (p: CampaignPostDraft) => problems?.[String(unsent.indexOf(p))] ?? [];

  return (
    <div className="space-y-4">
      <label className="flex flex-wrap items-center gap-2 text-sm">
        Release date
        <input
          type="date"
          value={releaseDate}
          onChange={e => moveRelease(e.target.value)}
          className="px-2 py-1 bg-bg-primary border border-border rounded-lg"
        />
        <span className="text-xs text-text-muted">Moving it moves the posts with it.</span>
      </label>

      <CampaignCalendar posts={ordered} autopost={autopost} releaseDate={releaseDate} />

      <p className="text-xs text-text-muted">
        Posts can use {'{title}'}, {'{date}'}, {'{where}'}, {'{price}'} and {'{link}'}, filled in when they go out.
      </p>

      <ol className="space-y-3">
        {ordered.map((post, i) => (
          <CampaignPostCard
            key={post.id ?? `new-${posts.indexOf(post)}`}
            post={post}
            index={i}
            release={release}
            releaseDate={releaseDate}
            artist={artist}
            images={images}
            imageFirst={imageFirst}
            problems={problemsFor(post)}
            onChange={patch => setPost(post, patch)}
            onRemove={() => onChange({ releaseDate, posts: posts.filter(p => p !== post) })}
          />
        ))}
      </ol>

      <button type="button" onClick={addPost} className="text-sm text-link hover:underline">+ Add a post</button>
    </div>
  );
}

/** The campaign's weeks, Monday first: its posts, autopost's, and release day. */
function CampaignCalendar({ posts, autopost, releaseDate }: { posts: CampaignPostDraft[]; autopost: AutopostDay[]; releaseDate: string }) {
  if (posts.length === 0) return null;
  const dates = [...posts.map(p => p.date), releaseDate].sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const start = addDays(first, -((new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7));
  const weeks = Math.min(16, Math.ceil((daysBetween(start, last) + 1) / 7));
  const campaignDays = new Set(posts.map(p => p.date));
  const autopostDays = new Set(autopost.map(a => a.date));

  return (
    <div className="max-w-md space-y-1.5" aria-label="Calendar">
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] uppercase tracking-wide text-text-muted" aria-hidden="true">
        {Array.from({ length: 7 }, (_, i) => <span key={i}>{formatDate(addDays(start, i), { weekday: 'narrow' })}</span>)}
      </div>
      <ol className="grid grid-cols-7 gap-1">
        {Array.from({ length: weeks * 7 }, (_, i) => {
          const day = addDays(start, i);
          const campaign = campaignDays.has(day);
          const auto = autopostDays.has(day);
          const isRelease = day === releaseDate;
          const what = [campaign && 'campaign post', auto && 'autopost', isRelease && 'release day'].filter(Boolean).join(', ');
          return (
            <li
              key={day}
              aria-label={`${formatDate(day, { weekday: 'long', month: 'short', day: 'numeric' })}${what ? `: ${what}` : ''}`}
              className={`relative rounded-md py-1 text-center text-xs ${
                campaign ? 'bg-accent-primary text-accent-foreground font-medium'
                  : auto ? 'border border-accent-primary text-text-primary'
                    : 'text-text-muted'
              } ${isRelease ? 'ring-2 ring-offset-1 ring-offset-bg-primary ring-accent-primary' : ''}`}
            >
              {/* A month's first day carries its name, so 30, 1 reads as a new month. */}
              <span aria-hidden="true">{day.endsWith('-01') ? formatDate(day, { month: 'short', day: 'numeric' }) : formatDate(day, { day: 'numeric' })}</span>
            </li>
          );
        })}
      </ol>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-accent-primary" />Campaign</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border border-accent-primary" />Autopost</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm ring-2 ring-accent-primary" />Release day</span>
      </p>
    </div>
  );
}

function CampaignPostCard({
  post, index, release, releaseDate, artist, images, imageFirst, problems, onChange, onRemove,
}: {
  post: CampaignPostDraft;
  index: number;
  release: CampaignRelease;
  releaseDate: string;
  artist: { name: string; slug: string };
  images: ImageChoice[];
  imageFirst: string[];
  problems: string[];
  onChange: (patch: Partial<CampaignPostDraft>) => void;
  onRemove: () => void;
}) {
  const locked = sent(post);
  const preview = useMemo(() => {
    const broken = templateProblems(post.text);
    if (!post.text.trim()) return { text: null, problem: null };
    if (broken.length) return { text: null, problem: broken[0] };
    const vars = releaseTemplateVars({ ...release.template, releaseDate, datePrecision: 'day' }, artist, { postDate: post.date, instagram: false });
    const text = renderTemplate(post.text, vars);
    return text ? { text, problem: null } : { text: null, problem: 'Uses a fact Unstream doesn’t have for this release' };
  }, [post.text, post.date, release, releaseDate, artist]);

  const image = images.find(i => i.key === post.imageKey) ?? null;
  const skips = imageFirst.length > 0 && (!image || !image.instagramOk)
    ? imageFirst.filter(s => image === null || s === 'instagram').map(networkName)
    : [];
  const textId = `campaign-post-${index}`;

  // The textarea grows with its words rather than scrolling inside itself.
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [post.text]);

  return (
    <li className="space-y-2 rounded-lg border border-border bg-bg-primary p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-text-primary">{stepLabel(post.step)}</span>
          {locked ? (
            <span className="text-text-muted">· {formatDate(post.date, { weekday: 'short', month: 'short', day: 'numeric' })} · In Buffer</span>
          ) : (
            <input
              type="date"
              aria-label="Date"
              value={post.date}
              onChange={e => e.target.value && onChange({ date: e.target.value })}
              className="px-2 py-0.5 bg-bg-primary border border-border rounded-lg text-sm"
            />
          )}
        </div>
        {!locked && (
          <button type="button" onClick={onRemove} className="shrink-0 py-1 text-xs text-text-muted hover:text-error">Remove</button>
        )}
      </div>

      {locked ? (
        <p className="text-sm text-text-primary whitespace-pre-line break-words">{preview.text ?? post.text}</p>
      ) : (
        <>
          <label htmlFor={textId} className="sr-only">Post</label>
          <textarea
            id={textId}
            ref={area}
            rows={2}
            value={post.text}
            onChange={e => onChange({ text: e.target.value })}
            className="w-full resize-none overflow-hidden rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm font-mono"
          />
          {preview.text && <p className="text-sm text-text-secondary whitespace-pre-line break-words">{preview.text}</p>}
        </>
      )}

      {!locked && (
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Image">
          {images.map(choice => (
            <button
              key={choice.key}
              type="button"
              role="radio"
              aria-checked={post.imageKey === choice.key}
              aria-label={choice.label}
              title={choice.label}
              onClick={() => onChange({ imageKey: choice.key })}
              className={`h-10 w-10 overflow-hidden rounded-md border-2 ${post.imageKey === choice.key ? 'border-accent-primary' : 'border-transparent opacity-70 hover:opacity-100'}`}
            >
              {choice.url ? <img src={choice.url} alt="" className="h-full w-full object-cover" /> : <span className="block h-full w-full bg-bg-secondary" />}
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={post.imageKey === null}
            onClick={() => onChange({ imageKey: null })}
            className={`h-10 rounded-md border-2 px-2 text-xs ${post.imageKey === null ? 'border-accent-primary text-text-primary' : 'border-border text-text-muted'}`}
          >
            None
          </button>
        </div>
      )}

      {(skips.length > 0 || preview.problem || problems.length > 0) && (
        <ul className="space-y-0.5 text-xs">
          {skips.length > 0 && <li className="text-warning">{image ? 'This image is the wrong shape for' : 'No image, so it skips'} {skips.join(' and ')}</li>}
          {[...new Set([...(preview.problem ? [preview.problem] : []), ...problems])].map(p => <li key={p} className="text-error">{p}</li>)}
        </ul>
      )}
      {post.status === 'failed' && post.error && <p className="text-xs text-warning">Last try: {post.error}</p>}
    </li>
  );
}

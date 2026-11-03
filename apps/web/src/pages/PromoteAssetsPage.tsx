import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { TabSkeleton } from './ArtistSettingsLayout';
import { ACCEPTED_TYPES, prepareUpload } from '../services/promoteImages';
import {
  getPromoteAssets,
  PromoteApiError,
  removePromoteAsset,
  uploadPromoteAsset,
  type PromoteAssets,
} from '../services/promote';

// /promote/:slug/assets — the asset library, a tab of the Promote page (Brandon, 2026-11-02).
// Images the artist uploads for their posts: autopost puts them in turn on its posts that aren't
// about a release, and campaign posts can use any of them. Images only for now; the library may
// hold other media later. Kept as short as the Autopost tab: one line of what it's for, then the
// images.

type Loaded = Extract<PromoteAssets, { available: true }>;

const SECTION = 'space-y-3 rounded-xl border border-border bg-bg-secondary/40 p-4';

export function PromoteAssetsPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { session, isLoading: authLoading } = useAuth();
  const [library, setLibrary] = useState<PromoteAssets | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const tokenRef = useRef(session?.access_token);
  tokenRef.current = session?.access_token;
  const userId = session?.user?.id;

  useEffect(() => {
    if (authLoading) return;
    if (!userId || !tokenRef.current) {
      if (slug) navigate(`/login?next=${encodeURIComponent(`/promote/${encodeURIComponent(slug)}/assets`)}`, { replace: true });
      return;
    }
    if (!slug) return;
    let cancelled = false;
    getPromoteAssets(tokenRef.current, slug)
      .then(l => { if (!cancelled) setLibrary(l); })
      .catch(err => {
        if (cancelled) return;
        if (!(err instanceof PromoteApiError) || err.status >= 500) Sentry.captureException(err, { extra: { context: 'PromoteAssetsPage.load', slug } });
        setLoadError(err instanceof Error ? err.message : 'Couldn’t load this right now. Try refreshing.');
      });
    return () => { cancelled = true; };
  }, [authLoading, userId, slug, navigate]);

  if (!slug) return null;
  if (loadError) return <p className="text-sm text-error">{loadError}</p>;
  if (!library || !session) return <TabSkeleton label="Loading" />;
  if (!library.available) return <p className="text-sm text-text-muted">The asset library isn’t available on Unstream yet.</p>;

  const loaded: Loaded = library;
  const room = loaded.max - loaded.assets.length;
  const busy = progress !== null || removing !== null;

  const upload = async (files: File[]) => {
    setError(null);
    const chosen = files.slice(0, room);
    const skipped = files.length - chosen.length;
    const failed: string[] = [];
    let latest: PromoteAssets = loaded;
    for (const [i, file] of chosen.entries()) {
      setProgress(chosen.length > 1 ? `Uploading ${i + 1} of ${chosen.length}…` : 'Uploading…');
      let data: string;
      try {
        data = await prepareUpload(file);
      } catch {
        failed.push(`Couldn’t read ${file.name}. Use a JPEG, PNG, WebP or GIF.`);
        continue;
      }
      try {
        latest = await uploadPromoteAsset(session.access_token, slug, data);
        setLibrary(latest);
      } catch (err) {
        if (!(err instanceof PromoteApiError) || err.status >= 500) Sentry.captureException(err, { extra: { context: 'PromoteAssetsPage.upload', slug } });
        failed.push(err instanceof PromoteApiError ? err.message : `Couldn’t upload ${file.name}. Try again.`);
      }
    }
    if (skipped > 0) failed.push(`Your library holds ${loaded.max} images, so ${skipped} weren’t added.`);
    setError(failed.length ? failed.join(' ') : null);
    setProgress(null);
  };

  const remove = async (id: string) => {
    setError(null);
    setRemoving(id);
    try {
      setLibrary(await removePromoteAsset(session.access_token, slug, id));
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'PromoteAssetsPage.remove', slug } });
      setError('Couldn’t remove that image. Try again.');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-secondary">
        Photos and artwork for your posts. Autopost uses them on posts that aren’t about a release, and you can pick them for
        campaign posts.
      </p>

      <section className={SECTION} aria-labelledby="assets-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="assets-heading" className="font-medium text-text-primary">Images</h3>
          <span className="text-xs text-text-muted">{loaded.assets.length} of {loaded.max}</span>
        </div>

        <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {loaded.assets.map(asset => (
            <li key={asset.id} className="relative">
              <img
                src={asset.url}
                alt=""
                loading="lazy"
                className={`aspect-square w-full rounded-lg object-cover bg-bg-secondary ${removing === asset.id ? 'opacity-40' : ''}`}
              />
              {!asset.instagramOk && (
                <span
                  className="absolute left-1 bottom-1 rounded-full bg-bg-primary/90 px-1.5 py-0.5 text-[10px] text-text-secondary"
                  title="Instagram only takes images from 4:5 to 1.91:1, so this one is used on your other channels"
                >
                  Not for Instagram
                </span>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => remove(asset.id)}
                aria-label="Remove image"
                className="absolute right-1 top-1 inline-flex h-7 w-7 items-center justify-center rounded-full bg-bg-primary/90 text-text-secondary hover:text-error disabled:opacity-50"
              >
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </li>
          ))}
          {room > 0 && (
            <li>
              <button
                type="button"
                disabled={busy}
                onClick={() => input.current?.click()}
                className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-sm text-text-secondary hover:bg-bg-secondary disabled:opacity-50"
              >
                <span aria-hidden="true" className="text-2xl leading-none">+</span>
                {progress ?? 'Add images'}
              </button>
            </li>
          )}
        </ul>
        <input
          ref={input}
          type="file"
          accept={ACCEPTED_TYPES}
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={e => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) void upload(files);
          }}
        />
        {progress && <p className="text-xs text-text-muted" role="status">{progress}</p>}
        {error && <p className="text-sm text-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}

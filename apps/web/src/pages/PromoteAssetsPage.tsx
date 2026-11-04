import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
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

const SECTION = 'relative space-y-3 rounded-xl border border-border bg-bg-secondary/40 p-4';

const IMAGE_TYPES = ACCEPTED_TYPES.split(',');

// Only a drag carrying files from the computer counts: dragging an image already on the page, or
// some selected text, mustn't light the drop zone up.
const isFileDrag = (e: ReactDragEvent | DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

export function PromoteAssetsPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { session, isLoading: authLoading } = useAuth();
  const [library, setLibrary] = useState<PromoteAssets | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter and dragleave fire for every child the pointer crosses, so count them rather than
  // toggling on each, or the highlight flickers as the drag passes over the thumbnails.
  const dragDepth = useRef(0);
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

  // A file dropped just outside the drop zone would otherwise make the browser open it in place of
  // this page. Refuse file drops everywhere else on the page while it's open.
  useEffect(() => {
    const refuse = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', refuse);
    window.addEventListener('drop', refuse);
    return () => {
      window.removeEventListener('dragover', refuse);
      window.removeEventListener('drop', refuse);
    };
  }, []);

  if (!slug) return null;
  if (loadError) return <p className="text-sm text-error">{loadError}</p>;
  if (!library || !session) return <TabSkeleton label="Loading" />;
  if (!library.available) return <p className="text-sm text-text-muted">The asset library isn’t available on Unstream yet.</p>;

  const loaded: Loaded = library;
  const room = loaded.max - loaded.assets.length;
  const busy = progress !== null || removing !== null;

  const upload = async (files: File[]) => {
    setError(null);
    // The file picker filters by type but a drop doesn't, so a PDF or a video dropped alongside
    // images is set aside here rather than taking one of the library's places.
    const images = files.filter(f => IMAGE_TYPES.includes(f.type));
    const failed: string[] = files
      .filter(f => !IMAGE_TYPES.includes(f.type))
      .map(f => `${f.name} isn’t an image. Use a JPEG, PNG, WebP or GIF.`);
    const chosen = images.slice(0, room);
    const skipped = images.length - chosen.length;
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

  const endDrag = () => {
    dragDepth.current = 0;
    setDragging(false);
  };

  const dropZone = {
    onDragEnter: (e: ReactDragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: ReactDragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = room > 0 && !busy ? 'copy' : 'none';
    },
    onDragLeave: (e: ReactDragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: ReactDragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      endDrag();
      const files = Array.from(e.dataTransfer.files);
      if (files.length && room > 0 && !busy) void upload(files);
    },
  };

  const dropMessage = busy
    ? 'Wait for this upload to finish'
    : room > 0
      ? 'Drop images to add them'
      : `Your library is full (${loaded.max} images). Remove one to add another.`;

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

      <section className={SECTION} aria-labelledby="assets-heading" {...dropZone}>
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
                {!progress && <span className="hidden text-xs text-text-muted sm:block">or drop them here</span>}
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
        {dragging && (
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 m-0 flex items-center justify-center rounded-xl border-2 border-dashed bg-bg-primary/85 p-4 text-center text-sm font-medium ${
              room > 0 && !busy ? 'border-accent text-text-primary' : 'border-border text-text-secondary'
            }`}
          >
            {dropMessage}
          </div>
        )}
        {progress && <p className="text-xs text-text-muted" role="status">{progress}</p>}
        {error && <p className="text-sm text-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}

import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  setCityInterest,
  setTipInterest,
  suggestCities,
  useMyInterest,
  type InterestCounts,
} from '../services/artistInterest';
import { formatCityCounts } from '../../../../api/shared/artist-interest';
import { GoalProgress } from './GoalProgress';
import type { TipGoal } from '../types/artist-page';

// Tip / "I'd tip them" and Play my city (docs/specs/artist-patronage-spec.md §3.1, §3.5, §3.6), for
// a result card and the artist page. No money moves in this component: Tip is a link to /tip/{slug},
// where hosted Stripe Checkout takes over. For an artist who can't take tips yet, "I'd tip them"
// records that a fan would, and the count is what prompts the artist to claim their profile.

interface ArtistSupportActionsProps {
  slug: string;
  artistName: string;
  /** Public counts (already at or above the threshold of three), from the page or search payload. */
  interest?: InterestCounts;
  variant: 'card' | 'page';
  /** Page variant, unclaimed artist: where "Claim your profile" goes. */
  claimHref?: string;
  /** The artist takes tips now: Tip replaces "I'd tip them". */
  tipsEnabled?: boolean;
  /** Page variant: the artist's open goals, shown while they take tips. */
  goals?: TipGoal[];
}

const pillClass =
  'inline-flex items-center gap-1.5 min-h-11 px-3 py-2 rounded-lg border text-sm transition-colors';
const idleClass = 'border-border text-text-primary hover:bg-bg-hover';
const activeClass = 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary';

export function ArtistSupportActions({ slug, artistName, interest, variant, claimHref, tipsEnabled = false, goals = [] }: ArtistSupportActionsProps) {
  const { session } = useAuth();
  const mine = useMyInterest(session);
  const [signInPrompt, setSignInPrompt] = useState(false);
  const [editingCity, setEditingCity] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wouldTip = mine?.tip.has(slug) ?? false;
  const myCity = mine?.cities[slug] ?? null;
  const tipCount = interest?.tipCount ?? 0;
  const cities = interest?.cities ?? [];

  const requireSession = (e: React.MouseEvent): string | null => {
    e.stopPropagation();
    e.preventDefault();
    if (!session) {
      setSignInPrompt(true);
      return null;
    }
    return session.access_token;
  };

  const toggleTip = async (e: React.MouseEvent) => {
    const token = requireSession(e);
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    setError(await setTipInterest(token, slug, !wouldTip));
    setBusy(false);
  };

  const openCity = (e: React.MouseEvent) => {
    if (!requireSession(e)) return;
    setError(null);
    setEditingCity(true);
  };

  return (
    <div className="space-y-2" onClick={e => e.stopPropagation()}>
      <div className="flex flex-wrap gap-2">
        {tipsEnabled ? (
          <Link
            to={`/tip/${slug}`}
            className={`${pillClass} border-accent-primary bg-accent-primary text-white hover:bg-accent-primary/90`}
          >
            <span aria-hidden="true">♥</span>
            Tip {artistName}
          </Link>
        ) : (
        <button
          type="button"
          onClick={toggleTip}
          disabled={busy}
          aria-pressed={wouldTip}
          title={`${artistName} isn't taking tips on Unstream yet. Tell them you would — nothing is charged.`}
          className={`${pillClass} ${wouldTip ? activeClass : idleClass} disabled:opacity-60`}
        >
          <span aria-hidden="true">{wouldTip ? '✓' : '♥'}</span>
          {wouldTip ? "You'd tip them" : "I'd tip them"}
          {variant === 'card' && tipCount > 0 && (
            <span className="text-text-muted">· {tipCount}</span>
          )}
        </button>
        )}
        <button
          type="button"
          onClick={openCity}
          aria-expanded={editingCity}
          className={`${pillClass} ${myCity ? activeClass : idleClass}`}
        >
          <span aria-hidden="true">{myCity ? '✓' : '📍'}</span>
          {myCity ? `Play ${myCity}` : 'Play my city'}
        </button>
      </div>

      {signInPrompt && !session && (
        <p className="text-xs text-text-secondary">
          <Link to="/login" className="text-accent-primary hover:underline">Sign in</Link>
          {' '}to tell {artistName} — it's free, and nothing is charged.
        </p>
      )}

      {editingCity && session && (
        <CityForm
          token={session.access_token}
          artistName={artistName}
          initial={myCity ?? mine?.defaultCity ?? ''}
          canRemove={!!myCity}
          onDone={async (city) => {
            if (city === undefined) { setEditingCity(false); return; }
            setBusy(true);
            const err = await setCityInterest(session.access_token, slug, city);
            setBusy(false);
            setError(err);
            if (!err) setEditingCity(false);
          }}
          busy={busy}
        />
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      {variant === 'card' && cities.length > 0 && (
        <p className="text-xs text-text-muted">Most wanted in: {formatCityCounts(cities.slice(0, 3))}</p>
      )}

      {variant === 'page' && tipsEnabled && goals.length > 0 && (
        <div className="space-y-3 pt-1">
          {goals.map(goal => (
            <Link key={goal.id} to={`/tip/${slug}?goal=${goal.id}`} className="block rounded-lg p-2 -mx-2 hover:bg-bg-hover transition-colors">
              <GoalProgress goal={goal} />
            </Link>
          ))}
        </div>
      )}

      {variant === 'page' && (tipCount > 0 || cities.length > 0) && (
        <div className="text-sm text-text-secondary space-y-1">
          {tipCount > 0 && !tipsEnabled && (
            <p>
              {tipCount} fans want to tip {artistName}.
              {claimHref && (
                <> Are you {artistName}?{' '}
                  <Link to={claimHref} className="text-accent-primary hover:underline">Claim your profile</Link>.
                </>
              )}
            </p>
          )}
          {cities.length > 0 && <p>Most wanted in: {formatCityCounts(cities)}</p>}
        </div>
      )}
    </div>
  );
}

interface CityFormProps {
  token: string;
  artistName: string;
  initial: string;
  canRemove: boolean;
  busy: boolean;
  /** A city to save, null to remove, undefined to cancel. */
  onDone: (city: string | null | undefined) => void;
}

function CityForm({ token, artistName, initial, canRemove, busy, onDone }: CityFormProps) {
  const [city, setCity] = useState(initial);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const listId = useId();

  // Suggest cities other fans have named, so "Boston" and "boston, ma" converge on one count.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      suggestCities(token, city, controller.signal).then(setSuggestions);
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [token, city]);

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={e => { e.preventDefault(); if (city.trim()) onDone(city.trim()); }}
    >
      <label className="sr-only" htmlFor={`${listId}-input`}>Your city</label>
      <input
        id={`${listId}-input`}
        value={city}
        onChange={e => setCity(e.target.value)}
        list={listId}
        maxLength={100}
        autoFocus
        placeholder="Your city"
        className="flex-1 min-w-40 px-3 py-2 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
      />
      <datalist id={listId}>
        {suggestions.map(s => <option key={s} value={s} />)}
      </datalist>
      <button
        type="submit"
        disabled={busy || !city.trim()}
        className="px-3 py-2 text-sm font-medium bg-accent-primary text-white rounded-lg hover:bg-accent-primary/90 disabled:opacity-50"
      >
        Ask {artistName}
      </button>
      {canRemove && (
        <button type="button" disabled={busy} onClick={() => onDone(null)} className="px-2 py-2 text-sm text-text-muted hover:text-red-400">
          Remove
        </button>
      )}
      <button type="button" onClick={() => onDone(undefined)} className="px-2 py-2 text-sm text-text-muted hover:text-text-secondary">
        Cancel
      </button>
    </form>
  );
}

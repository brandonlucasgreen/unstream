import { SocialIcon } from './SocialIcon';
import { AVATAR_PLATFORMS, platformName } from './ClaimPageUtils';
import type { ReviewLink } from './ClaimPageTypes';

interface ClaimReviewStepProps {
  displayName: string;
  discoveredLinks: number;
  reviewLinks: ReviewLink[];
  setReviewLinks: (links: ReviewLink[]) => void;
  currentImageUrl: string | null;
  customImageUrl: string | null;
  setCustomImageUrl: (url: string | null) => void;
  fetchingAvatar: string | null;
  city: string;
  setCity: (city: string) => void;
  country: string;
  setCountry: (country: string) => void;
  loading: boolean;
  onFetchAvatar: (platform: string, url: string) => void;
  onConfirm: () => void;
}

export function ClaimReviewStep({
  displayName,
  discoveredLinks,
  reviewLinks,
  setReviewLinks,
  currentImageUrl,
  customImageUrl,
  setCustomImageUrl,
  fetchingAvatar,
  city,
  setCity,
  country,
  setCountry,
  loading,
  onFetchAvatar,
  onConfirm,
}: ClaimReviewStepProps) {
  return (
    <div className="space-y-6">
      <div className="text-center space-y-1">
        <p className="text-lg font-bold">Review your profile</p>
        <p className="text-sm text-text-muted">
          We found {discoveredLinks} link{discoveredLinks === 1 ? '' : 's'} from your website.
          Uncheck any that don't belong to you, then confirm.
        </p>
      </div>

      {/* Photo section */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Profile Photo</h2>
        <div className="flex items-start gap-4">
          <div className="w-20 h-20 rounded-full bg-bg-secondary border border-border flex items-center justify-center overflow-hidden flex-shrink-0">
            {(customImageUrl || currentImageUrl) ? (
              <img
                src={customImageUrl || currentImageUrl || ''}
                alt={displayName}
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-2xl text-text-muted">
                {displayName.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex-1 space-y-2">
            {customImageUrl ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-green-400">New photo selected</span>
                <button
                  onClick={() => setCustomImageUrl(null)}
                  className="text-xs text-text-muted hover:text-text-primary"
                >
                  Undo
                </button>
              </div>
            ) : currentImageUrl ? (
              <p className="text-sm text-text-muted">
                This photo was auto-discovered. If it's wrong, pull a new one from one of your platforms:
              </p>
            ) : (
              <p className="text-sm text-text-muted">
                No photo found. Pull one from a platform:
              </p>
            )}
            {!customImageUrl && (
              <div className="flex flex-wrap gap-2">
                {reviewLinks
                  .filter(l => l.checked && AVATAR_PLATFORMS.has(l.platform))
                  .map(l => (
                    <button
                      key={l.platform}
                      onClick={() => onFetchAvatar(l.platform, l.url)}
                      disabled={fetchingAvatar !== null}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-secondary border border-border text-sm hover:border-accent-primary transition-colors disabled:opacity-50"
                    >
                      <SocialIcon platform={l.platform} className="w-3.5 h-3.5" />
                      {fetchingAvatar === l.platform ? 'Loading...' : `Use ${platformName(l.platform)} photo`}
                    </button>
                  ))}
                {reviewLinks.filter(l => l.checked && AVATAR_PLATFORMS.has(l.platform)).length === 0 && (
                  <p className="text-xs text-text-muted">
                    No supported platforms found. You can update your photo later from the editor.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Location section */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">Location</h2>
        <p className="text-xs text-text-muted">
          We pre-filled this from public data where we could. Correct it if it's wrong or leave blank to skip.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            type="text"
            value={city}
            onChange={e => setCity(e.target.value.slice(0, 100))}
            placeholder="City"
            aria-label="City"
            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
          />
          <input
            type="text"
            value={country}
            onChange={e => setCountry(e.target.value.slice(0, 100))}
            placeholder="Country"
            aria-label="Country"
            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
          />
        </div>
      </section>

      {/* Links section */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Your Links</h2>
        <div className="space-y-1">
          {reviewLinks.map((link, index) => (
            <label
              key={`${link.platform}-${index}`}
              className={`flex items-center gap-3 p-3 rounded-lg border transition-colors cursor-pointer ${
                link.checked
                  ? 'bg-bg-secondary border-border'
                  : 'bg-bg-primary border-border/50 opacity-50'
              }`}
            >
              <input
                type="checkbox"
                checked={link.checked}
                onChange={() => {
                  const updated = [...reviewLinks];
                  updated[index] = { ...updated[index], checked: !updated[index].checked };
                  setReviewLinks(updated);
                }}
                className="w-4 h-4 rounded accent-accent-primary flex-shrink-0"
              />
              <SocialIcon platform={link.platform} className="w-4.5 h-4.5" />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium">{platformName(link.platform)}</span>
                <p className="text-xs text-text-muted truncate">{link.url}</p>
              </div>
            </label>
          ))}
        </div>
        {reviewLinks.length === 0 && (
          <p className="text-sm text-text-muted text-center py-2">
            No links discovered. You can add links later from your dashboard.
          </p>
        )}
      </section>

      {/* Confirm */}
      <button
        onClick={onConfirm}
        disabled={loading}
        className="w-full py-3 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
      >
        {loading ? 'Saving...' : 'This looks good — go to my page'}
      </button>
    </div>
  );
}

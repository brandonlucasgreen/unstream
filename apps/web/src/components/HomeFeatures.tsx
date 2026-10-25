import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScreenshotCarousel } from './ScreenshotCarousel';

type Accent = 'primary' | 'secondary' | 'tertiary';

// Tile tint and icon chip per accent. Spelled out in full so Tailwind sees the
// class names. Tertiary (yellow) gets a stronger tint because it washes out at
// the same strength as the other two.
const ACCENT_CLASSES: Record<Accent, { tile: string; chip: string }> = {
  primary: { tile: 'bg-fill-primary/10', chip: 'bg-fill-primary' },
  secondary: { tile: 'bg-fill-secondary/10', chip: 'bg-fill-secondary' },
  tertiary: { tile: 'bg-fill-tertiary/15', chip: 'bg-fill-tertiary' },
};

// Outline icons, drawn on a 24-unit grid like the rest of the app's inline SVGs.
const ICONS: Record<string, ReactNode> = {
  tip: <path d="M12 20.5s-7.5-4.4-7.5-10A4.5 4.5 0 0112 7.6a4.5 4.5 0 017.5 2.9c0 5.6-7.5 10-7.5 10z" />,
  detection: (
    <>
      <path d="M4 15v-3a8 8 0 0116 0v3" />
      <rect x="3.5" y="14" width="4" height="6" rx="1.5" />
      <rect x="16.5" y="14" width="4" height="6" rx="1.5" />
    </>
  ),
  save: <path d="M6.5 4h11a1 1 0 011 1v15l-6.5-4-6.5 4V5a1 1 0 011-1z" />,
  release: (
    <>
      <path d="M18 15.5V11a6 6 0 00-12 0v4.5L4.5 17.5h15L18 15.5z" />
      <path d="M10 20a2 2 0 004 0" />
    </>
  ),
  scrobble: <path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0" />,
  anonymous: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
};

// Ordered so no two neighbouring tiles share a colour in the two-column grid.
const FEATURES: { key: string; accent: Accent }[] = [
  { key: 'tip', accent: 'primary' },
  { key: 'detection', accent: 'secondary' },
  { key: 'save', accent: 'tertiary' },
  { key: 'release', accent: 'primary' },
  { key: 'scrobble', accent: 'secondary' },
  { key: 'anonymous', accent: 'tertiary' },
];

export function HomeFeatures() {
  const { t } = useTranslation();

  return (
    <div className="bg-surface-secondary rounded-2xl border border-border overflow-hidden">
      <div className="p-6 md:p-8">
        <h2 className="font-display text-3xl md:text-4xl font-extrabold text-text-primary mb-6 text-center md:text-left heading-accent">
          {t('artist:features.heading')}
        </h2>
        <div className="flex flex-col md:flex-row items-start gap-8">
          <div className="flex-1 grid md:grid-cols-2 gap-3">
            {FEATURES.map(({ key, accent }) => (
              <div key={key} className={`rounded-xl p-4 ${ACCENT_CLASSES[accent].tile}`}>
                <div
                  className={`w-9 h-9 mb-3 rounded-lg grid place-items-center text-accent-foreground ${ACCENT_CLASSES[accent].chip}`}
                  aria-hidden="true"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    {ICONS[key]}
                  </svg>
                </div>
                <h3 className="font-semibold text-text-primary mb-1">{t(`artist:features.${key}Title`)}</h3>
                <p className="text-text-secondary text-sm">{t(`artist:features.${key}Body`)}</p>
              </div>
            ))}
          </div>
          <div className="flex-shrink-0 w-full md:w-auto flex justify-center md:justify-start">
            <ScreenshotCarousel />
          </div>
        </div>
      </div>

      {/* The support ask, as a full-width band rather than a line of grey text. */}
      <p className="bg-fill-primary text-accent-foreground text-center font-medium px-6 py-4">
        {t('artist:features.freeBody')}{' '}
        <a href="/support" className="underline decoration-2 underline-offset-4 hover:no-underline">
          <strong>{t('artist:features.freeSupportLink')}</strong>
        </a> 🤘
      </p>
    </div>
  );
}

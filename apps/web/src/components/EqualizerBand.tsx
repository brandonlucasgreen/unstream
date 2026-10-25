import { useEffect, useRef, useState } from 'react';

// The homepage's hero graphic: the `.eq-bars` loading mark scaled up into a row
// of bars in the three accents, moving to a real song. The levels come from
// scripts/eq-envelope.py (bass on the left); no audio is loaded or played.
// Decorative, so the bars are hidden from screen readers.

const BAR_COUNT = 44; // one bar per band in data/eq-song.ts

// Keep in step with the file scripts/eq-envelope.py was last run on.
const SONG_CREDIT = {
  title: 'performance (single edit)',
  artist: 'Kid Lightbulbs',
  url: 'https://kidlightbulbs.bandcamp.com/album/performance-versions',
};

// Where the bars rest before the song data arrives, and for good under
// prefers-reduced-motion: a still arch, taller in the middle.
const RESTING = Array.from({ length: BAR_COUNT }, (_, i) => {
  const x = i / (BAR_COUNT - 1);
  const jitter = 0.6 + 0.4 * Math.abs(Math.sin(i * 1.7));
  return (0.3 + 0.7 * Math.sin(Math.PI * x) * jitter).toFixed(2);
});

export function EqualizerBand() {
  const barsRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let cancelled = false;
    let frameId = 0;
    let observer: IntersectionObserver | undefined;

    // A separate chunk, so the frames never hold up the homepage's first paint.
    // If it fails to load, the bars simply stay at rest: nothing to report.
    import('../data/eq-song').then(({ EQ_FRAMES, EQ_FRAME_RATE, EQ_BAND_COUNT }) => {
      const container = barsRef.current;
      if (cancelled || !container) return;

      const bars = Array.from(container.children) as HTMLElement[];
      const frameCount = EQ_FRAMES.length / EQ_BAND_COUNT;
      const level = (frame: number, band: number) =>
        parseInt(EQ_FRAMES[frame * EQ_BAND_COUNT + band], 36) / 35;
      const startedAt = performance.now();

      // The data has 20 frames a second; blending between neighbours keeps the
      // motion smooth at the screen's own refresh rate.
      const draw = (now: number) => {
        const position = ((now - startedAt) / 1000) * EQ_FRAME_RATE;
        const frame = Math.floor(position) % frameCount;
        const next = (frame + 1) % frameCount;
        const blend = position % 1;
        bars.forEach((bar, band) => {
          const value = level(frame, band) * (1 - blend) + level(next, band) * blend;
          bar.style.transform = `scaleY(${Math.max(0.06, value).toFixed(3)})`;
        });
        frameId = requestAnimationFrame(draw);
      };

      // Only animate while the band is on screen.
      observer = new IntersectionObserver(([entry]) => {
        cancelAnimationFrame(frameId);
        if (entry.isIntersecting) frameId = requestAnimationFrame(draw);
      });
      observer.observe(container);
      setPlaying(true);
    }).catch(() => {});

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
      observer?.disconnect();
    };
  }, []);

  return (
    <>
      <div ref={barsRef} className="eq-band" aria-hidden="true">
        {RESTING.map((scale, i) => (
          <span key={i} style={{ transform: `scaleY(${scale})` }} />
        ))}
      </div>
      {/* Space is held while the song loads so nothing jumps when it appears.
          `invisible` also hides it from screen readers until then. */}
      <p className={`text-center text-xs text-text-muted mb-[30px] ${playing ? '' : 'invisible'}`}>
        ♪{' '}
        <a href={SONG_CREDIT.url} target="_blank" rel="noopener noreferrer" className="hover:text-text-primary hover:underline">
          {SONG_CREDIT.title}
        </a>{' '}
        · {SONG_CREDIT.artist}
      </p>
    </>
  );
}

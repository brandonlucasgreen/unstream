// The homepage's hero graphic: the `.eq-bars` loading mark scaled up into a row
// of bars that breathe in the three accents. Purely decorative, so it's hidden
// from screen readers and holds still under prefers-reduced-motion (index.css).

const BAR_COUNT = 44;

// Heights rise toward the middle like a sound wave, with a little per-bar
// jitter so it doesn't read as a smooth arc. Computed once: the same shape on
// every render and every visit, no randomness to hydrate or flicker.
const BARS = Array.from({ length: BAR_COUNT }, (_, i) => {
  const x = i / (BAR_COUNT - 1);
  const jitter = 0.6 + 0.4 * Math.abs(Math.sin(i * 1.7));
  return {
    height: Math.round((0.3 + 0.7 * Math.sin(Math.PI * x) * jitter) * 100),
    low: (0.35 + 0.3 * Math.abs(Math.cos(i * 2.3))).toFixed(2),
    delay: (-((i * 0.11) % 1.4)).toFixed(2),
  };
});

export function EqualizerBand() {
  return (
    <div className="eq-band" aria-hidden="true">
      {BARS.map((bar, i) => (
        <span
          key={i}
          style={{
            height: `${bar.height}%`,
            animationDelay: `${bar.delay}s`,
            ['--eq-low' as string]: bar.low,
          }}
        />
      ))}
    </div>
  );
}

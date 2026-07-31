import { useCallback, useEffect, useRef, useState } from 'react';

/** Every shot is cropped to the same 640x783 box so the frame never resizes
    between slides. To add one, run the source PNG through:
      magick shot.png -gravity center -crop 960x1175+0+0 +repage \
        -resize 640x -quality 82 public/screenshots/name.webp */
const SLIDES = [
  {
    src: '/screenshots/macos-kidlightbulbs.webp',
    alt: 'The Unstream menu bar app showing Kid Lightbulbs playing, with links to Faircamp, Subvert, Bandcamp, Ampwall, Bandwagon and Qobuz.',
  },
  {
    src: '/screenshots/macos-liturgy.webp',
    alt: 'The Unstream menu bar app showing Liturgy playing, with the platforms that sell their music.',
  },
  {
    src: '/screenshots/macos-okayden.webp',
    alt: 'The Unstream menu bar app showing okayden playing, with the platforms that sell their music.',
  },
  {
    src: '/screenshots/macos-hudsonfreeman.webp',
    alt: 'The Unstream menu bar app showing Hudson Freeman on Bandcamp, plus suggested places to keep looking.',
  },
  {
    src: '/screenshots/macos-saved.webp',
    alt: 'The Saved tab of the Unstream menu bar app, listing nine saved artists.',
  },
];

const AUTOPLAY_MS = 5000;

export function ScreenshotCarousel() {
  const [index, setIndex] = useState(0);
  // Autoplay is a nicety, not the way you use this — any hover, focus, touch or
  // button press stops it for good so it never fights the person looking.
  const [autoplay, setAutoplay] = useState(true);
  const touchStartX = useRef<number | null>(null);

  const go = useCallback((next: number) => {
    setIndex((next + SLIDES.length) % SLIDES.length);
  }, []);

  const stopAutoplay = useCallback(() => setAutoplay(false), []);

  useEffect(() => {
    if (!autoplay) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % SLIDES.length);
    }, AUTOPLAY_MS);
    return () => window.clearInterval(timer);
  }, [autoplay]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    stopAutoplay();
    go(index + (event.key === 'ArrowRight' ? 1 : -1));
  };

  const handleTouchEnd = (event: React.TouchEvent) => {
    const startX = touchStartX.current;
    touchStartX.current = null;
    if (startX === null) return;
    const deltaX = event.changedTouches[0].clientX - startX;
    if (Math.abs(deltaX) < 40) return;
    stopAutoplay();
    go(index + (deltaX < 0 ? 1 : -1));
  };

  return (
    <div
      className="w-full md:w-80"
      role="group"
      aria-roledescription="carousel"
      aria-label="Unstream for macOS screenshots"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseEnter={stopAutoplay}
      onFocus={stopAutoplay}
      onTouchStart={(event) => { touchStartX.current = event.touches[0].clientX; }}
      onTouchEnd={handleTouchEnd}
    >
      <div className="relative aspect-[640/783] rounded-xl overflow-hidden border border-border shadow-2xl bg-bg-secondary">
        {SLIDES.map((slide, slideIndex) => (
          <img
            key={slide.src}
            src={slide.src}
            alt={slide.alt}
            width={640}
            height={783}
            /* Only the first shot is worth blocking paint for; the rest load
               lazily as the carousel gets to them. */
            loading={slideIndex === 0 ? 'eager' : 'lazy'}
            aria-hidden={slideIndex !== index}
            className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${
              slideIndex === index ? 'opacity-100' : 'opacity-0'
            }`}
          />
        ))}

        <button
          type="button"
          onClick={() => { stopAutoplay(); go(index - 1); }}
          aria-label="Previous screenshot"
          className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/50 text-white backdrop-blur-sm flex items-center justify-center hover:bg-black/70 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => { stopAutoplay(); go(index + 1); }}
          aria-label="Next screenshot"
          className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/50 text-white backdrop-blur-sm flex items-center justify-center hover:bg-black/70 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <div className="flex items-center justify-center gap-2 mt-3">
        {SLIDES.map((slide, slideIndex) => (
          <button
            key={slide.src}
            type="button"
            onClick={() => { stopAutoplay(); go(slideIndex); }}
            aria-label={`Show screenshot ${slideIndex + 1} of ${SLIDES.length}`}
            aria-current={slideIndex === index}
            className={`h-2 rounded-full transition-all ${
              slideIndex === index
                ? 'w-6 bg-accent-primary'
                : 'w-2 bg-border-hover hover:bg-text-muted'
            }`}
          />
        ))}
      </div>

      <span className="sr-only" aria-live="polite">
        Screenshot {index + 1} of {SLIDES.length}
      </span>
    </div>
  );
}

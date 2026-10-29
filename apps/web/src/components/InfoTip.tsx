import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

// A small "ⓘ" that explains the control beside it.
//
// It opens on a tap or click, not only on hover, because there's no hover on a phone, and a
// tooltip that only appears on hover is invisible to most artists checking this on their phone.
// It closes on Escape, on a tap outside, or on a second tap. The text is a real element the
// button points at (aria-controls, aria-expanded), so a screen reader can reach it.

export function InfoTip({ label, children }: {
  /** What the button says to a screen reader, e.g. "What does Post automatically do?" */
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapper = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onPointer = (e: PointerEvent) => {
      if (wrapper.current && !wrapper.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <span ref={wrapper} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(o => !o)}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border text-[11px] font-semibold text-text-muted hover:text-text-primary hover:border-border-hover"
      >
        i
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className="absolute bottom-full left-1/2 z-20 mb-2 w-72 max-w-[80vw] -translate-x-1/2 rounded-lg border border-border bg-bg-primary p-3 text-xs leading-relaxed text-text-secondary shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}

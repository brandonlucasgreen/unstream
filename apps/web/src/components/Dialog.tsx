import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

// The one modal primitive: a native <dialog> opened with showModal(), the pattern TipSheet
// established. The browser then does most of the work, and does it right:
//
// - the rest of the page is inert — not clickable, not focusable, hidden from screen readers;
// - Tab stays inside the dialog;
// - Escape fires `cancel` and closes it;
// - it sits in the top layer, above every z-index.
//
// What this adds on top:
//
// - **One close path.** Every way out — the close button, Escape, a backdrop click, the caller's
//   own buttons via the `close` handed to `children` — goes through dialog.close(), whose `close`
//   event is the only thing that calls `onClose`. Callers should call `close` rather than flip
//   their own state: unmounting an open dialog skips the focus restoration below.
// - **Focus goes back to the trigger.** Browsers differ on restoring focus after a modal closes,
//   so the element focused at open is refocused explicitly on close, if it is still on the page.
//   Done in the close handler rather than effect cleanup, so React's development double-mount
//   doesn't close the dialog it is about to reopen.
// - **Clicks and keys stay inside.** Dialogs open from inside clickable cards (a result card is
//   one big click target), so events are stopped at the dialog, as TipSheet does.
//
// `variant="drawer"` slides in from the right (the mobile nav). It closes without a slide-out:
// a <dialog> leaves the top layer the moment it closes, and holding it open to animate would mean
// a second, half-closed state that is still modal. `m-auto` on the centred variant is
// load-bearing: Tailwind's reset zeroes the margin the browser centres a <dialog> with.

export interface DialogProps {
  /** The id of the element that names the dialog, usually its heading. */
  labelledBy: string;
  /** Called once the dialog has closed, by whatever means. Unmount it here. */
  onClose: () => void;
  /** Element to focus on open. Defaults to the browser's choice: the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Element to focus on close. Defaults to whatever had focus when the dialog opened — which is
   * nothing in Safari, where clicking a button doesn't focus it. Pass the trigger when there is
   * one fixed trigger.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /**
   * False while something must not be interrupted (a request in flight): Escape and backdrop
   * clicks are ignored. The caller's own buttons still work.
   */
  dismissible?: boolean;
  variant?: 'centered' | 'drawer';
  /** Extra classes for the dialog element (width, padding). */
  className?: string;
  /** Content, or a function given `close` for the caller's own buttons. */
  children: ReactNode | ((close: () => void) => ReactNode);
}

const VARIANT_CLASSES = {
  centered:
    'm-auto w-full max-w-md max-h-[90vh] overflow-y-auto p-0 rounded-2xl border border-border bg-bg-primary text-text-primary shadow-xl backdrop:bg-black/60 max-sm:max-w-none max-sm:mb-0 max-sm:rounded-b-none',
  drawer:
    'dialog-drawer ml-auto mr-0 my-0 h-dvh max-h-dvh w-72 max-w-[85vw] p-0 border-l border-border bg-bg-primary text-text-primary shadow-2xl backdrop:bg-black/60',
};

export function Dialog({
  labelledBy,
  onClose,
  initialFocusRef,
  returnFocusRef,
  dismissible = true,
  variant = 'centered',
  className = '',
  children,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (!triggerRef.current && document.activeElement instanceof HTMLElement) {
        triggerRef.current = document.activeElement;
      }
      dialog.showModal();
      initialFocusRef?.current?.focus();
    }

    // The page behind can't be interacted with, but it can still scroll under the backdrop.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
    // Opened once per mount; the dialog's lifetime is the component's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => dialogRef.current?.close();

  const handleClose = () => {
    const trigger = returnFocusRef?.current ?? triggerRef.current;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={labelledBy}
      aria-modal="true"
      onClose={handleClose}
      onCancel={e => {
        if (!dismissibleRef.current) e.preventDefault();
      }}
      onClick={e => {
        e.stopPropagation();
        // A click on the <dialog> element itself, not its content, is a click on the backdrop.
        if (e.target === e.currentTarget && dismissibleRef.current) close();
      }}
      onKeyDown={e => e.stopPropagation()}
      className={`${VARIANT_CLASSES[variant]} ${className}`}
    >
      {typeof children === 'function' ? children(close) : children}
    </dialog>
  );
}

// Initialise i18next for every test file.
//
// Components now render copy through t(); without this the global i18next
// instance is uninitialised and useTranslation returns raw keys ("nav.signOut"),
// so every assertion that looks for English text fails. Importing the real
// bootstrap also means the tests exercise the same resources the app ships.
import '../src/i18n';

// jsdom has <dialog> but none of its methods. A stand-in for the parts components rely on (see
// src/components/Dialog.tsx): showModal opens and focuses the first autofocus or focusable
// element as browsers do, close fires `close`. Inertness, Tab containment and Escape are the
// browser's, so tests drive Escape by dispatching `cancel` and then calling close().
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    const target = this.querySelector<HTMLElement>('[autofocus]') ??
      this.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    target?.focus();
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

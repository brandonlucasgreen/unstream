// Initialise i18next for every test file.
//
// Components now render copy through t(); without this the global i18next
// instance is uninitialised and useTranslation returns raw keys ("nav.signOut"),
// so every assertion that looks for English text fails. Importing the real
// bootstrap also means the tests exercise the same resources the app ships.
import '../src/i18n';

// Node 25+ defines its own `localStorage` and `sessionStorage` globals, which read as undefined
// unless Node is started with --localstorage-file. Vitest's jsdom environment doesn't overwrite a
// global that already exists, so on those Node versions every jsdom test that touches storage
// failed locally while passing in CI (Node 22). Point both names at jsdom's own storage, which is
// what the tests mean. A no-op under the `node` environment, where there is no jsdom.
const jsdomWindow = (globalThis as { jsdom?: { window: Window } }).jsdom?.window;
if (jsdomWindow) {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(globalThis, name, { value: jsdomWindow[name], configurable: true, writable: true });
  }
}

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

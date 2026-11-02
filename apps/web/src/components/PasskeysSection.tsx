import { useCallback, useEffect, useState } from 'react';
import {
  listPasskeys,
  registerPasskey,
  deletePasskey,
  passkeysSupported,
  type Passkey,
} from '../services/passkeys';

/**
 * The "Passkeys" section of /settings: add, list and remove the passkeys this
 * account can sign in with. Everything goes from the browser straight to
 * Supabase Auth via services/passkeys.ts.
 *
 * A passkey replaces the password at sign-in; it is not a second step, and
 * the copy says so, so nobody adds one thinking it protects them the way an
 * authenticator app does.
 */
export function PasskeysSection() {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // First click reveals the real button, so one stray tap can't remove a way in.
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);
  const supported = passkeysSupported();

  const reload = useCallback(async (): Promise<Passkey[] | null> => {
    const { passkeys: fresh, error: listError } = await listPasskeys();
    if (listError) {
      setLoadError(listError);
      return null;
    }
    setPasskeys(fresh);
    setLoadError(null);
    return fresh;
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleAdd() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const before = passkeys?.length ?? 0;
    const { error: addError } = await registerPasskey();
    setBusy(false);
    if (addError) {
      setError(addError);
      return;
    }
    // A dismissed prompt also comes back without an error; only say "added"
    // when there's a new one to show for it.
    const fresh = await reload();
    if (fresh && fresh.length > before) {
      setNotice('Passkey added. Next time, choose "Sign in with a passkey".');
    }
  }

  async function handleRemove(passkeyId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: removeError } = await deletePasskey(passkeyId);
    setBusy(false);
    setConfirmingRemoveId(null);
    if (removeError) {
      setError(removeError);
      return;
    }
    reload();
  }

  if (passkeys === null && !loadError) {
    return <p className="text-sm text-text-muted">Loading…</p>;
  }

  if (loadError) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-error">{loadError}</p>
        <button type="button" onClick={() => reload()} className="text-sm text-link hover:underline">
          Try again
        </button>
      </div>
    );
  }

  const list = passkeys ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        Sign in with Touch ID, Face ID, your phone or a password manager instead of a
        password or an emailed link. A passkey replaces your password; it isn't a second
        step, so if you use an authenticator app you'll still be asked for its code.
      </p>

      {notice && <p className="text-sm text-success">{notice}</p>}
      {error && <p className="text-sm text-error">{error}</p>}

      {list.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {list.map(passkey => (
            <li key={passkey.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div>
                <p className="text-sm font-medium">{passkey.friendlyName || 'Passkey'}</p>
                <p className="text-xs text-text-muted">
                  Added {new Date(passkey.createdAt).toLocaleDateString()}
                  {passkey.lastUsedAt && ` · last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`}
                </p>
              </div>
              {confirmingRemoveId === passkey.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted">Remove it?</span>
                  <button
                    type="button"
                    onClick={() => handleRemove(passkey.id)}
                    disabled={busy}
                    className="text-sm text-error hover:underline disabled:opacity-50"
                  >
                    Yes, remove
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingRemoveId(null)}
                    disabled={busy}
                    className="text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingRemoveId(passkey.id)}
                  disabled={busy}
                  className="text-sm text-text-secondary hover:text-error transition-colors disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {supported ? (
        <button
          type="button"
          onClick={handleAdd}
          disabled={busy}
          className="px-4 py-2 rounded-lg bg-accent-primary text-accent-foreground text-sm font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
        >
          {busy ? 'Waiting for your passkey…' : 'Add a passkey'}
        </button>
      ) : (
        <p className="text-sm text-text-muted">
          This browser can't create passkeys. Open unstream.stream in Safari, Chrome,
          Firefox or Edge to add one.
        </p>
      )}
    </div>
  );
}

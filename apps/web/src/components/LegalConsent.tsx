import { Link } from 'react-router-dom';

/**
 * The consent line shown wherever someone can create an Unstream account.
 *
 * A magic link creates an account when there isn't one already, so every sign-in form here is
 * also a sign-up form — which is why this sits on all of them rather than on a dedicated
 * "register" screen we don't have. Keep the wording identical across surfaces: consent is only
 * worth pointing at later if it said the same thing everywhere.
 *
 * The non-web clients carry their own copy of this line (the extension popup and the Apple
 * apps' sign-in sheet). Change one, change those too.
 */
export function LegalConsent({ children }: { children?: React.ReactNode }) {
  return (
    <p className="text-xs text-text-muted text-center">
      By continuing you agree to Unstream's{' '}
      <Link to="/terms" className="text-accent-primary hover:underline">Terms of Use</Link>
      {' '}and{' '}
      <Link to="/privacy-policy" className="text-accent-primary hover:underline">Privacy Policy</Link>.
      {children ? <> {children}</> : null}
    </p>
  );
}

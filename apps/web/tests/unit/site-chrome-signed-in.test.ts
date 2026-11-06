// @vitest-environment jsdom
// The release page is rendered on the server and cached per URL, so it carries both headers and
// a script that picks one from the browser's Supabase session (api/shared/site-chrome.ts).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SIGNED_IN_SCRIPT, siteHeaderHtml } from '../../../../api/shared/site-chrome';

const KEY = 'sb-abcdefghijklmnop-auth-token';

function runScript() {
  const body = SIGNED_IN_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');
  new Function(body)();
}

const signedIn = () => document.documentElement.classList.contains('sc-signed-in');
const email = () => document.querySelector('.sc-menu-email')?.textContent;

beforeEach(() => {
  // Everything but the script itself: jsdom doesn't run scripts set through innerHTML.
  document.body.innerHTML = siteHeaderHtml().replace(SIGNED_IN_SCRIPT, '');
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('sc-signed-in');
});

describe('signed-in header', () => {
  it('stays signed out with no session', () => {
    runScript();
    expect(signedIn()).toBe(false);
  });

  it('switches to the signed-in header for a session with a refresh token, even an expired one', () => {
    localStorage.setItem(KEY, JSON.stringify({
      access_token: 'a', refresh_token: 'r', expires_at: 1, user: { email: 'fan@example.com' },
    }));
    runScript();
    expect(signedIn()).toBe(true);
    expect(email()).toBe('fan@example.com');
  });

  it('ignores the PKCE code verifier a half-finished sign-in leaves behind', () => {
    localStorage.setItem(`${KEY}-code-verifier`, JSON.stringify({ refresh_token: 'r' }));
    runScript();
    expect(signedIn()).toBe(false);
  });

  it('ignores a stored value with no refresh token, or one that is not JSON', () => {
    localStorage.setItem(KEY, JSON.stringify({ access_token: 'a' }));
    runScript();
    expect(signedIn()).toBe(false);
    localStorage.setItem(KEY, '{not json');
    runScript();
    expect(signedIn()).toBe(false);
  });

  it('writes the email as text, never markup', () => {
    localStorage.setItem(KEY, JSON.stringify({ refresh_token: 'r', user: { email: '<img src=x onerror=alert(1)>' } }));
    runScript();
    expect(document.querySelector('.sc-menu-email img')).toBeNull();
    expect(email()).toBe('<img src=x onerror=alert(1)>');
  });

  it('puts the script after the header it changes', () => {
    const html = siteHeaderHtml();
    expect(html.indexOf(SIGNED_IN_SCRIPT)).toBeGreaterThan(html.indexOf('</header>'));
  });
});

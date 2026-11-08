// The site header and footer as plain HTML, for edge-rendered pages a person actually sees.
//
// The release page (api/edge/release-page.ts) is pure SSR for everyone, with nothing hydrating,
// so it can't render the React Header and Footer. It used to hand-roll its own, which drifted: a
// lone Login button where the app has six nav items, and a footer with a "Codebase" link, a stale
// Contact address and a "Powered by Unstream" block that appear nowhere else. This is the one
// copy, and site-chrome-copies.test.ts fails when its links stop matching Header.tsx's signed-out
// nav or Footer.tsx.
//
// Both headers, signed out and signed in, are in the HTML. Whether someone is signed in lives only
// in the browser (Supabase's session in localStorage), and the page is rendered on the server and
// cached per URL, so the server can't choose. SIGNED_IN_SCRIPT, placed right after the header,
// reads localStorage and adds `sc-signed-in` to <html>; CSS shows one header or the other. It
// renders nothing and fetches nothing, so the page still has one renderer, and without
// JavaScript a visitor gets the signed-out header, which still works (Login takes a signed-in
// person to their account).
//
// The signed-in header is the Account menu only. The Admin menu is left out (its counts need an
// admin API call) and so is Sign out: signing out properly revokes the session at Supabase,
// which needs supabase-js, and clearing localStorage alone would leave it live. Every other page
// has both.
//
// The things the React header opens with a click — the search row below `xl`, the menu below
// `md` and the Account dropdown — are <details> elements, which open and close without
// JavaScript. They share a `name`, so opening one closes the others, as the React header's do.

export interface ChromeLink {
  href: string;
  label: string;
}

const UNSTREAM_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 110 110" aria-hidden="true"><defs><filter id="gs"><feColorMatrix type="saturate" values="0"/></filter></defs><g transform="translate(22,22) scale(1.8333)" filter="url(#gs)"><path fill="#50A5E6" d="M30 22c-3 0-6.688 7.094-7 10-.421 3.915 2 4 2 4h11V26s-3.438-4-6-4z"/><ellipse transform="rotate(-60 27.574 28.49)" fill="#1C6399" cx="27.574" cy="28.489" rx="5.848" ry="1.638"/><path fill="#F9CA55" d="M20.086 0c1.181 0 2.138.957 2.138 2.138 0 .789.668 10.824.668 10.824L17.948 18V2.138C17.948.957 18.905 0 20.086 0z"/><path fill="#FFDC5D" d="M18.875 4.323c0-1.099.852-1.989 1.903-1.989 1.051 0 1.903.891 1.903 1.989 0 0 .535 5.942 1.192 9.37.878 1.866 1.369 4.682 1.261 6.248.054.398 5.625 5.006 5.625 5.006-.281 1.813-2.259 6.155-4.759 8.159l-3.521-2.924c-2.885-.404-4.458-3.331-4.458-4.264 0-2.984.854-21.595.854-21.595z"/><path fill="#50A5E6" d="M6 22c3 0 6.688 7.094 7 10 .421 3.915-2 4-2 4H0V26s3.438-4 6-4z"/><ellipse transform="rotate(-30 8.424 28.489)" fill="#1C6399" cx="8.426" cy="28.489" rx="1.638" ry="5.848"/><path fill="#F9CA55" d="M16.061.011c-1.266-.127-2.333.864-2.333 2.103 0 .78-.184 10.319-.184 10.319L17.895 18l.062-15.765c0-1.106-.795-2.114-1.896-2.224z"/><path fill="#FFDC5D" d="M17.125 4.323c0-1.099-.852-1.989-1.903-1.989-1.051 0-1.903.891-1.903 1.989 0 0-.535 5.942-1.192 9.37-.878 1.866-1.369 4.682-1.261 6.248-.054.398-5.625 5.006-5.625 5.006C5.522 26.76 7.5 31.102 10 33.106l3.521-2.924c2.885-.404 4.458-3.331 4.458-4.264 0-2.984-.854-21.595-.854-21.595z"/><path fill="#F9CA55" d="M17.958 25.823c-.414 0-.75-.336-.75-.75V2.792c0-.414.336-.75.75-.75s.75.336.75.75v22.282c.001.413-.335.749-.75.749z"/></g><path d="M14,52 A41,41 0 0,1 96,52" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><line x1="14" y1="52" x2="14" y2="64" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><line x1="96" y1="52" x2="96" y2="64" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><rect x="3" y="60" width="22" height="28" rx="9" fill="currentColor"/><rect x="85" y="60" width="22" height="28" rx="9" fill="currentColor"/></svg>';

const SEARCH_ICON_PATH = 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z';

/** Header.tsx's signed-out nav, in order, without Login (which is drawn as a button). */
export const HEADER_NAV_LINKS: ChromeLink[] = [
  { href: '/for-artists', label: 'For artists' },
  { href: '/platforms', label: 'Platforms' },
  { href: '/faq', label: 'FAQ' },
  { href: '/press', label: 'Press kit' },
  { href: '/contact', label: 'Contact' },
];

export const HEADER_LOGIN_LINK: ChromeLink = { href: '/login', label: 'Login' };

/**
 * Header.tsx's Account group, without Curator Posts (admin-only while its flag is off). The artist
 * menu isn't drawn here: this header is static, and that menu comes from the API.
 */
export const HEADER_ACCOUNT_LABEL = 'Account';
export const HEADER_ACCOUNT_LINKS: ChromeLink[] = [
  { href: '/my-collection', label: 'My Collection' },
  { href: '/my-saved-artists', label: 'My Saved Artists' },
  { href: '/settings', label: 'Settings' },
];

/**
 * Marks <html> signed in when the browser holds a Supabase session, and fills in the email the
 * menu shows, as the React drawer does. The key is supabase-js's default,
 * `sb-<project ref>-auth-token` (apps/web/src/services/auth.ts sets no storageKey); the anchor
 * keeps out `…-auth-token-code-verifier`, which a half-finished sign-in leaves behind. A
 * session with a refresh token is one the SPA would resume, even once its access token has
 * expired. The email goes in as textContent, never markup. Any failure (storage blocked, bad
 * JSON) leaves the signed-out header.
 */
export const SIGNED_IN_SCRIPT = `<script>(function(){try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(!k||!/^sb-[a-z0-9]+-auth-token$/.test(k))continue;var s=JSON.parse(localStorage.getItem(k)||'null');if(!s||!s.refresh_token)continue;document.documentElement.classList.add('sc-signed-in');var e=s.user&&s.user.email,el=document.querySelector('.sc-menu-email');if(el&&typeof e==='string')el.textContent=e;return}}catch(_){}})();</script>`;

export const FOOTER_MADE_WITH_LOVE: ChromeLink = {
  href: 'https://bgreen.lol',
  label: 'Made with love in Massachusetts, USA',
};

/** Footer.tsx's links, in order. */
export const FOOTER_LINKS: ChromeLink[] = [
  { href: '/for-artists', label: 'For Artists' },
  { href: '/artists', label: 'Indie Artist Index' },
  { href: '/platforms', label: 'Platforms' },
  { href: '/changelog', label: 'Changelog' },
  { href: '/press', label: 'Press kit' },
  { href: '/support', label: 'Support Unstream' },
  { href: '/faq', label: 'FAQ' },
  { href: '/contact', label: 'Contact' },
  { href: '/terms', label: 'Terms of use' },
  { href: '/privacy-policy', label: 'Privacy policy' },
];

// The app's theme tokens (apps/web/src/index.css) under their own prefix, so this doesn't depend
// on — or fight with — whatever variables the page around it defines. Sizes follow the app's
// enlarged type scale: Tailwind's text-sm is 16px there, text-xs 14px, text-base 18px.
export const SITE_CHROME_CSS = `
  :root { --sc-bg: #121212; --sc-bg2: #161616; --sc-hover: #222222; --sc-text: #f0f0f0; --sc-secondary: #999999; --sc-muted: #8a8a8a; --sc-border: #2a2a2a; --sc-accent: #ff6b35; --sc-on-accent: #160b05; }
  @media (prefers-color-scheme: light) {
    :root { --sc-bg: #fafafa; --sc-bg2: #f5f5f5; --sc-hover: #f0f0f0; --sc-text: #1a1a1a; --sc-secondary: #555555; --sc-muted: #6d6d6d; --sc-border: #e0e0e0; --sc-accent: #e55a2b; }
  }
  .sc-header { position: sticky; top: 0; z-index: 40; background: var(--sc-bg); border-bottom: 1px solid var(--sc-border); }
  .sc-header-row { position: relative; padding: 16px; display: flex; align-items: center; gap: 16px; }
  .sc-brand { display: flex; align-items: center; gap: 8px; flex-shrink: 0; font-size: 20px; line-height: 28px; font-weight: 700; color: var(--sc-text); text-decoration: none; }
  .sc-brand:hover { opacity: 0.8; }
  .sc-brand svg { flex-shrink: 0; }
  .sc-search { position: relative; width: 100%; }
  .sc-search svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; color: var(--sc-muted); pointer-events: none; }
  .sc-search input { width: 100%; min-width: 0; background: var(--sc-bg2); border: 1px solid var(--sc-border); border-radius: 8px; padding: 8px 12px 8px 36px; font-size: 18px; line-height: 26px; color: var(--sc-text); font-family: inherit; }
  .sc-search input::placeholder { color: var(--sc-muted); }
  .sc-search input:focus { outline: none; border-color: var(--sc-accent); }
  /* Centred on the header itself, not in the space the sides leave: see Header.tsx. */
  .sc-search-inline { display: none; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 100%; max-width: 384px; padding: 0 16px; }
  .sc-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; }
  .sc-toggle > summary { list-style: none; cursor: pointer; padding: 8px; border-radius: 8px; color: var(--sc-muted); display: flex; }
  .sc-toggle > summary::-webkit-details-marker { display: none; }
  .sc-toggle > summary:hover, .sc-toggle[open] > summary { color: var(--sc-text); background: var(--sc-bg2); }
  .sc-toggle > summary svg { width: 24px; height: 24px; }
  .sc-search-row { position: absolute; left: 0; right: 0; top: 100%; padding: 0 16px 16px; background: var(--sc-bg); border-bottom: 1px solid var(--sc-border); }
  .sc-nav { display: none; align-items: center; gap: 12px; font-size: 16px; line-height: 24px; }
  .sc-nav a { color: var(--sc-muted); text-decoration: none; }
  .sc-nav a:hover { color: var(--sc-text); }
  .sc-nav a.sc-login { padding: 8px 16px; border-radius: 8px; background: var(--sc-accent); color: var(--sc-on-accent); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,0.2); }
  .sc-nav a.sc-login:hover { color: var(--sc-on-accent); opacity: 0.9; }
  html:not(.sc-signed-in) .sc-when-in, html.sc-signed-in .sc-when-out { display: none !important; }
  .sc-dropdown { position: relative; }
  .sc-dropdown > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 4px; color: var(--sc-muted); }
  .sc-dropdown > summary::-webkit-details-marker { display: none; }
  .sc-dropdown > summary:hover, .sc-dropdown[open] > summary { color: var(--sc-text); }
  .sc-dropdown > summary svg { width: 14px; height: 14px; transition: transform 0.15s; }
  .sc-dropdown[open] > summary svg { transform: rotate(180deg); }
  .sc-dropdown-panel { position: absolute; right: 0; top: 100%; margin-top: 8px; min-width: 176px; padding: 4px 0; border: 1px solid var(--sc-border); border-radius: 12px; background: var(--sc-bg); box-shadow: 0 10px 15px rgba(0,0,0,0.2); }
  .sc-nav .sc-dropdown-panel a { display: block; padding: 8px 16px; color: var(--sc-text); }
  .sc-nav .sc-dropdown-panel a:hover { background: var(--sc-hover); }
  .sc-menu { margin-right: -8px; }
  .sc-menu-panel { position: absolute; left: 0; right: 0; top: 100%; display: flex; flex-direction: column; background: var(--sc-bg); border-top: 1px solid var(--sc-border); border-bottom: 1px solid var(--sc-border); box-shadow: 0 10px 15px rgba(0,0,0,0.2); }
  .sc-menu-panel nav { display: flex; flex-direction: column; }
  .sc-menu-email { padding: 16px 24px; font-size: 14px; line-height: 20px; color: var(--sc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sc-menu-email:empty { display: none; }
  .sc-menu-heading { padding: 16px 24px 4px; font-size: 14px; line-height: 20px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; color: var(--sc-muted); }
  .sc-menu-panel .sc-when-in a { padding: 12px 24px; border-bottom: 0; }
  .sc-menu-panel a { padding: 16px 24px; font-size: 18px; line-height: 26px; color: var(--sc-text); text-decoration: none; border-bottom: 1px solid var(--sc-border); }
  .sc-menu-panel a:last-child { border-bottom: 0; }
  .sc-menu-panel a:hover { background: var(--sc-hover); }
  @media (min-width: 768px) {
    .sc-nav { display: flex; }
    .sc-menu { display: none; }
  }
  @media (min-width: 1024px) {
    .sc-search input { font-size: 16px; line-height: 24px; }
  }
  @media (min-width: 1280px) {
    .sc-search-inline { display: block; }
    .sc-search-toggle { display: none; }
  }
  @media (min-width: 1536px) {
    .sc-search-inline { max-width: 448px; }
  }

  .sc-footer { margin-top: auto; border-top: 1px solid var(--sc-border); padding: 24px 16px; }
  .sc-footer-inner { max-width: 896px; margin: 0 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; font-size: 16px; line-height: 24px; color: var(--sc-secondary); }
  .sc-footer a { color: var(--sc-secondary); text-decoration: none; }
  .sc-footer a:hover { color: var(--sc-text); }
  .sc-footer nav { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; column-gap: 12px; row-gap: 4px; }
  .sc-footer-dot { color: var(--sc-muted); opacity: 0.4; font-size: 14px; }
`;

// Plain GET forms, no JS: submitting lands on /?q=…, where the SPA renders results. Never point
// these at /search — that URL belongs to the noscript-search edge function.
function searchForm(): string {
  return `<form class="sc-search" action="/" method="get" role="search">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${SEARCH_ICON_PATH}"/></svg>
        <input type="text" name="q" placeholder="Search artists..." aria-label="Search artists" enterkeyhint="search">
      </form>`;
}

export function siteHeaderHtml(): string {
  const navLinks = HEADER_NAV_LINKS.map(l => `<a href="${l.href}">${l.label}</a>`).join('\n        ');
  const accountLinks = HEADER_ACCOUNT_LINKS.map(l => `<a href="${l.href}">${l.label}</a>`).join('\n              ');
  return `<header class="sc-header">
    <div class="sc-header-row">
      <a href="/" class="sc-brand">${UNSTREAM_LOGO_SVG} Unstream</a>
      <div class="sc-search-inline">${searchForm()}</div>
      <div class="sc-actions">
        <details class="sc-toggle sc-search-toggle" name="sc-header">
          <summary aria-label="Search artists"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${SEARCH_ICON_PATH}"/></svg></summary>
          <div class="sc-search-row">${searchForm()}</div>
        </details>
        <nav class="sc-nav sc-when-out" aria-label="Main menu">
        ${navLinks}
        <a href="${HEADER_LOGIN_LINK.href}" class="sc-login">${HEADER_LOGIN_LINK.label}</a>
        </nav>
        <nav class="sc-nav sc-when-in" aria-label="Main menu">
          <details class="sc-dropdown" name="sc-header">
            <summary>${HEADER_ACCOUNT_LABEL}<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg></summary>
            <div class="sc-dropdown-panel">
              ${accountLinks}
            </div>
          </details>
        </nav>
        <details class="sc-toggle sc-menu" name="sc-header">
          <summary aria-label="Open menu"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7h16M4 12h16M4 17h16"/></svg></summary>
          <div class="sc-menu-panel">
            <nav class="sc-when-out" aria-label="Main menu">
            ${[...HEADER_NAV_LINKS, HEADER_LOGIN_LINK].map(l => `<a href="${l.href}">${l.label}</a>`).join('\n            ')}
            </nav>
            <nav class="sc-when-in" aria-label="Main menu">
              <p class="sc-menu-email"></p>
              <p class="sc-menu-heading">${HEADER_ACCOUNT_LABEL}</p>
              ${accountLinks}
            </nav>
          </div>
        </details>
      </div>
    </div>
  </header>
  ${SIGNED_IN_SCRIPT}`;
}

export function siteFooterHtml(): string {
  const links = FOOTER_LINKS
    .map(l => `<a href="${l.href}">${l.label}</a>`)
    .join('\n        <span class="sc-footer-dot">&#x2022;</span>\n        ');
  return `<footer class="sc-footer">
    <div class="sc-footer-inner">
      <a href="${FOOTER_MADE_WITH_LOVE.href}" target="_blank" rel="noopener noreferrer">${FOOTER_MADE_WITH_LOVE.label}</a>
      <nav>
        ${links}
      </nav>
    </div>
  </footer>`;
}

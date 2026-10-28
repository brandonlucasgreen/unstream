import { matchPath } from 'react-router-dom';

// The title each route starts with, so every page has one — many never set document.title, which
// left a screen reader announcing the previous page's title (or the generic one) after a
// navigation. RouteOrientation applies it when the path changes; a page that knows better (an
// artist's name once loaded, a search query) still sets its own afterwards and wins, because page
// effects run after RouteOrientation's.
//
// Order matters: the first matching pattern wins, so specific paths come before their parents.
const ROUTE_TITLES: [pattern: string, title: string][] = [
  ['/artist/:slug', 'Artist | Unstream'],
  ['/a/:slug', 'Artist | Unstream'],
  ['/claim/:slug', 'Claim your artist page | Unstream'],
  ['/login', 'Log in or sign up | Unstream'],
  ['/reset-password', 'Reset your password | Unstream'],
  ['/my-artists', 'My Artists | Unstream'],
  ['/my-collection', 'My Collection | Unstream'],
  ['/curator/new', 'Curator Posts | Unstream'],
  ['/artist-edit/:slug/tips', 'Manage tips | Unstream'],
  ['/artist-edit/:slug/releases', 'Manage releases | Unstream'],
  ['/artist-edit/:slug', 'Edit profile | Unstream'],
  ['/artists', 'Indie Artist Index | Unstream'],
  ['/known-artists', 'Artists You Know | Unstream'],
  ['/roadmap', 'Roadmap | Unstream'],
  ['/support', 'Support Unstream'],
  ['/privacy-policy', 'Privacy policy | Unstream'],
  ['/terms', 'Terms of use | Unstream'],
  ['/platforms', 'Platforms | Unstream'],
  ['/admin/merge', 'Merge results | Unstream Admin'],
  ['/admin/verify', 'Verification | Unstream Admin'],
  ['/admin/links', 'Removed links | Unstream Admin'],
  ['/admin/release-review', 'Release review | Unstream Admin'],
  ['/admin/analytics', 'Analytics | Unstream Admin'],
  ['/admin/flags', 'Feature flags | Unstream Admin'],
  ['/developers', 'Developers | Unstream'],
  ['/press', 'Press kit | Unstream'],
  ['/contact', 'Contact | Unstream'],
  ['/extension', 'Browser extension | Unstream'],
  ['/import', 'Import your music library | Unstream'],
  ['/changelog', 'Changelog | Unstream'],
  ['/faq', 'FAQ | Unstream'],
  ['/settings', 'Settings | Unstream'],
  ['/tip/thanks', 'Thank you for your tip | Unstream'],
  ['/tip/:slug', 'Tip an artist | Unstream'],
  ['/u/:handle', 'Collection | Unstream'],
];

/** The starting title for a path, or null for `/` (App titles itself) and unknown paths. */
export function titleForPath(pathname: string): string | null {
  for (const [pattern, title] of ROUTE_TITLES) {
    if (matchPath({ path: pattern, end: true }, pathname)) return title;
  }
  return null;
}

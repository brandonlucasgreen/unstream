// Reserved handles that cannot be used as public usernames.
// Shared between the DB CHECK constraint (via migration) and server-side validation.
// Keep in sync with the reserved-handle list used by isReservedHandle() in user-sharing.ts.

export const RESERVED_HANDLES = [
  'admin', 'api', 'settings', 'login', 'signup', 'signin', 'register',
  'logout', 'support', 'about', 'privacy', 'terms', 'dashboard',
  'u', 'a', 'artist', 'www', 'mail', 'ftp', 'root', 'help', 'docs',
  'status', 'blog',
] as const;

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.includes(handle as (typeof RESERVED_HANDLES)[number]);
}
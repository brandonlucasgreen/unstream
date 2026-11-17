// A shape check for an email address, for forms whose submit doesn't go through the browser's own
// type="email" validation. Without it a typo reaches Supabase and comes back as a raw 400
// ("Unable to validate email address: invalid format"). Same shape as the server-side check in
// api/functions/me-email.ts.
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

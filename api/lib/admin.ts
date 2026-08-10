// Who counts as an admin, in one place: a case-insensitive match against the ADMIN_EMAIL env var.
//
// Read by authenticateAdmin (api/functions/middleware.ts) and by the saved-artist notification
// senders, which are currently restricted to admin recipients (api/functions/notifications.ts).
// Its own module rather than a middleware export because notifications.ts importing middleware.ts
// would close a cycle — middleware.ts imports db.ts, and db.ts imports notifications.ts.

export function isAdminEmail(email: string | null | undefined): boolean {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail || !email) return false;
  return email.trim().toLowerCase() === adminEmail.trim().toLowerCase();
}

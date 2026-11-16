import { Navigate } from 'react-router-dom'

// Redirect components for old routes
export function ArtistLoginRedirect() {
  return <Navigate to="/login" replace />
}

// The dashboard split into /my-artists (artist management) and /my-collection (the fan's
// releases and collection; saved artists later moved to /my-saved-artists). Both old routes stay for bookmarks and links in
// emails already sent, and land on the fan half — what most accounts came for. (Sign-in
// itself resolves between the two; see services/accountHome.ts.)
export function DashboardRedirect() {
  return <Navigate to="/my-collection" replace />
}

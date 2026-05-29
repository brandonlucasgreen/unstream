// Deprecated - redirects to new unified login page
import { Navigate } from 'react-router-dom';

export function ArtistLoginPage() {
  return <Navigate to="/login" replace />;
}

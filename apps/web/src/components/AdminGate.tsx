import type { ReactNode } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { AppLoadingFallback } from './AppFallback';

/**
 * The front door of every /admin/* page: the page for the admin, "Not authorized." for anyone
 * else, and neither until auth has finished loading. Each page used to check `isAdmin` alone,
 * which is false while the session is still being read, so the admin saw "Not authorized." flash
 * on every direct load.
 *
 * This only decides what to show. Every /api/admin/* endpoint authorizes on the server.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const { isAdmin, isLoading } = useAuth();

  if (isLoading) return <AppLoadingFallback />;

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-text-muted">Not authorized.</p>
      </div>
    );
  }

  return <>{children}</>;
}

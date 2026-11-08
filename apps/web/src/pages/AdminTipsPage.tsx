import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';
import { AdminTipsApprovals } from '../components/AdminTipsApprovals';

/**
 * Tips review: approving each artist's Stripe account before fans get a Tip button
 * (docs/specs/artist-patronage-spec.md §6, gate 3). Split out of /admin/verify on 2026-11-08,
 * which keeps claim verification and duplicate artists. `tips-review-notify` pushes the admin
 * here when an artist finishes Stripe onboarding.
 *
 * The browser `isAdmin` check is only for showing the page; `/api/admin/tips` authorizes every
 * read and write on the server.
 */
export function AdminTipsPage() {
  const { isAdmin } = useAuth();

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-text-muted">Not authorized.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header />
      <div className="px-4 py-8">
        <div className="max-w-3xl mx-auto space-y-8">
          <h1 className="font-display text-2xl font-bold text-text-primary">Tips Review</h1>
          <AdminTipsApprovals />
        </div>
      </div>
    </div>
  );
}

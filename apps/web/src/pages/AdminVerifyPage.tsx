import { useState, useEffect, useCallback } from 'react';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';
import { SkeletonScreen } from '../components/Skeleton';
import { FormSkeleton } from '../components/LoadingSkeletons';
import { AdminDuplicateArtists } from '../components/AdminDuplicateArtists';

interface VerificationRequest {
  id: string;
  artist_name: string;
  artist_slug: string;
  email: string;
  website_url: string | null;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewer_notes: string | null;
  created_at: string;
  reviewed_at: string | null;
  link_back_completed: boolean;
}

export function AdminVerifyPage() {
  const { isAdmin, session } = useAuth();
  const [requests, setRequests] = useState<VerificationRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [reviewerNotes, setReviewerNotes] = useState<Record<string, string>>({});
  const [ownershipChecked, setOwnershipChecked] = useState<Record<string, boolean>>({});

  const fetchRequests = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/verify', {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to fetch (${response.status})`);
      }

      const data = await response.json();
      setRequests(data.requests || []);
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'admin.verify.fetchRequests' } });
      setError(err instanceof Error ? err.message : 'Failed to load verification requests.');
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    if (isAdmin) {
      fetchRequests();
    }
  }, [isAdmin, fetchRequests]);

  const handleAction = async (requestId: string, action: 'approve' | 'reject') => {
    if (!session?.access_token) return;
    setActionLoading(requestId);
    setError(null);

    try {
      const response = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          action,
          requestId,
          reviewerNotes: reviewerNotes[requestId]?.trim() || undefined,
          ownershipVerified: action === 'approve' ? ownershipChecked[requestId] === true : undefined,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to ${action} (${response.status})`);
      }

      // Refresh the list
      await fetchRequests();
      // Clear notes and checkbox for this request
      setReviewerNotes(prev => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
      setOwnershipChecked(prev => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
    } catch (err) {
      Sentry.captureException(err, { extra: { context: `admin.verify.${action}` } });
      setError(err instanceof Error ? err.message : `Failed to ${action} request.`);
    } finally {
      setActionLoading(null);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-text-muted">Not authorized.</p>
      </div>
    );
  }

  const pendingRequests = requests.filter(r => r.status === 'pending');
  const pastRequests = requests.filter(r => r.status !== 'pending');

  return (
    <div className="min-h-screen">
      <Header />
      <div className="px-4 py-8">
        <div className="max-w-3xl mx-auto space-y-8">
          <h1 className="font-display text-2xl font-bold text-text-primary">
            Artist Verification Review
          </h1>

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          {loading ? (
            <SkeletonScreen label="Loading verification requests">
              <FormSkeleton sections={2} fields={2} />
            </SkeletonScreen>
          ) : (
            <>
              {/* Pending requests */}
              <section className="space-y-4">
                <h2 className="font-display text-lg font-semibold text-text-primary">
                  Pending requests ({pendingRequests.length})
                </h2>

                {pendingRequests.length === 0 ? (
                  <p className="text-text-muted text-sm">No pending verification requests.</p>
                ) : (
                  pendingRequests.map(req => (
                    <div
                      key={req.id}
                      className="p-4 rounded-xl bg-surface border border-border space-y-3"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 className="font-semibold text-text-primary">{req.artist_name}</h3>
                          <p className="text-text-muted text-sm">/{req.artist_slug}</p>
                        </div>
                        <span className="text-text-muted text-xs whitespace-nowrap">
                          {new Date(req.created_at).toLocaleDateString()}
                        </span>
                      </div>

                      <div className="space-y-1 text-sm">
                        <p className="text-text-secondary">
                          <span className="text-text-muted">Email:</span> {req.email}
                        </p>
                        {req.website_url && (
                          <p className="text-text-secondary">
                            <span className="text-text-muted">Website:</span>{' '}
                            <a
                              href={req.website_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-accent-primary hover:underline"
                            >
                              {req.website_url}
                            </a>
                          </p>
                        )}
                        <p className={`text-xs ${req.link_back_completed ? 'text-green-400' : 'text-yellow-400'}`}>
                          {req.link_back_completed
                            ? '✓ link-back completed'
                            : '⚠ link-back not completed — manual verification required'}
                        </p>
                        {req.message && (
                          <div className="mt-2 p-3 rounded-lg bg-bg-secondary text-text-secondary text-sm">
                            <span className="text-text-muted block mb-1">Proof/message:</span>
                            {req.message}
                          </div>
                        )}
                      </div>

                      <textarea
                        value={reviewerNotes[req.id] || ''}
                        onChange={(e) => setReviewerNotes(prev => ({ ...prev, [req.id]: e.target.value }))}
                        placeholder="Reviewer notes (optional)..."
                        rows={2}
                        className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border/50 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/50 resize-none"
                      />

                      <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={ownershipChecked[req.id] || false}
                          onChange={(e) => setOwnershipChecked(prev => ({ ...prev, [req.id]: e.target.checked }))}
                          className="h-4 w-4 rounded border-border"
                        />
                        I have verified the submitter is the artist owner
                      </label>

                      <div className="flex gap-3">
                        <button
                          onClick={() => handleAction(req.id, 'approve')}
                          disabled={actionLoading === req.id || !ownershipChecked[req.id]}
                          className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {actionLoading === req.id ? 'Processing...' : 'Approve'}
                        </button>
                        <button
                          onClick={() => handleAction(req.id, 'reject')}
                          disabled={actionLoading === req.id}
                          className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {actionLoading === req.id ? 'Processing...' : 'Reject'}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </section>

              {/* Past decisions */}
              {pastRequests.length > 0 && (
                <section className="space-y-4">
                  <h2 className="font-display text-lg font-semibold text-text-primary">
                    Past decisions ({pastRequests.length})
                  </h2>

                  {pastRequests.map(req => (
                    <div
                      key={req.id}
                      className="p-4 rounded-xl bg-surface/50 border border-border/50 space-y-2"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 className="font-semibold text-text-primary">{req.artist_name}</h3>
                          <p className="text-text-muted text-sm">/{req.artist_slug}</p>
                        </div>
                        <span
                          className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                            req.status === 'approved'
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-red-500/10 text-red-400'
                          }`}
                        >
                          {req.status}
                        </span>
                      </div>

                      <div className="text-sm text-text-muted space-y-1">
                        <p>Email: {req.email}</p>
                        {req.reviewed_at && (
                          <p>Reviewed: {new Date(req.reviewed_at).toLocaleDateString()}</p>
                        )}
                        {req.reviewer_notes && (
                          <p>Notes: {req.reviewer_notes}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </section>
              )}

              {/* Duplicate artist rows — the other half of reviewing an artist's identity. */}
              <AdminDuplicateArtists session={session} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';

import { Header } from '../components/Header';
import { ArtistAnalytics } from '../components/ArtistAnalytics';
import { PasswordSection } from '../components/PasswordSection';
import { Footer } from '../components/Footer';

interface ClaimedProfile {
  id: string;
  artistId: string;
  name: string;
  slug: string;
  imageUrl?: string;
  websiteUrl?: string;
  bio?: string;
  claimedAt: string;
}

export function ArtistDashboardPage() {
  const navigate = useNavigate();
  const { session, isLoading: authLoading } = useAuth();
  const [profiles, setProfiles] = useState<ClaimedProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  const handleShareProfile = async (slug: string) => {
    const url = `https://unstream.stream/a/${slug}`;
    const text = `Find my music on alternative platforms with Unstream`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'My Unstream page', text, url });
      } catch { /* cancelled */ }
    } else {
      await navigator.clipboard.writeText(url);
      setCopiedSlug(slug);
      setTimeout(() => setCopiedSlug(null), 2000);
    }
  };

  useEffect(() => {
    if (authLoading) return; // Wait for auth context to resolve

    if (!session) {
      navigate('/artist-login', { replace: true });
      return;
    }

    async function loadProfiles() {
      try {
        const response = await fetch('/api/artist-auth', {
          headers: { 'Authorization': `Bearer ${session!.access_token}` },
        });

        if (!response.ok) {
          if (response.status === 401) {
            navigate('/artist-login', { replace: true });
            return;
          }
          throw new Error('Failed to load profiles');
        }

        const data = await response.json();
        setProfiles(data.profiles || []);
      } catch (e) {
        Sentry.captureException(e, { extra: { context: 'artistDashboard.loadProfiles' } });
        setError('Failed to load your profiles. Please try again.');
      }
      setLoading(false);
    }
    loadProfiles();
  }, [session, authLoading, navigate]);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="text-text-muted">Loading your profiles...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">

      <Header />

      <main className="flex-1 p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          <div>
            <h1 className="text-2xl font-bold">Your Artist Profiles</h1>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {profiles.length === 0 ? (
            <div className="text-center py-12 space-y-3">
              <p className="text-text-muted">No claimed profiles yet.</p>
              <Link
                to="/"
                className="inline-block px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors"
              >
                Search for your artist page
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {profiles.map(profile => (
                <div
                  key={profile.id}
                  className="p-4 rounded-lg bg-bg-secondary border border-border"
                >
                  <div className="flex gap-4">
                    <div className="flex-shrink-0">
                      {profile.imageUrl ? (
                        <img
                          src={profile.imageUrl}
                          alt={profile.name}
                          className="w-12 h-12 rounded-full object-cover"
                        />
                      ) : (
                        <div className="w-12 h-12 rounded-full bg-bg-hover flex items-center justify-center text-text-muted text-lg">
                          {profile.name.charAt(0).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold truncate">{profile.name}</p>
                      <p className="text-sm text-text-muted truncate">
                        unstream.stream/a/{profile.slug}
                      </p>
                      <div className="flex items-center gap-2 mt-3">
                        <Link
                          to={`/artist-edit/${profile.slug}`}
                          className="px-3 py-1.5 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors"
                        >
                          Edit
                        </Link>
                        <Link
                          to={`/a/${profile.slug}`}
                          className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-text-primary hover:border-border-hover transition-colors"
                        >
                          View
                        </Link>
                        <button
                          onClick={() => handleShareProfile(profile.slug)}
                          className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-text-primary hover:border-border-hover transition-colors flex items-center gap-1.5"
                          title="Share your artist page"
                        >
                          {copiedSlug === profile.slug ? (
                            <>
                              <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                              Copied!
                            </>
                          ) : (
                            <>
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                              </svg>
                              Share
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                  <ArtistAnalytics slug={profile.slug} />
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Account</h2>
            <PasswordSection />
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}

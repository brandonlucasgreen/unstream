import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import * as Sentry from '@sentry/react'
import { initSentry } from './services/sentry'
import { AuthProvider } from './contexts/AuthContext'
import './index.css'
import App from './App.tsx'
import { ArtistPage } from './pages/ArtistPage.tsx'
import { AppLoadingFallback, AppErrorFallback } from './components/AppFallback'
import { ScrollToTop } from './components/ScrollToTop'
import { lazyWithRetry } from './utils/lazyWithRetry'

initSentry()

// Lazy-load non-critical pages to reduce initial bundle size.
// lazyWithRetry adds a one-shot reload when a chunk belongs to a superseded deploy.
const ClaimPage = lazyWithRetry(() => import('./pages/ClaimPage.tsx').then(m => ({ default: m.ClaimPage })))
const LoginPage = lazyWithRetry(() => import('./pages/LoginPage.tsx').then(m => ({ default: m.LoginPage })))
const DashboardPage = lazyWithRetry(() => import('./pages/DashboardPage.tsx').then(m => ({ default: m.DashboardPage })))
const ArtistEditPage = lazyWithRetry(() => import('./pages/ArtistEditPage.tsx').then(m => ({ default: m.ArtistEditPage })))
const ArtistReleasesPage = lazyWithRetry(() => import('./pages/ArtistReleasesPage.tsx').then(m => ({ default: m.ArtistReleasesPage })))
const ArtistDirectoryPage = lazyWithRetry(() => import('./pages/ArtistDirectoryPage.tsx').then(m => ({ default: m.ArtistDirectoryPage })))
const KnownArtistsPage = lazyWithRetry(() => import('./pages/KnownArtistsPage.tsx').then(m => ({ default: m.KnownArtistsPage })))
const RoadmapPage = lazyWithRetry(() => import('./pages/RoadmapPage.tsx').then(m => ({ default: m.RoadmapPage })))
const SupportPage = lazyWithRetry(() => import('./pages/SupportPage.tsx').then(m => ({ default: m.SupportPage })))
const PrivacyPolicyPage = lazyWithRetry(() => import('./pages/PrivacyPolicyPage.tsx').then(m => ({ default: m.PrivacyPolicyPage })))
const AdminMergePage = lazyWithRetry(() => import('./pages/AdminMergePage.tsx').then(m => ({ default: m.AdminMergePage })))
const AdminVerifyPage = lazyWithRetry(() => import('./pages/AdminVerifyPage.tsx').then(m => ({ default: m.AdminVerifyPage })))
const AdminLinksPage = lazyWithRetry(() => import('./pages/AdminLinksPage.tsx').then(m => ({ default: m.AdminLinksPage })))
const AdminReleaseReviewPage = lazyWithRetry(() => import('./pages/AdminReleaseReviewPage.tsx').then(m => ({ default: m.AdminReleaseReviewPage })))
const ResetPasswordPage = lazyWithRetry(() => import('./pages/ResetPasswordPage.tsx').then(m => ({ default: m.ResetPasswordPage })))
const GuidesIndexPage = lazyWithRetry(() => import('./pages/GuidesIndexPage.tsx').then(m => ({ default: m.GuidesIndexPage })))
const GuidePage = lazyWithRetry(() => import('./pages/GuidePage.tsx').then(m => ({ default: m.GuidePage })))
const DevelopersPage = lazyWithRetry(() => import('./pages/DevelopersPage.tsx').then(m => ({ default: m.DevelopersPage })))
const ChangelogPage = lazyWithRetry(() => import('./pages/ChangelogPage.tsx').then(m => ({ default: m.ChangelogPage })))
const ExtensionPage = lazyWithRetry(() => import('./pages/ExtensionPage.tsx').then(m => ({ default: m.ExtensionPage })))
const ImportPage = lazyWithRetry(() => import('./pages/ImportPage.tsx').then(m => ({ default: m.ImportPage })))
const FaqPage = lazyWithRetry(() => import('./pages/FaqPage.tsx').then(m => ({ default: m.FaqPage })))
const SettingsPage = lazyWithRetry(() => import('./pages/SettingsPage.tsx').then(m => ({ default: m.SettingsPage })))
const PublicSavedArtistsPage = lazyWithRetry(() => import('./pages/PublicSavedArtistsPage.tsx').then(m => ({ default: m.PublicSavedArtistsPage })))
const AdminAnalyticsPage = lazyWithRetry(() => import('./pages/AdminAnalyticsPage.tsx').then(m => ({ default: m.AdminAnalyticsPage })))

// Redirect components for old routes
function ArtistLoginRedirect() {
  return <Navigate to="/login" replace />
}

function ArtistDashboardRedirect() {
  return <Navigate to="/dashboard" replace />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={<AppErrorFallback />}
      // Without this, a boundary crash arrives in Sentry as a bare error with no
      // clue where the user was. Every route below is lazy-loaded, so the route
      // path is what turns "TypeError: Failed to fetch dynamically imported
      // module" into "sign-in was broken for this person".
      beforeCapture={scope => {
        scope.setTag('context', 'app.errorBoundary')
        scope.setTag('route', window.location.pathname)
      }}
    >
      <AuthProvider>
        <BrowserRouter>
          <ScrollToTop />
          <Suspense fallback={<AppLoadingFallback />}>
            <Routes>
              <Route path="/" element={<App />} />
              <Route path="/artist/:slug" element={<ArtistPage />} />
              <Route path="/a/:slug" element={<ArtistPage />} />
              <Route path="/claim/:slug" element={<ClaimPage />} />
              <Route path="/artist-login" element={<ArtistLoginRedirect />} />
              <Route path="/artist-dashboard" element={<ArtistDashboardRedirect />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/artist-edit/:slug" element={<ArtistEditPage />} />
              <Route path="/artist-edit/:slug/releases" element={<ArtistReleasesPage />} />
              <Route path="/artists" element={<ArtistDirectoryPage />} />
              <Route path="/known-artists" element={<KnownArtistsPage />} />
              <Route path="/roadmap" element={<RoadmapPage />} />
              <Route path="/support" element={<SupportPage />} />
              <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
              <Route path="/guides" element={<GuidesIndexPage />} />
              <Route path="/guides/:slug" element={<GuidePage />} />
              <Route path="/admin/merge" element={<AdminMergePage />} />
              <Route path="/admin/verify" element={<AdminVerifyPage />} />
              <Route path="/admin/links" element={<AdminLinksPage />} />
              <Route path="/admin/release-review" element={<AdminReleaseReviewPage />} />
              <Route path="/admin/analytics" element={<AdminAnalyticsPage />} />
              <Route path="/developers" element={<DevelopersPage />} />
              <Route path="/extension" element={<ExtensionPage />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/changelog" element={<ChangelogPage />} />
              <Route path="/faq" element={<FaqPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/u/:handle" element={<PublicSavedArtistsPage />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
)

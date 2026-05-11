import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Sentry } from './services/sentry.ts'
import { AuthProvider } from './contexts/AuthContext'
import './index.css'
import App from './App.tsx'
import { ArtistPage } from './pages/ArtistPage.tsx'

// Initialize Sentry asynchronously to avoid blocking initial render
import('./services/sentry.ts').then(({ initSentry }) => initSentry())

// Lazy-load non-critical pages to reduce initial bundle size
const ClaimPage = lazy(() => import('./pages/ClaimPage.tsx').then(m => ({ default: m.ClaimPage })))
const ArtistLoginPage = lazy(() => import('./pages/ArtistLoginPage.tsx').then(m => ({ default: m.ArtistLoginPage })))
const ArtistDashboardPage = lazy(() => import('./pages/ArtistDashboardPage.tsx').then(m => ({ default: m.ArtistDashboardPage })))
const ArtistEditPage = lazy(() => import('./pages/ArtistEditPage.tsx').then(m => ({ default: m.ArtistEditPage })))
const ArtistDirectoryPage = lazy(() => import('./pages/ArtistDirectoryPage.tsx').then(m => ({ default: m.ArtistDirectoryPage })))
const RoadmapPage = lazy(() => import('./pages/RoadmapPage.tsx').then(m => ({ default: m.RoadmapPage })))
const SupportPage = lazy(() => import('./pages/SupportPage.tsx').then(m => ({ default: m.SupportPage })))
const PrivacyPolicyPage = lazy(() => import('./pages/PrivacyPolicyPage.tsx').then(m => ({ default: m.PrivacyPolicyPage })))
const AdminMergePage = lazy(() => import('./pages/AdminMergePage.tsx').then(m => ({ default: m.AdminMergePage })))
const AdminVerifyPage = lazy(() => import('./pages/AdminVerifyPage.tsx').then(m => ({ default: m.AdminVerifyPage })))
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage.tsx').then(m => ({ default: m.ResetPasswordPage })))
const GuidesIndexPage = lazy(() => import('./pages/GuidesIndexPage.tsx').then(m => ({ default: m.GuidesIndexPage })))
const GuidePage = lazy(() => import('./pages/GuidePage.tsx').then(m => ({ default: m.GuidePage })))
const DevelopersPage = lazy(() => import('./pages/DevelopersPage.tsx').then(m => ({ default: m.DevelopersPage })))
const ChangelogPage = lazy(() => import('./pages/ChangelogPage.tsx').then(m => ({ default: m.ChangelogPage })))
const ExtensionPage = lazy(() => import('./pages/ExtensionPage.tsx').then(m => ({ default: m.ExtensionPage })))
const ImportPage = lazy(() => import('./pages/ImportPage.tsx').then(m => ({ default: m.ImportPage })))
const AdminAnalyticsPage = lazy(() => import('./pages/AdminAnalyticsPage.tsx').then(m => ({ default: m.AdminAnalyticsPage })))

function LoadingFallback() {
  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center">
      <div className="text-text-muted">Loading...</div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<LoadingFallback />}>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={<LoadingFallback />}>
            <Routes>
              <Route path="/" element={<App />} />
              <Route path="/artist/:slug" element={<ArtistPage />} />
              <Route path="/a/:slug" element={<ArtistPage />} />
              <Route path="/claim/:slug" element={<ClaimPage />} />
              <Route path="/artist-login" element={<ArtistLoginPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/artist-dashboard" element={<ArtistDashboardPage />} />
              <Route path="/artist-edit/:slug" element={<ArtistEditPage />} />
              <Route path="/artists" element={<ArtistDirectoryPage />} />
              <Route path="/roadmap" element={<RoadmapPage />} />
              <Route path="/support" element={<SupportPage />} />
              <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
              <Route path="/guides" element={<GuidesIndexPage />} />
              <Route path="/guides/:slug" element={<GuidePage />} />
              <Route path="/admin/merge" element={<AdminMergePage />} />
              <Route path="/admin/verify" element={<AdminVerifyPage />} />
              <Route path="/admin/analytics" element={<AdminAnalyticsPage />} />
              <Route path="/developers" element={<DevelopersPage />} />
              <Route path="/extension" element={<ExtensionPage />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/changelog" element={<ChangelogPage />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
)

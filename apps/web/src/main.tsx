import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import './index.css'
import App from './App.tsx'
import { ArtistPage } from './pages/ArtistPage.tsx'

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
const GuidesIndexPage = lazy(() => import('./pages/GuidesIndexPage.tsx').then(m => ({ default: m.GuidesIndexPage })))
const GuidePage = lazy(() => import('./pages/GuidePage.tsx').then(m => ({ default: m.GuidePage })))

function LoadingFallback() {
  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center">
      <div className="text-text-muted">Loading...</div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<LoadingFallback />}>
          <Routes>
            <Route path="/" element={<App />} />
            <Route path="/artist/:slug" element={<ArtistPage />} />
            <Route path="/claim/:slug" element={<ClaimPage />} />
            <Route path="/artist-login" element={<ArtistLoginPage />} />
            <Route path="/artist-dashboard" element={<ArtistDashboardPage />} />
            <Route path="/artist-edit/:slug" element={<ArtistEditPage />} />
            <Route path="/artists" element={<ArtistDirectoryPage />} />
            <Route path="/roadmap" element={<RoadmapPage />} />
            <Route path="/support" element={<SupportPage />} />
            <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
            <Route path="/guides" element={<GuidesIndexPage />} />
            <Route path="/guides/:slug" element={<GuidePage />} />
            <Route path="/admin/merge" element={<AdminMergePage />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
)

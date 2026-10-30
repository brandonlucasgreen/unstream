import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import * as Sentry from '@sentry/react'
import { initSentry } from './services/sentry'
import { registerServiceWorker } from './services/registerServiceWorker'
import { clearApiResponseCache } from './services/clearApiResponseCache'
import { AuthProvider } from './contexts/AuthContext'
import './i18n'
import './index.css'
import App from './App.tsx'
import { ArtistPage } from './pages/ArtistPage.tsx'
import { AppLoadingFallback, AppErrorFallback } from './components/AppFallback'
import { ScrollToTop } from './components/ScrollToTop'
// Eager, unlike every page below: the catch-all exists for navigations that have already gone
// wrong, and a superseded build's chunks are deleted — exactly when it is most needed.
import { NotFoundPage } from './pages/NotFoundPage.tsx'
import { lazyWithRetry } from './utils/lazyWithRetry'
import { StaleBuildBanner } from './components/StaleBuildBanner'
import { PendingSaveNotice } from './components/PendingSaveNotice'
import { RouteOrientation } from './components/RouteOrientation'
import { SkipLink } from './components/SkipLink'

initSentry()

// Ours rather than vite-plugin-pwa's injected registerSW.js, which reports a
// declined registration as an unhandled rejection. Guarded on PROD because the
// plugin only emits /sw.js for a build, exactly as the injected script was — which
// is also the only place the `api-cache` bucket being cleared here ever existed.
if (import.meta.env.PROD) {
  registerServiceWorker()
  clearApiResponseCache()
}

// Lazy-load non-critical pages to reduce initial bundle size.
// lazyWithRetry adds a one-shot reload when a chunk belongs to a superseded deploy.
const ClaimPage = lazyWithRetry(() => import('./pages/ClaimPage.tsx').then(m => ({ default: m.ClaimPage })))
const LoginPage = lazyWithRetry(() => import('./pages/LoginPage.tsx').then(m => ({ default: m.LoginPage })))
const MyArtistsPage = lazyWithRetry(() => import('./pages/MyArtistsPage.tsx').then(m => ({ default: m.MyArtistsPage })))
const MyCollectionPage = lazyWithRetry(() => import('./pages/MyCollectionPage.tsx').then(m => ({ default: m.MyCollectionPage })))
const ArtistEditPage = lazyWithRetry(() => import('./pages/ArtistEditPage.tsx').then(m => ({ default: m.ArtistEditPage })))
const ArtistReleasesPage = lazyWithRetry(() => import('./pages/ArtistReleasesPage.tsx').then(m => ({ default: m.ArtistReleasesPage })))
const ArtistTipsPage = lazyWithRetry(() => import('./pages/ArtistTipsPage.tsx').then(m => ({ default: m.ArtistTipsPage })))
const ArtistPromotePage = lazyWithRetry(() => import('./pages/ArtistPromotePage.tsx').then(m => ({ default: m.ArtistPromotePage })))
// One frame per page an artist manages from /my-artists, each knowing which page it is.
const loadSettingsLayout = () => import('./pages/ArtistSettingsLayout.tsx')
const EditProfileLayout = lazyWithRetry(() => loadSettingsLayout().then(m => ({ default: () => <m.ArtistSettingsLayout section="profile" /> })))
const ReleasesLayout = lazyWithRetry(() => loadSettingsLayout().then(m => ({ default: () => <m.ArtistSettingsLayout section="releases" /> })))
const TipsLayout = lazyWithRetry(() => loadSettingsLayout().then(m => ({ default: () => <m.ArtistSettingsLayout section="tips" /> })))
const PromoteLayout = lazyWithRetry(() => loadSettingsLayout().then(m => ({ default: () => <m.ArtistSettingsLayout section="promote" /> })))
const RedirectToReleases = lazyWithRetry(() => loadSettingsLayout().then(m => ({ default: () => <m.RedirectToSection to="releases" /> })))
const RedirectToTips = lazyWithRetry(() => loadSettingsLayout().then(m => ({ default: () => <m.RedirectToSection to="tips" /> })))
const RedirectToPromote = lazyWithRetry(() => loadSettingsLayout().then(m => ({ default: () => <m.RedirectToSection to="promote" /> })))
const ArtistDirectoryPage = lazyWithRetry(() => import('./pages/ArtistDirectoryPage.tsx').then(m => ({ default: m.ArtistDirectoryPage })))
const KnownArtistsPage = lazyWithRetry(() => import('./pages/KnownArtistsPage.tsx').then(m => ({ default: m.KnownArtistsPage })))
const RoadmapPage = lazyWithRetry(() => import('./pages/RoadmapPage.tsx').then(m => ({ default: m.RoadmapPage })))
const SupportPage = lazyWithRetry(() => import('./pages/SupportPage.tsx').then(m => ({ default: m.SupportPage })))
const PrivacyPolicyPage = lazyWithRetry(() => import('./pages/PrivacyPolicyPage.tsx').then(m => ({ default: m.PrivacyPolicyPage })))
const TermsOfUsePage = lazyWithRetry(() => import('./pages/TermsOfUsePage.tsx').then(m => ({ default: m.TermsOfUsePage })))
const AdminMergePage = lazyWithRetry(() => import('./pages/AdminMergePage.tsx').then(m => ({ default: m.AdminMergePage })))
const AdminVerifyPage = lazyWithRetry(() => import('./pages/AdminVerifyPage.tsx').then(m => ({ default: m.AdminVerifyPage })))
const AdminLinksPage = lazyWithRetry(() => import('./pages/AdminLinksPage.tsx').then(m => ({ default: m.AdminLinksPage })))
const AdminReleaseReviewPage = lazyWithRetry(() => import('./pages/AdminReleaseReviewPage.tsx').then(m => ({ default: m.AdminReleaseReviewPage })))
const ResetPasswordPage = lazyWithRetry(() => import('./pages/ResetPasswordPage.tsx').then(m => ({ default: m.ResetPasswordPage })))
const DevelopersPage = lazyWithRetry(() => import('./pages/DevelopersPage.tsx').then(m => ({ default: m.DevelopersPage })))
const PressPage = lazyWithRetry(() => import('./pages/PressPage.tsx').then(m => ({ default: m.PressPage })))
const ContactPage = lazyWithRetry(() => import('./pages/ContactPage.tsx').then(m => ({ default: m.ContactPage })))
const ChangelogPage = lazyWithRetry(() => import('./pages/ChangelogPage.tsx').then(m => ({ default: m.ChangelogPage })))
const ExtensionPage = lazyWithRetry(() => import('./pages/ExtensionPage.tsx').then(m => ({ default: m.ExtensionPage })))
const ImportPage = lazyWithRetry(() => import('./pages/ImportPage.tsx').then(m => ({ default: m.ImportPage })))
const PlatformsPage = lazyWithRetry(() => import('./pages/PlatformsPage.tsx').then(m => ({ default: m.PlatformsPage })))
const ForArtistsPage = lazyWithRetry(() => import('./pages/ForArtistsPage.tsx').then(m => ({ default: m.ForArtistsPage })))
const FaqPage = lazyWithRetry(() => import('./pages/FaqPage.tsx').then(m => ({ default: m.FaqPage })))
const SettingsPage = lazyWithRetry(() => import('./pages/SettingsPage.tsx').then(m => ({ default: m.SettingsPage })))
const TipPage = lazyWithRetry(() => import('./pages/TipPage.tsx').then(m => ({ default: m.TipPage })))
const TipThanksPage = lazyWithRetry(() => import('./pages/TipThanksPage.tsx').then(m => ({ default: m.TipThanksPage })))
const PublicSavedArtistsPage = lazyWithRetry(() => import('./pages/PublicSavedArtistsPage.tsx').then(m => ({ default: m.PublicSavedArtistsPage })))
const AdminAnalyticsPage = lazyWithRetry(() => import('./pages/AdminAnalyticsPage.tsx').then(m => ({ default: m.AdminAnalyticsPage })))
const AdminFlagsPage = lazyWithRetry(() => import('./pages/AdminFlagsPage.tsx').then(m => ({ default: m.AdminFlagsPage })))
const CuratorComposePage = lazyWithRetry(() => import('./pages/CuratorComposePage.tsx').then(m => ({ default: m.CuratorComposePage })))

// Redirect components for old routes
function ArtistLoginRedirect() {
  return <Navigate to="/login" replace />
}

// The dashboard split into /my-artists (artist management) and /my-collection (the fan's
// releases, collection and saved artists). Both old routes stay for bookmarks and links in
// emails already sent, and land on the fan half — what most accounts came for. (Sign-in
// itself resolves between the two; see services/accountHome.ts.)
function DashboardRedirect() {
  return <Navigate to="/my-collection" replace />
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
      {/* Outside the router and Suspense on purpose: it needs neither, and this way it stays
          mounted across navigations and is still visible while a route chunk is downloading —
          including the download that is about to fail because this build is the stale one.

          Its own boundary, separate from the app one below: this banner is a courtesy on top
          of a working app, not something the app depends on. Without this, a throw in
          useBuildFreshness would propagate to the outer boundary and blank the entire app —
          routes, auth, everything — over a freshness check. Fallback renders nothing: if the
          banner is broken, disappearing is strictly better than replacing the whole page. */}
      <Sentry.ErrorBoundary
        fallback={<></>}
        beforeCapture={scope => {
          scope.setTag('context', 'staleBuildBanner.errorBoundary')
        }}
      >
        <StaleBuildBanner />
      </Sentry.ErrorBoundary>
      <AuthProvider>
        {/* Wherever a sign-in lands, a save asked for before it that then failed says so here. */}
        <PendingSaveNotice />
        <BrowserRouter>
          <SkipLink />
          <ScrollToTop />
          <RouteOrientation />
          <Suspense fallback={<AppLoadingFallback />}>
            <Routes>
              <Route path="/" element={<App />} />
              <Route path="/artist/:slug" element={<ArtistPage />} />
              <Route path="/a/:slug" element={<ArtistPage />} />
              <Route path="/claim/:slug" element={<ClaimPage />} />
              <Route path="/artist-login" element={<ArtistLoginRedirect />} />
              <Route path="/artist-dashboard" element={<DashboardRedirect />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/dashboard" element={<DashboardRedirect />} />
              <Route path="/my-artists" element={<MyArtistsPage />} />
              <Route path="/my-collection" element={<MyCollectionPage />} />
              {/* What an artist manages from /my-artists, each its own page with its own button there.
                  They were tabs under Edit until 2026-10-29; the old tab addresses redirect, since
                  Stripe's onboarding links and tip emails point at /artist-edit/:slug/tips. */}
              <Route path="/artist-edit/:slug" element={<EditProfileLayout />}>
                <Route index element={<ArtistEditPage />} />
              </Route>
              <Route path="/releases/:slug" element={<ReleasesLayout />}>
                <Route index element={<ArtistReleasesPage />} />
              </Route>
              <Route path="/tips/:slug" element={<TipsLayout />}>
                <Route index element={<ArtistTipsPage />} />
              </Route>
              <Route path="/promote/:slug" element={<PromoteLayout />}>
                <Route index element={<ArtistPromotePage />} />
              </Route>
              <Route path="/artist-edit/:slug/releases" element={<RedirectToReleases />} />
              <Route path="/artist-edit/:slug/tips" element={<RedirectToTips />} />
              <Route path="/artist-edit/:slug/promote" element={<RedirectToPromote />} />
              <Route path="/artists" element={<ArtistDirectoryPage />} />
              <Route path="/known-artists" element={<KnownArtistsPage />} />
              <Route path="/roadmap" element={<RoadmapPage />} />
              <Route path="/support" element={<SupportPage />} />
              <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
              <Route path="/terms" element={<TermsOfUsePage />} />
              <Route path="/platforms" element={<PlatformsPage />} />
              <Route path="/for-artists" element={<ForArtistsPage />} />
              <Route path="/admin/merge" element={<AdminMergePage />} />
              <Route path="/admin/verify" element={<AdminVerifyPage />} />
              <Route path="/admin/links" element={<AdminLinksPage />} />
              <Route path="/admin/release-review" element={<AdminReleaseReviewPage />} />
              <Route path="/admin/analytics" element={<AdminAnalyticsPage />} />
              <Route path="/admin/flags" element={<AdminFlagsPage />} />
              <Route path="/curator/new" element={<CuratorComposePage />} />
              <Route path="/developers" element={<DevelopersPage />} />
              <Route path="/press" element={<PressPage />} />
              <Route path="/contact" element={<ContactPage />} />
              <Route path="/extension" element={<ExtensionPage />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/changelog" element={<ChangelogPage />} />
              <Route path="/faq" element={<FaqPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/tip/thanks" element={<TipThanksPage />} />
              <Route path="/tip/:slug" element={<TipPage />} />
              <Route path="/u/:handle" element={<PublicSavedArtistsPage />} />
              {/*
                Matched only when nothing else is — React Router ranks routes by specificity, so
                sitting last is for readability, not correctness. Without it an unknown path
                rendered an empty #root — indistinguishable from a crash, and the shape a stale
                service worker takes when it meets a route its build predates.

                Paths Netlify serves itself (the edge-rendered artist and release pages, the feed
                functions, the /guides 301s) never reach the SPA on a page load, so this cannot
                shadow them; `netlify.toml` and the worker's navigateFallbackDenylist are what
                keep that true.
              */}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { RoadmapPage } from './pages/RoadmapPage.tsx'
import { PrivacyPolicyPage } from './pages/PrivacyPolicyPage.tsx'
import { ArtistPage } from './pages/ArtistPage.tsx'
import { ClaimPage } from './pages/ClaimPage.tsx'
import { ClaimedArtistPage } from './pages/ClaimedArtistPage.tsx'
import { ArtistLoginPage } from './pages/ArtistLoginPage.tsx'
import { ArtistDashboardPage } from './pages/ArtistDashboardPage.tsx'
import { ArtistEditPage } from './pages/ArtistEditPage.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/artist/:slug" element={<ArtistPage />} />
        <Route path="/a/:slug" element={<ClaimedArtistPage />} />
        <Route path="/claim/:slug" element={<ClaimPage />} />
        <Route path="/artist-login" element={<ArtistLoginPage />} />
        <Route path="/artist-dashboard" element={<ArtistDashboardPage />} />
        <Route path="/artist-edit/:slug" element={<ArtistEditPage />} />
        <Route path="/roadmap" element={<RoadmapPage />} />
        <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)

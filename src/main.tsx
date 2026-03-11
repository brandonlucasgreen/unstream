import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { RoadmapPage } from './pages/RoadmapPage.tsx'
import { PrivacyPolicyPage } from './pages/PrivacyPolicyPage.tsx'
import { ArtistPage } from './pages/ArtistPage.tsx'
import { EmbedPage } from './pages/EmbedPage.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/artist/:slug" element={<ArtistPage />} />
        <Route path="/roadmap" element={<RoadmapPage />} />
        <Route path="/embed" element={<EmbedPage />} />
        <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { PIP_COLORS } from '@fortytwo/client'
import './styles/theme.css'
import './styles/app.css'
import './styles/domino.css'
import './styles/chip.css'
import './index.css'
import './styles/hall.css'
import { AppAuth0Provider } from './auth/Auth0Provider.tsx'
import { AuthGate } from './auth/AuthGate.tsx'
import { PresenceProvider } from './api/presence.tsx'
import { NavBar } from './components/NavBar.tsx'
import { HowToPlay } from './pages/HowToPlay.tsx'
import { Lobby } from './pages/Lobby.tsx'
import { MatchRoute } from './pages/Match.tsx'
import { NotFound } from './pages/NotFound.tsx'
import { Profile } from './pages/Profile.tsx'
import { unlockChimeOnGesture } from './ui/chime.ts'

const queryClient = new QueryClient()

// Pip colours come from @fortytwo/client so tiles match the mobile app; domino.css and hall.css
// read them as --domino-N-color.
for (const [count, color] of Object.entries(PIP_COLORS)) {
  document.documentElement.style.setProperty(`--domino-${count}-color`, color)
}

// Browsers hold audio until the page gets a click or key press - catch the first one, so the turn
// chime can play later while the player is away.
unlockChimeOnGesture()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppAuth0Provider>
        <QueryClientProvider client={queryClient}>
          <AuthGate>
            <PresenceProvider>
              <NavBar />
              <Routes>
                <Route path="/" element={<Lobby />} />
                <Route path="/match/:matchId" element={<MatchRoute />} />
                <Route path="/profile" element={<Profile />} />
                <Route path="/how-to-play" element={<HowToPlay />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </PresenceProvider>
          </AuthGate>
        </QueryClientProvider>
      </AppAuth0Provider>
    </BrowserRouter>
  </StrictMode>,
)

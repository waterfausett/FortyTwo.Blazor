import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './styles/theme.css'
import './styles/app.css'
import './styles/domino.css'
import './styles/chip.css'
import './index.css'
import { AppAuth0Provider } from './auth/Auth0Provider.tsx'
import { ProtectedRoute } from './auth/ProtectedRoute.tsx'
import { Lobby } from './pages/Lobby.tsx'
import { Match } from './pages/Match.tsx'
import { Profile } from './pages/Profile.tsx'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppAuth0Provider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Lobby />
                </ProtectedRoute>
              }
            />
            <Route
              path="/match/:matchId"
              element={
                <ProtectedRoute>
                  <Match />
                </ProtectedRoute>
              }
            />
            <Route
              path="/profile"
              element={
                <ProtectedRoute>
                  <Profile />
                </ProtectedRoute>
              }
            />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </AppAuth0Provider>
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import './styles/theme.css'
import './styles/app.css'
import './styles/domino.css'
import './styles/chip.css'
import './index.css'
import App from './App.tsx'
import { AppAuth0Provider } from './auth/Auth0Provider.tsx'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppAuth0Provider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </AppAuth0Provider>
  </StrictMode>,
)

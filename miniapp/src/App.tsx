import { useEffect, useState } from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { ToastProvider } from './components/Toast'
import AccessDenied from './screens/AccessDenied'
import Club from './screens/Club'
import Dish from './screens/Dish'
import Home from './screens/Home'
import Menu from './screens/Menu'
import Messages from './screens/Messages'
import Profile from './screens/Profile'
import Splash from './screens/Splash'
import { verifyAccess } from './lib/api'
import { initTelegram } from './lib/telegram'

type AccessState = 'checking' | 'ok' | 'denied'

export default function App() {
  const [access, setAccess] = useState<AccessState>('checking')

  useEffect(() => {
    initTelegram()
    verifyAccess().then((ok) => setAccess(ok ? 'ok' : 'denied'))
  }, [])

  return (
    <div className="mx-auto max-w-[430px] h-[100dvh] bg-bg overflow-hidden relative">
      {access === 'checking' && <div className="h-full" />}
      {access === 'denied' && <AccessDenied />}
      {access === 'ok' && (
        <ToastProvider>
          <HashRouter>
            <Routes>
              <Route path="/" element={<Splash />} />
              <Route path="/home" element={<Home />} />
              <Route path="/menu" element={<Menu />} />
              <Route path="/menu/:id" element={<Dish />} />
              <Route path="/club" element={<Club />} />
              <Route path="/messages" element={<Messages />} />
              <Route path="/profile" element={<Profile />} />
            </Routes>
          </HashRouter>
        </ToastProvider>
      )}
    </div>
  )
}

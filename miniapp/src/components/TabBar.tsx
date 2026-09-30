import { Home, Mail, UtensilsCrossed, User, Users } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { haptic } from '../lib/telegram'

const ITEMS = [
  { id: 'home', path: '/home', label: 'Главная', Icon: Home },
  { id: 'menu', path: '/menu', label: 'Меню', Icon: UtensilsCrossed },
  { id: 'club', path: '/club', label: 'Club', Icon: Users },
  { id: 'messages', path: '/messages', label: 'Послания', Icon: Mail },
  { id: 'profile', path: '/profile', label: 'Профиль', Icon: User },
]

// Тёмно-зелёная панель по брендбуку (отличается от макета) — прижата к
// низу, верхние углы скруглены на 20px, учитывает safe-area.
export default function TabBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const activeId = ITEMS.find((i) => location.pathname.startsWith(i.path))?.id ?? 'home'

  return (
    <nav className="shrink-0 bg-green rounded-t-[20px] flex safe-bottom pt-2">
      {ITEMS.map(({ id, path, label, Icon }) => {
        const active = id === activeId
        return (
          <button
            key={id}
            onClick={() => {
              haptic('select')
              navigate(path)
            }}
            className="flex-1 flex flex-col items-center gap-1 pb-2"
          >
            <Icon size={24} strokeWidth={1.5} color={active ? '#C39A52' : '#A7B3A7'} />
            <span className="text-[12px]" style={{ color: active ? '#C39A52' : '#A7B3A7' }}>
              {label}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

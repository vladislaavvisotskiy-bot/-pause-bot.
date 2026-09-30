import { Bell, ChevronRight, Mail, UtensilsCrossed, User, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import BranchIcon from '../components/BranchIcon'
import Card from '../components/Card'
import ImageWithFallback from '../components/ImageWithFallback'
import Logo from '../components/Logo'
import TabBar from '../components/TabBar'
import { menu, formatSum } from '../data/mock'
import { getUserFirstName } from '../lib/telegram'
import { useStubAction } from '../components/Toast'

const QUICK_ACTIONS = [
  { id: 'menu', label: 'Меню', path: '/menu', Icon: UtensilsCrossed },
  { id: 'club', label: 'Pause Club', path: '/club', Icon: Users },
  { id: 'messages', label: 'Послания', path: '/messages', Icon: Mail },
  { id: 'profile', label: 'Профиль', path: '/profile', Icon: User },
]

export default function Home() {
  const navigate = useNavigate()
  const stub = useStubAction()
  const name = getUserFirstName()
  const featured = menu[0]

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-5 h-14 shrink-0">
        <Logo />
        <button onClick={stub} className="text-green p-1" aria-label="Уведомления">
          <Bell size={22} strokeWidth={1.5} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <div className="pt-2">
          <div className="font-serif text-[26px] leading-[1.2] text-text">
            Добро пожаловать,
            <br />
            {name} <BranchIcon size={20} className="inline text-green -mb-1" />
          </div>
          <div className="text-small text-muted mt-2">Вкусные обеды. Забота о тебе.</div>
        </div>

        <Card className="mt-5 p-3 flex items-center gap-3 cursor-pointer" onClick={() => navigate('/menu')}>
          <ImageWithFallback src={featured.image} alt="" className="w-12 h-12 rounded-full object-cover shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-serif text-h4 text-text">Сегодняшнее меню</div>
            <div className="text-caption text-muted mt-0.5">Скидка 10% на все боулы</div>
          </div>
          <ChevronRight size={18} strokeWidth={1.5} className="text-muted shrink-0" />
        </Card>

        <div className="grid grid-cols-4 gap-2.5 mt-5">
          {QUICK_ACTIONS.map(({ id, label, path, Icon }) => (
            <button
              key={id}
              onClick={() => navigate(path)}
              className="flex flex-col items-center gap-1.5 bg-card border border-border rounded-2xl py-3 shadow-card"
            >
              <Icon size={22} strokeWidth={1.5} className="text-green" />
              <span className="text-[12px] text-text leading-tight text-center">{label}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between mt-6 mb-3">
          <div className="font-serif text-h3 text-text">Популярное</div>
          <button onClick={stub} className="text-[13px] text-muted">
            Все
          </button>
        </div>

        <div
          className="rounded-2xl overflow-hidden flex cursor-pointer"
          style={{ height: 110, background: '#E3D6C1' }}
          onClick={() => navigate(`/menu/${featured.id}`)}
        >
          <ImageWithFallback src={featured.image} alt="" className="w-[55%] h-full object-cover" />
          <div className="flex-1 flex items-center justify-between px-3">
            <div>
              <div className="font-serif text-h4 text-text">{featured.title}</div>
              <div className="font-serif text-[15px] text-text mt-1">{formatSum(featured.price)}</div>
            </div>
            <ChevronRight size={18} strokeWidth={1.5} className="text-muted shrink-0" />
          </div>
        </div>
      </div>

      <TabBar />
    </div>
  )
}

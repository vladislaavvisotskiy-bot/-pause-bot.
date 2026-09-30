import { ChevronRight, Bell, ClipboardList, Crown, Gift, HelpCircle, Heart, Settings } from 'lucide-react'
import BranchIcon from '../components/BranchIcon'
import Button from '../components/Button'
import Card from '../components/Card'
import ScreenHeader from '../components/ScreenHeader'
import TabBar from '../components/TabBar'
import { useStubAction } from '../components/Toast'
import { profile, type ProfileMenuRow } from '../data/mock'

const ROW_ICONS: Record<ProfileMenuRow['icon'], typeof ClipboardList> = {
  orders: ClipboardList,
  heart: Heart,
  bell: Bell,
  gift: Gift,
  help: HelpCircle,
}

export default function Profile() {
  const stub = useStubAction()

  return (
    <div className="h-full flex flex-col">
      <ScreenHeader
        title="Профиль"
        rightSlot={
          <button onClick={stub} aria-label="Настройки">
            <Settings size={20} strokeWidth={1.5} />
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex flex-col items-center text-center pt-2">
          <div className="w-20 h-20 rounded-full bg-sand flex items-center justify-center text-green">
            <BranchIcon size={32} />
          </div>
          <div className="font-serif text-h3 text-text mt-3">{profile.name}</div>
          <div className="text-small text-muted mt-1">{profile.phone}</div>
          <div className="flex items-center gap-1.5 bg-chip rounded-full px-3 py-1.5 mt-3">
            <Crown size={14} strokeWidth={1.5} className="text-gold" />
            <span className="text-[12px] text-text">Участник Pause Club</span>
          </div>
        </div>

        <Card className="mt-6 p-4 flex items-stretch">
          <StatCell value={profile.stats.orders} label="заказов" />
          <div className="w-px bg-border" />
          <StatCell value={profile.stats.promos} label="акции" />
          <div className="w-px bg-border" />
          <StatCell value={profile.stats.posts} label="постов" />
        </Card>

        <Card className="mt-4 px-4">
          {profile.menuRows.map((row, i) => {
            const Icon = ROW_ICONS[row.icon]
            return (
              <button
                key={row.id}
                onClick={stub}
                className={`w-full h-12 flex items-center gap-3 ${i > 0 ? 'border-t border-border' : ''}`}
              >
                <Icon size={20} strokeWidth={1.5} className="text-green shrink-0" />
                <span className="flex-1 text-left text-small text-text">{row.label}</span>
                <ChevronRight size={18} strokeWidth={1.5} className="text-muted shrink-0" />
              </button>
            )
          })}
        </Card>

        <div className="mt-6">
          <Button variant="chip" onClick={stub}>
            Выйти
          </Button>
        </div>
      </div>

      <TabBar />
    </div>
  )
}

function StatCell({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex-1 flex flex-col items-center">
      <div className="font-serif text-h3 text-text">{value}</div>
      <div className="text-[12px] text-muted mt-0.5">{label}</div>
    </div>
  )
}

import { Gift, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import BranchIcon from '../components/BranchIcon'
import Button from '../components/Button'
import Card from '../components/Card'
import Chips from '../components/Chips'
import ImageWithFallback from '../components/ImageWithFallback'
import ScreenHeader from '../components/ScreenHeader'
import TabBar from '../components/TabBar'
import { EmptyState, LoadingState } from '../components/States'
import { useStubAction } from '../components/Toast'
import { messageCategories, messages } from '../data/mock'
import { useSimulatedLoading } from '../lib/useSimulatedLoading'

export default function Messages() {
  const stub = useStubAction()
  const loading = useSimulatedLoading()
  const [category, setCategory] = useState<string>('all')

  const filtered = messages.filter((m) => {
    if (category === 'all') return true
    if (category === 'giveaway') return m.type === 'giveaway'
    if (category === 'announcement') return m.type === 'announcement'
    return false // "Посты" — в mock-данных такого типа пока нет
  })

  return (
    <div className="h-full flex flex-col">
      <ScreenHeader
        title="Послания"
        rightSlot={
          <button onClick={stub} aria-label="Ещё">
            <MoreHorizontal size={20} strokeWidth={1.5} />
          </button>
        }
      />

      <div className="px-5 pb-3">
        <Chips items={messageCategories} active={category} onChange={setCategory} />
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-4">
        {loading ? (
          <LoadingState />
        ) : filtered.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-4">
            {filtered.map((post) =>
              post.type === 'giveaway' ? <GiveawayCard key={post.id} post={post} /> : <AnnouncementCard key={post.id} post={post} />,
            )}
          </div>
        )}
      </div>

      <TabBar />
    </div>
  )
}

function GiveawayCard({ post }: { post: Extract<(typeof messages)[number], { type: 'giveaway' }> }) {
  const stub = useStubAction()
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-lg bg-chip flex items-center justify-center shrink-0 text-error">
            <Gift size={18} strokeWidth={1.5} />
          </div>
          <div>
            <div className="text-[12px] font-semibold text-error">Розыгрыш</div>
            <div className="text-[11px] text-muted">{post.date}</div>
          </div>
        </div>
        <div className="text-[11px] text-muted">{post.date}</div>
      </div>

      <div className="font-serif text-h3 text-text mt-3">{post.title}</div>

      <div className="text-small text-text mt-3">Чтобы участвовать:</div>
      <ol className="mt-1.5 flex flex-col gap-1">
        {post.steps.map((step, i) => (
          <li key={i} className="text-small text-text">
            {i + 1}. {step}
          </li>
        ))}
      </ol>

      <div className="mt-4">
        <Button variant="primary" noArrow onClick={stub}>
          Участвовать
        </Button>
      </div>
    </Card>
  )
}

function AnnouncementCard({ post }: { post: Extract<(typeof messages)[number], { type: 'announcement' }> }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-full bg-green flex items-center justify-center shrink-0 text-white">
            <BranchIcon size={16} />
          </div>
          <div className="text-[13px] font-medium text-text">Анонс</div>
        </div>
        <div className="text-[11px] text-muted">{post.date}</div>
      </div>

      <div className="font-serif text-h4 text-text mt-3">{post.title}</div>
      <div className="text-small text-text mt-1.5">{post.text}</div>
      <ImageWithFallback src={post.image} alt="" className="w-full aspect-[4/3] rounded-xl object-cover mt-3" />
    </Card>
  )
}

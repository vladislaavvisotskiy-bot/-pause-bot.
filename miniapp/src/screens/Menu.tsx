import { ChevronRight, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Card from '../components/Card'
import Chips from '../components/Chips'
import ImageWithFallback from '../components/ImageWithFallback'
import ScreenHeader from '../components/ScreenHeader'
import TabBar from '../components/TabBar'
import { EmptyState, LoadingState } from '../components/States'
import { useStubAction } from '../components/Toast'
import { formatSum, menu, menuCategories, type MenuCategory } from '../data/mock'
import { useSimulatedLoading } from '../lib/useSimulatedLoading'

export default function Menu() {
  const navigate = useNavigate()
  const stub = useStubAction()
  const loading = useSimulatedLoading()
  const [category, setCategory] = useState<MenuCategory | 'all'>('all')

  const filtered = category === 'all' ? menu : menu.filter((m) => m.category === category)

  return (
    <div className="h-full flex flex-col">
      <ScreenHeader
        title="Меню"
        rightSlot={
          <button onClick={stub} aria-label="Фильтр">
            <SlidersHorizontal size={20} strokeWidth={1.5} />
          </button>
        }
      />

      <div className="px-5 pt-1 pb-3">
        <Chips items={menuCategories} active={category} onChange={(id) => setCategory(id as MenuCategory | 'all')} />
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <LoadingState />
        ) : filtered.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map((item) => (
              <Card
                key={item.id}
                className="p-3 flex gap-3 relative cursor-pointer"
                onClick={() => navigate(`/menu/${item.id}`)}
              >
                <ImageWithFallback src={item.image} alt="" className="w-[110px] h-[110px] rounded-xl object-cover shrink-0" />
                <div className="flex-1 min-w-0 flex flex-col">
                  <div className="font-serif text-[15px] font-semibold text-text pr-5">{item.title}</div>
                  <div className="text-[11.5px] text-muted leading-relaxed mt-1">
                    {item.items.map((ing, i) => (
                      <span key={i}>
                        {i > 0 && ' • '}
                        {ing}
                      </span>
                    ))}
                  </div>
                  <div className="font-serif text-[15px] font-semibold text-text mt-auto pt-2">
                    {formatSum(item.price)}
                  </div>
                </div>
                <ChevronRight size={16} strokeWidth={1.5} className="text-muted absolute top-3 right-3" />
              </Card>
            ))}
          </div>
        )}
      </div>

      <TabBar />
    </div>
  )
}

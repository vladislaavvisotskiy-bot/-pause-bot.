import { ChevronLeft, Heart } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import BranchIcon from '../components/BranchIcon'
import Button from '../components/Button'
import ImageWithFallback from '../components/ImageWithFallback'
import { formatSum, menu } from '../data/mock'
import { hideBackButton, showBackButton, haptic } from '../lib/telegram'
import { useStubAction } from '../components/Toast'

export default function Dish() {
  const { id } = useParams()
  const navigate = useNavigate()
  const stub = useStubAction()
  const [liked, setLiked] = useState(false)
  const dish = menu.find((m) => m.id === id) ?? menu[0]

  useEffect(() => {
    const onBack = () => navigate(-1)
    showBackButton(onBack)
    return () => hideBackButton(onBack)
  }, [navigate])

  return (
    <div className="h-full flex flex-col bg-bg">
      <div className="flex items-center justify-between h-14 px-5 shrink-0">
        <button onClick={() => navigate(-1)} className="text-green -ml-2 p-2" aria-label="Назад">
          <ChevronLeft size={24} strokeWidth={1.5} />
        </button>
        <button
          onClick={() => {
            haptic('select')
            setLiked((v) => !v)
          }}
          className="text-green p-2"
          aria-label="В избранное"
        >
          <Heart size={22} strokeWidth={1.5} fill={liked ? '#C39A52' : 'none'} color={liked ? '#C39A52' : '#0D332B'} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-4">
        <ImageWithFallback src={dish.image} alt={dish.title} className="w-full aspect-square rounded-[20px] object-cover" />

        <div className="mt-5">
          <div className="font-serif text-h1 text-text">{dish.title}</div>
          <div className="font-serif text-h2 text-text mt-1">{formatSum(dish.price)}</div>
        </div>

        <div className="mt-5 flex flex-col gap-[14px]">
          {dish.items.map((ing, i) => (
            <div key={i} className="flex items-center gap-2.5">
              <BranchIcon size={16} className="text-muted shrink-0" />
              <span className="text-small text-text">{ing}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="px-5 pb-5 pt-2 shrink-0">
        <Button variant="primary" noArrow onClick={stub}>
          Заказать
        </Button>
      </div>
    </div>
  )
}

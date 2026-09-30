import { ChevronRight, Heart, MessageCircle, MoreHorizontal, Share2 } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import BranchIcon from '../components/BranchIcon'
import Card from '../components/Card'
import Chips from '../components/Chips'
import ImageWithFallback from '../components/ImageWithFallback'
import ScreenHeader from '../components/ScreenHeader'
import TabBar from '../components/TabBar'
import { EmptyState } from '../components/States'
import { useStubAction } from '../components/Toast'
import { clubPhotoGrid, clubPosts } from '../data/mock'
import { haptic } from '../lib/telegram'

const CHIPS = [
  { id: 'all', label: 'Все' },
  { id: 'photo', label: 'Фото' },
  { id: 'messages', label: 'Послания' },
  { id: 'announcements', label: 'Анонсы' },
]

export default function Club() {
  const [params, setParams] = useSearchParams()
  const stub = useStubAction()
  const tab = params.get('tab') ?? 'all'

  return (
    <div className="h-full flex flex-col">
      <ScreenHeader
        title="Pause Club"
        rightSlot={
          <button onClick={stub} aria-label="Ещё">
            <MoreHorizontal size={20} strokeWidth={1.5} />
          </button>
        }
      />

      <div className="px-5 pb-3">
        <Chips items={CHIPS} active={tab} onChange={(id) => setParams(id === 'all' ? {} : { tab: id })} />
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-4">
        {tab === 'photo' ? <PhotoGrid /> : tab === 'all' ? <Feed /> : <EmptyState />}
      </div>

      <TabBar />
    </div>
  )
}

function Feed() {
  const stub = useStubAction()
  const [liked, setLiked] = useState<Record<string, boolean>>({})

  return (
    <div className="flex flex-col gap-4">
      {clubPosts.map((post) => (
        <Card key={post.id} className="p-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-sand flex items-center justify-center shrink-0 text-green">
              <BranchIcon size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-medium text-text">{post.author}</div>
              <div className="text-[11px] text-muted">{post.date}</div>
            </div>
            <button onClick={stub} className="text-muted" aria-label="Ещё">
              <MoreHorizontal size={18} strokeWidth={1.5} />
            </button>
          </div>

          <div className="text-[14px] text-text mt-3 leading-relaxed">{post.text}</div>

          <ImageWithFallback src={post.image} alt="" className="w-full aspect-[4/3] rounded-xl object-cover mt-3" />

          <div className="flex items-center gap-4 mt-3">
            <button
              onClick={() => {
                haptic('select')
                setLiked((v) => ({ ...v, [post.id]: !v[post.id] }))
              }}
              className="flex items-center gap-1.5 text-muted text-[13px]"
            >
              <Heart size={18} strokeWidth={1.5} fill={liked[post.id] ? '#C39A52' : 'none'} color={liked[post.id] ? '#C39A52' : '#777268'} />
              {post.likes + (liked[post.id] ? 1 : 0)}
            </button>
            <button onClick={stub} className="flex items-center gap-1.5 text-muted text-[13px]">
              <MessageCircle size={18} strokeWidth={1.5} />
              {post.comments}
            </button>
            <button onClick={stub} className="flex items-center gap-1.5 text-muted text-[13px]">
              <Share2 size={18} strokeWidth={1.5} />
              {post.shares}
            </button>
            <ChevronRight size={18} strokeWidth={1.5} className="text-muted ml-auto" />
          </div>
        </Card>
      ))}
    </div>
  )
}

function PhotoGrid() {
  return (
    <div className="grid grid-cols-3 gap-1">
      {clubPhotoGrid.map((cell) => {
        if (!cell.image) {
          return (
            <div key={cell.id} className="aspect-square rounded-md bg-sand flex items-center justify-center p-1">
              <div className="font-serif text-[12px] text-text text-center leading-snug">
                {cell.caption?.map((line, i) => <div key={i}>{line}</div>)}
              </div>
            </div>
          )
        }
        return (
          <ImageWithFallback
            key={cell.id}
            src={cell.image}
            alt=""
            className="aspect-square rounded-md object-cover"
          />
        )
      })}
    </div>
  )
}

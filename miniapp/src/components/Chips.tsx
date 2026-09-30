import { haptic } from '../lib/telegram'

type ChipItem = { id: string; label: string }

type Props = {
  items: readonly ChipItem[]
  active: string
  onChange: (id: string) => void
}

export default function Chips({ items, active, onChange }: Props) {
  return (
    <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-5 px-5">
      {items.map((item) => {
        const isActive = item.id === active
        return (
          <button
            key={item.id}
            onClick={() => {
              haptic('select')
              onChange(item.id)
            }}
            className={`shrink-0 h-[34px] px-4 rounded-full text-[14px] font-medium whitespace-nowrap ${
              isActive ? 'bg-green text-white' : 'bg-chip text-text'
            }`}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

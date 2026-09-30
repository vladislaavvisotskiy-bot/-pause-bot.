import { ChevronLeft } from 'lucide-react'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { hideBackButton, showBackButton } from '../lib/telegram'

type Props = {
  title?: string
  rightSlot?: React.ReactNode
}

// Стрелка «назад» слева, заголовок по центру (Playfair Display 20px,
// green), справа — слот под иконку действия (⋮, фильтр, сердце,
// шестерёнка — передаётся снаружи). На внутренних экранах дополнительно
// включаем нативную Telegram.WebApp.BackButton — она сворачивает Mini
// App/возвращает назад системным жестом, что не делает наша стрелка.
export default function ScreenHeader({ title, rightSlot }: Props) {
  const navigate = useNavigate()

  useEffect(() => {
    const onBack = () => navigate(-1)
    showBackButton(onBack)
    return () => hideBackButton(onBack)
  }, [navigate])

  return (
    <div className="flex items-center h-14 px-5 bg-bg shrink-0">
      <button onClick={() => navigate(-1)} className="text-green -ml-2 p-2" aria-label="Назад">
        <ChevronLeft size={24} strokeWidth={1.5} />
      </button>
      {title && <h1 className="flex-1 text-center font-serif text-[20px] text-green">{title}</h1>}
      {!title && <div className="flex-1" />}
      <div className="w-8 flex justify-end text-green">{rightSlot}</div>
    </div>
  )
}

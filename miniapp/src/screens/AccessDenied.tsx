import { Lock } from 'lucide-react'
import Logo from '../components/Logo'

// Показывается, если проверка initData на сервере не прошла (не админ,
// подпись неверна/просрочена) — см. lib/api.ts:verifyAccess и
// pauseapp.py:/api/verify. Никаких данных или элементов макета здесь
// не должно быть, только это сообщение.
export default function AccessDenied() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-5 px-8 text-center bg-bg">
      <Logo />
      <div className="w-14 h-14 rounded-full bg-chip flex items-center justify-center">
        <Lock size={26} strokeWidth={1.5} className="text-muted" />
      </div>
      <div>
        <div className="font-serif text-h3 text-text">Доступ закрыт</div>
        <div className="text-small text-muted mt-2 max-w-[260px]">
          Это приложение пока доступно только команде PAUSE
        </div>
      </div>
    </div>
  )
}

import { AlertTriangle, Leaf } from 'lucide-react'
import Button from './Button'
import Card from './Card'

export function LoadingState() {
  return (
    <Card className="flex flex-col items-center justify-center gap-3 py-10">
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-2 h-2 rounded-full bg-gold animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
      <div className="text-center">
        <div className="font-serif text-h4 text-text">Загрузка…</div>
        <div className="text-caption text-muted mt-0.5">Пожалуйста, подождите</div>
      </div>
    </Card>
  )
}

export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <Leaf size={40} strokeWidth={1.5} className="text-muted" />
      <div>
        <div className="font-serif text-h4 text-text">Пока ничего нет</div>
        <div className="text-caption text-muted mt-1 max-w-[240px]">
          Здесь появятся ваши заказы, послания и публикации
        </div>
      </div>
    </div>
  )
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center px-5">
      <div className="w-12 h-12 rounded-full bg-error/10 flex items-center justify-center">
        <AlertTriangle size={24} strokeWidth={1.5} className="text-error" />
      </div>
      <div>
        <div className="font-serif text-h4 text-text">Что-то пошло не так</div>
        <div className="text-caption text-muted mt-1">Попробуйте ещё раз</div>
      </div>
      <div className="w-full max-w-[200px]">
        <Button variant="primary" noArrow onClick={onRetry}>
          Повторить
        </Button>
      </div>
    </div>
  )
}

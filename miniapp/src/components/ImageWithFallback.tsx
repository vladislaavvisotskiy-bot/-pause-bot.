import { useState } from 'react'

type Props = {
  src: string
  alt?: string
  className?: string
}

// Пока реальных фото нет (см. SPEC.md §6) — при ошибке загрузки
// показываем тёплый бежево-коричневый градиент того же размера, чтобы
// вёрстка не ломалась; когда пользователь положит свои файлы в
// public/images/, всё подхватится само, без правки кода.
export default function ImageWithFallback({ src, alt = '', className = '' }: Props) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div
        className={className}
        style={{
          background: 'linear-gradient(135deg, #E3D6C1 0%, #C7A882 55%, #A8845C 100%)',
        }}
        aria-label={alt}
      />
    )
  }

  return <img src={src} alt={alt} className={className} onError={() => setFailed(true)} />
}

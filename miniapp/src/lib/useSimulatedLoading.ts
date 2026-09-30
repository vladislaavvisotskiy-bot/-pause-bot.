import { useEffect, useState } from 'react'

// Имитация загрузки ~600мс при первом открытии экрана (см. SPEC.md §
// "Состояния интерфейса") — данных пока и так нет, они из mock.ts, но
// нужно показать, как выглядит состояние загрузки.
export function useSimulatedLoading(ms = 600) {
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setLoading(false), ms)
    return () => clearTimeout(t)
  }, [ms])
  return loading
}

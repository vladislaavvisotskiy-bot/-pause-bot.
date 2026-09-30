import { Check, Mail, X } from 'lucide-react'
import { createContext, useCallback, useContext, useRef, useState } from 'react'

type ToastVariant = 'success' | 'message'

type ToastState = {
  variant: ToastVariant
  title: string
  subtitle: string
}

type ToastContextValue = {
  showToast: (variant: ToastVariant, title?: string, subtitle?: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}

// Единая точка для всех "пока не работает" кнопок макета (Заказать,
// Участвовать, Выйти, лайки и т.п.) — показывает тост "Успешно / Скоро
// будет доступно", как просили в ТЗ вместо реального действия.
export function useStubAction() {
  const { showToast } = useToast()
  return useCallback(() => showToast('success', 'Успешно', 'Скоро будет доступно'), [showToast])
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((variant: ToastVariant, title = '', subtitle = '') => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setToast({ variant, title, subtitle })
    timerRef.current = setTimeout(() => setToast(null), 3000)
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && <ToastView toast={toast} onClose={() => setToast(null)} />}
    </ToastContext.Provider>
  )
}

function ToastView({ toast, onClose }: { toast: ToastState; onClose: () => void }) {
  const isSuccess = toast.variant === 'success'
  return (
    <div className="fixed top-3 left-3 right-3 z-50 mx-auto max-w-[390px]">
      <div
        className={`flex items-center gap-3 rounded-2xl px-4 py-3 shadow-card ${
          isSuccess ? 'bg-card border border-success' : 'bg-green'
        }`}
      >
        <div
          className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
            isSuccess ? 'bg-success text-white' : 'text-white'
          }`}
        >
          {isSuccess ? <Check size={16} strokeWidth={2} /> : <Mail size={18} strokeWidth={1.5} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-[14px] font-medium ${isSuccess ? 'text-text' : 'text-white'}`}>{toast.title}</div>
          {toast.subtitle && (
            <div className={`text-[12px] ${isSuccess ? 'text-muted' : 'text-white/80'}`}>{toast.subtitle}</div>
          )}
        </div>
        <button onClick={onClose} className={isSuccess ? 'text-muted' : 'text-white/80'} aria-label="Закрыть">
          <X size={18} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}

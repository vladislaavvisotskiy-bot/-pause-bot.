// Безопасная обёртка над window.Telegram.WebApp — вне Telegram (обычный
// браузер) объект просто отсутствует, поэтому каждый метод проверяет его
// наличие сам и тихо ничего не делает, а не бросает исключение.

type TelegramUser = {
  id: number
  first_name?: string
  last_name?: string
  username?: string
  photo_url?: string
}

type TelegramWebApp = {
  ready: () => void
  expand: () => void
  setHeaderColor: (color: string) => void
  setBackgroundColor: (color: string) => void
  close: () => void
  initData: string
  initDataUnsafe: { user?: TelegramUser }
  BackButton: {
    show: () => void
    hide: () => void
    onClick: (cb: () => void) => void
    offClick: (cb: () => void) => void
  }
  HapticFeedback?: {
    impactOccurred: (style: string) => void
    selectionChanged: () => void
    notificationOccurred: (type: string) => void
  }
}

function getWebApp(): TelegramWebApp | null {
  const w = window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }
  return w.Telegram?.WebApp ?? null
}

export function initTelegram() {
  const wa = getWebApp()
  if (!wa) return
  try {
    wa.ready()
    wa.expand()
    wa.setHeaderColor('#0D332B')
    wa.setBackgroundColor('#F4EBDD')
  } catch {
    // вне Telegram или неполный объект — молча продолжаем как в браузере
  }
}

export function getInitData(): string {
  return getWebApp()?.initData ?? ''
}

export function getUserFirstName(fallback = 'Алексей'): string {
  const name = getWebApp()?.initDataUnsafe?.user?.first_name
  return name && name.trim() ? name : fallback
}

export function showBackButton(onBack: () => void) {
  const wa = getWebApp()
  if (!wa) return
  try {
    wa.BackButton.onClick(onBack)
    wa.BackButton.show()
  } catch {
    // нет BackButton в этой версии клиента — просто не показываем
  }
}

export function hideBackButton(onBack: () => void) {
  const wa = getWebApp()
  if (!wa) return
  try {
    wa.BackButton.offClick(onBack)
    wa.BackButton.hide()
  } catch {
    // см. showBackButton
  }
}

export function haptic(kind: 'select' | 'success' | 'error' | 'light' = 'light') {
  const wa = getWebApp()
  if (!wa?.HapticFeedback) return
  try {
    if (kind === 'select') wa.HapticFeedback.selectionChanged()
    else if (kind === 'success' || kind === 'error') wa.HapticFeedback.notificationOccurred(kind)
    else wa.HapticFeedback.impactOccurred('light')
  } catch {
    // безопасно игнорируем — тактильный отклик никогда не критичен
  }
}

export function closeApp() {
  getWebApp()?.close()
}

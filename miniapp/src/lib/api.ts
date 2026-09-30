import { getInitData } from './telegram'

// Приложение смонтировано на сервере не в корне домена, а под /pauseapp/
// (см. pauseapp.py) — рядом ещё курьерский Mini App на /miniapp с другими
// путями, поэтому все обращения к серверу идут через этот префикс.
const API_BASE = '/pauseapp'

export async function verifyAccess(): Promise<boolean> {
  try {
    const resp = await fetch(`${API_BASE}/api/verify`, {
      headers: { 'X-Telegram-Init-Data': getInitData() },
    })
    if (!resp.ok) return false
    const data = await resp.json()
    return Boolean(data.ok)
  } catch {
    return false
  }
}

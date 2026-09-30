# -*- coding: utf-8 -*-
"""
Telegram Mini App "PAUSE" (клиентский UI-прототип, только для админов) —
раздаёт собранный React/TypeScript/Vite билд (miniapp/dist/, см.
miniapp/SPEC.md) и проверяет доступ.

Функциональности внутри приложения пока нет — все данные mock, реального
API/Google Sheets оно не касается (см. miniapp/src/data/mock.ts), работает
только навигация. Поэтому единственная задача backend здесь — решить,
пускать конкретного пользователя в приложение или нет, а не отдавать
какие-то данные.

Проверка доступа устроена так же, как и в курьерском Mini App
(webapp.py): фронтенд шлёт Telegram.WebApp.initData в заголовке
X-Telegram-Init-Data, сервер проверяет HMAC-SHA256 подпись по BOT_TOKEN
(см. webapp._verify_init_data — переиспользуется отсюда, а не
дублируется) и сверяет полученный user.id со списком config.ADMIN_IDS.
Не прошло — /api/verify отвечает {"ok": false}, и React показывает
брендовый экран "Доступ закрыт" (miniapp/src/screens/AccessDenied.tsx),
не показывая ничего из макета. Проверка только на фронтенде — это как
раз то, чего явно просили избежать: сам React ничего не решает, только
верит ответу этого эндпоинта.
"""
import os

from aiohttp import web

import config
from webapp import _verify_init_data

STATIC_DIR = os.path.join(os.path.dirname(__file__), "miniapp", "dist")


def _is_admin(tg_id) -> bool:
    return tg_id in config.ADMIN_IDS


async def api_verify(request: web.Request):
    init_data = request.headers.get("X-Telegram-Init-Data", "")
    parsed = _verify_init_data(init_data)
    if not parsed:
        return web.json_response({"ok": False}, status=403)

    user = parsed.get("user") or {}
    try:
        tg_id = int(user.get("id")) if user.get("id") is not None else None
    except (TypeError, ValueError):
        tg_id = None

    if tg_id is None or not _is_admin(tg_id):
        return web.json_response({"ok": False}, status=403)
    return web.json_response({"ok": True})


async def index_page(request: web.Request):
    index_path = os.path.join(STATIC_DIR, "index.html")
    if not os.path.exists(index_path):
        # miniapp/dist ещё не собран (npm run build) — сообщаем прямо,
        # а не отдаём невнятный 404 от статики.
        return web.Response(
            text="PAUSE Mini App не собран: выполните npm run build в папке miniapp/.",
            status=503,
        )
    return web.FileResponse(index_path)


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/api/verify", api_verify)
    app.router.add_get("/", index_page)
    # Всё остальное (Vite-бандл в /assets/, а позже и реальные фото
    # пользователя в /images/ — см. miniapp/public/images/) — статика
    # напрямую из miniapp/dist/, без отдельного префикса: index_page
    # выше зарегистрирован для точного пути "/" раньше этого prefix-
    # маршрута, поэтому конфликта между ними нет (проверено).
    if os.path.isdir(STATIC_DIR):
        app.router.add_static("/", STATIC_DIR, show_index=False)
    return app

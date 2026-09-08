# -*- coding: utf-8 -*-
"""
Веб-сервер для Telegram Mini App "Маршрут курьера" — работает в том же
процессе и на том же event loop, что и сам бот (polling), как отдельный
aiohttp-сервер (см. run_webapp(), вызывается из bot.py через asyncio.gather
рядом с dp.start_polling — не вместо него).

Отдаёт статическую страницу Mini App (webapp_static/) и JSON API для неё
(/api/*). Все данные читаются из Google Таблицы каждый запрос (см.
sheets.get_route_for_date — сама синхронизирует новые точки) — долгого
кэша нет, поэтому правки прямо в таблице руками всегда видны сразу же.

Аутентификация — через Telegram WebApp initData: фронтенд шлёт его в
заголовке X-Telegram-Init-Data на каждый запрос к /api/*, сервер проверяет
подпись по алгоритму из
https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
(HMAC-SHA256 по BOT_TOKEN) — так сервер точно знает Telegram ID отправителя
и не может быть обманут одним лишь URL-параметром.
"""
import hashlib
import hmac
import json
import logging
import os
import time
from urllib.parse import parse_qsl

from aiohttp import web

import config
import sheets

logger = logging.getLogger("pause_bot")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "webapp_static")
INIT_DATA_MAX_AGE = 24 * 60 * 60  # секунд — старше суток initData не принимаем


def _verify_init_data(init_data: str):
    """Проверяет подпись Telegram WebApp initData. Возвращает распарсенные
    поля (включая "user" как dict) либо None, если подпись неверна,
    просрочена, initData пуст или BOT_TOKEN не задан."""
    if not init_data or not config.BOT_TOKEN:
        return None
    try:
        pairs = dict(parse_qsl(init_data, strict_parsing=True))
    except ValueError:
        return None
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
    secret_key = hmac.new(b"WebAppData", config.BOT_TOKEN.encode(), hashlib.sha256).digest()
    computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(computed_hash, received_hash):
        return None

    try:
        auth_date = int(pairs.get("auth_date", "0"))
    except ValueError:
        auth_date = 0
    if auth_date <= 0 or time.time() - auth_date > INIT_DATA_MAX_AGE:
        return None

    result = dict(pairs)
    if "user" in result:
        try:
            result["user"] = json.loads(result["user"])
        except ValueError:
            result["user"] = None
    return result


def _extract_tg_id(request: web.Request):
    init_data = request.headers.get("X-Telegram-Init-Data", "")
    parsed = _verify_init_data(init_data)
    if not parsed:
        return None
    user = parsed.get("user") or {}
    tg_id = user.get("id")
    try:
        return int(tg_id) if tg_id is not None else None
    except (TypeError, ValueError):
        return None


def _role_for(tg_id) -> str:
    if config.ADMIN_CHAT_ID and tg_id == config.ADMIN_CHAT_ID:
        return "admin"
    if sheets.is_active_courier(tg_id):
        return "courier"
    return ""


@web.middleware
async def auth_middleware(request: web.Request, handler):
    if request.path.startswith("/api/"):
        tg_id = _extract_tg_id(request)
        if tg_id is None:
            return web.json_response({"error": "unauthorized"}, status=401)
        role = _role_for(tg_id)
        if not role:
            return web.json_response({"error": "forbidden"}, status=403)
        request["tg_id"] = tg_id
        request["role"] = role
    return await handler(request)


def _today() -> str:
    return sheets.get_active_menu_date()


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

async def api_me(request: web.Request):
    return web.json_response({"role": request["role"], "tg_id": request["tg_id"]})


async def api_route_get(request: web.Request):
    date_str = request.query.get("date") or _today()
    role = request["role"]
    try:
        route = sheets.get_route_for_date(date_str)
    except Exception:
        logger.exception("Не удалось получить маршрут на %s", date_str)
        return web.json_response({"error": "sheets_error"}, status=502)
    if role == "courier":
        tg_id = str(request["tg_id"])
        route = [p for p in route if p["courier_tg_id"] == tg_id]
    return web.json_response({"date": date_str, "role": role, "points": route})


async def api_delivery_points(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    return web.json_response({"points": sheets.get_delivery_points()})


async def api_route_reorder(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or _today()
    order_map = body.get("order") or {}
    sheets.reorder_route(date_str, order_map)
    return web.json_response({"ok": True})


async def api_route_add(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or _today()
    point = (body.get("point") or "").strip()
    if not point:
        return web.json_response({"error": "point required"}, status=400)
    sheets.add_route_point(date_str, point)
    return web.json_response({"ok": True})


async def api_route_remove(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or _today()
    point = (body.get("point") or "").strip()
    sheets.remove_route_point(date_str, point)
    return web.json_response({"ok": True})


async def api_route_complete(request: web.Request):
    body = await request.json()
    date_str = body.get("date") or _today()
    point = (body.get("point") or "").strip()
    if not point:
        return web.json_response({"error": "point required"}, status=400)
    if request["role"] == "courier":
        # курьер может отмечать сданными только свои собственные точки
        route = sheets.get_route_for_date(date_str)
        mine = {p["point"] for p in route if p["courier_tg_id"] == str(request["tg_id"])}
        if point not in mine:
            return web.json_response({"error": "forbidden"}, status=403)
    sheets.mark_route_delivered(date_str, point)
    return web.json_response({"ok": True})


async def api_earnings(request: web.Request):
    if request["role"] != "courier":
        return web.json_response({"error": "forbidden"}, status=403)
    date_str = request.query.get("date") or _today()
    total = sheets.get_courier_earnings(request["tg_id"], date_str)
    return web.json_response({"date": date_str, "total": total})


async def api_earnings_month(request: web.Request):
    if request["role"] != "courier":
        return web.json_response({"error": "forbidden"}, status=403)
    try:
        year = int(request.query.get("year"))
        month = int(request.query.get("month"))
    except (TypeError, ValueError):
        now = sheets._now()
        year, month = now.year, now.month
    total = sheets.get_courier_earnings_month(request["tg_id"], year, month)
    return web.json_response({"year": year, "month": month, "total": total})


async def index_page(request: web.Request):
    return web.FileResponse(os.path.join(STATIC_DIR, "index.html"))


def create_app() -> web.Application:
    app = web.Application(middlewares=[auth_middleware])
    app.router.add_get("/miniapp", index_page)
    app.router.add_get("/miniapp/", index_page)
    app.router.add_static("/miniapp/static/", STATIC_DIR, show_index=False)
    app.router.add_get("/api/me", api_me)
    app.router.add_get("/api/route", api_route_get)
    app.router.add_get("/api/delivery_points", api_delivery_points)
    app.router.add_post("/api/route/reorder", api_route_reorder)
    app.router.add_post("/api/route/add", api_route_add)
    app.router.add_post("/api/route/remove", api_route_remove)
    app.router.add_post("/api/route/complete", api_route_complete)
    app.router.add_get("/api/earnings", api_earnings)
    app.router.add_get("/api/earnings/month", api_earnings_month)
    return app


async def run_webapp():
    """Запускает веб-сервер на config.WEBAPP_PORT — вызывать вместе с
    dp.start_polling(bot) через asyncio.gather, не вместо него."""
    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", config.WEBAPP_PORT)
    await site.start()
    logger.info("Mini App веб-сервер запущен на порту %s", config.WEBAPP_PORT)

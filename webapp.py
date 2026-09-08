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
import asyncio
import hashlib
import hmac
import json
import logging
import os
import time
from urllib.parse import parse_qsl

import gspread
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


async def _retry_sheets(fn, *args, retries: int = 1, delay: float = 1.5, **kwargs):
    """Google Sheets API иногда на секунду-другую отвечает 429 (Quota
    exceeded for quota metric 'Read requests'/'Write requests') под нагрузкой
    — это ровно то, что несколько раз ловилось вживую при разработке этого
    проекта. Один быстрый повтор чаще всего решает дело сам, вместо того
    чтобы курьер/админ видел ошибку из-за случайного всплеска.

    gspread делает обычный синхронный HTTP-запрос. Раньше он вызывался прямо
    в корутине — это блокирует ВЕСЬ event loop процесса (тот же самый, на
    котором работает polling бота, см. bot.py и docstring выше) на всё время
    запроса, а при повторе — ещё и на время time.sleep(delay) сверху. Из-за
    этого один медленный запрос (или ожидание перед повтором) от одного
    клиента фактически "вешал" все остальные запросы к Mini App и сам бот на
    это время — под реальной нагрузкой (например, бот параллельно обрабатывает
    заказ клиента) это ровно то, что могло выглядеть как случайная ошибка при
    перетаскивании точки в Mini App: запрос упирается в чужую блокировку
    event loop и не укладывается в таймаут WebView. Поэтому сам вызов и
    задержка перед повтором вынесены в отдельный поток (asyncio.to_thread) —
    других клиентов они больше не блокируют."""
    last_exc = None
    for attempt in range(retries + 1):
        try:
            return await asyncio.to_thread(fn, *args, **kwargs)
        except gspread.exceptions.APIError as e:
            last_exc = e
            if e.code != 429 or attempt == retries:
                raise
            await asyncio.sleep(delay)
    raise last_exc


async def _role_for(tg_id) -> str:
    if config.ADMIN_CHAT_ID and tg_id == config.ADMIN_CHAT_ID:
        return "admin"
    if await _retry_sheets(sheets.is_active_courier, tg_id):
        return "courier"
    return ""


@web.middleware
async def error_middleware(request: web.Request, handler):
    """Последняя линия обороны: если что-то ниже по цепочке (включая саму
    проверку роли в auth_middleware) упадёт необработанным исключением —
    например, Google Sheets на секунду ответит с ошибкой — отдаём аккуратный
    JSON-ответ вместо голого HTTP 500. Именно отсутствие такой защиты вокруг
    проверки роли (она дёргается на КАЖДЫЙ запрос к /api/*, чаще всего
    остального) и было причиной "маршрут загрузился, а потом пропал с
    ошибкой 500" — воспроизведено и подтверждено локально перед фиксом."""
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except Exception:
        logger.exception("Необработанная ошибка на %s %s", request.method, request.path)
        return web.json_response({"error": "server_error"}, status=503)


@web.middleware
async def auth_middleware(request: web.Request, handler):
    if request.path.startswith("/api/"):
        tg_id = _extract_tg_id(request)
        if tg_id is None:
            return web.json_response({"error": "unauthorized"}, status=401)
        role = await _role_for(tg_id)
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
    route = await _retry_sheets(sheets.get_route_for_date, date_str)
    if role == "courier":
        tg_id = str(request["tg_id"])
        route = [p for p in route if p["courier_tg_id"] == tg_id]
    return web.json_response({"date": date_str, "role": role, "points": route})


async def api_delivery_points(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    return web.json_response({"points": await _retry_sheets(sheets.get_delivery_points)})


async def api_route_reorder(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or _today()
    order_map = body.get("order") or {}
    # Это осознанное действие админа (перетащил карточку) — потерять его
    # обиднее, чем лишний повторный показ маршрута, поэтому здесь два повтора
    # вместо одного.
    await _retry_sheets(sheets.reorder_route, date_str, order_map, retries=2)
    return web.json_response({"ok": True})


async def api_route_add(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or _today()
    point = (body.get("point") or "").strip()
    if not point:
        return web.json_response({"error": "point required"}, status=400)
    await _retry_sheets(sheets.add_route_point, date_str, point)
    return web.json_response({"ok": True})


async def api_route_remove(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or _today()
    point = (body.get("point") or "").strip()
    await _retry_sheets(sheets.remove_route_point, date_str, point)
    return web.json_response({"ok": True})


async def api_route_complete(request: web.Request):
    body = await request.json()
    date_str = body.get("date") or _today()
    point = (body.get("point") or "").strip()
    if not point:
        return web.json_response({"error": "point required"}, status=400)
    if request["role"] == "courier":
        # курьер может отмечать сданными только свои собственные точки
        route = await _retry_sheets(sheets.get_route_for_date, date_str)
        mine = {p["point"] for p in route if p["courier_tg_id"] == str(request["tg_id"])}
        if point not in mine:
            return web.json_response({"error": "forbidden"}, status=403)
    await _retry_sheets(sheets.mark_route_delivered, date_str, point, retries=2)
    return web.json_response({"ok": True})


async def api_earnings(request: web.Request):
    if request["role"] != "courier":
        return web.json_response({"error": "forbidden"}, status=403)
    date_str = request.query.get("date") or _today()
    total = await _retry_sheets(sheets.get_courier_earnings, request["tg_id"], date_str)
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
    total = await _retry_sheets(sheets.get_courier_earnings_month, request["tg_id"], year, month)
    return web.json_response({"year": year, "month": month, "total": total})


async def index_page(request: web.Request):
    return web.FileResponse(os.path.join(STATIC_DIR, "index.html"))


def create_app() -> web.Application:
    app = web.Application(middlewares=[error_middleware, auth_middleware])
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

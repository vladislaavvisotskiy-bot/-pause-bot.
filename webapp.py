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
import requests
from aiohttp import web

import config
import sheets
import texts
import keyboards as kb

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


def _extract_tg_user(request: web.Request):
    """(tg_id, display_name) по подписанному initData — display_name нужен
    только для справки в листе "Режим Маршрута" (см. sheets.set_route_admin_mode),
    ни на какую логику прав не влияет."""
    init_data = request.headers.get("X-Telegram-Init-Data", "")
    parsed = _verify_init_data(init_data)
    if not parsed:
        return None, ""
    user = parsed.get("user") or {}
    tg_id = user.get("id")
    try:
        tg_id = int(tg_id) if tg_id is not None else None
    except (TypeError, ValueError):
        tg_id = None
    name = " ".join(filter(None, [user.get("first_name"), user.get("last_name")])).strip() or user.get("username") or ""
    return tg_id, name


def _extract_tg_id(request: web.Request):
    """Только ID, без имени — для pauseapp.py (см. импорт в pauseapp.py),
    которому имя не нужно."""
    tg_id, _ = _extract_tg_user(request)
    return tg_id


_RETRYABLE_API_CODES = {429, 500, 502, 503, 504}


async def _retry_sheets(fn, *args, retries: int = 2, delay: float = 1.2, **kwargs):
    """Google Sheets API иногда на секунду-другую отвечает 429 (Quota
    exceeded for quota metric 'Read requests'/'Write requests') под нагрузкой
    — это ровно то, что несколько раз ловилось вживую при разработке этого
    проекта, и то же самое воспроизвелось при повторных открытиях экрана
    "Маршрут" подряд: get_route_for_date раньше читал "Заказы"/"Маршрут"
    по два раза за один показ экрана (см. docstring sheets.sync_daily_route)
    — несколько открытий подряд легко упирались в лимит запросов в минуту.
    Кроме 429 таким же временным сбоем бывает 500/502/503/504 от самого
    Google (кратковременная перегрузка на их стороне) и обрыв соединения на
    уровне транспорта (requests.exceptions.RequestException) — сеть Railway
    не идеальна, обрыв на секунду не должен выглядеть для курьера/админа как
    "приложение сломано". Retries подняты до 2 (было 1) именно для самого
    частого и самого чувствительного к повторным открытиям пути — чтения
    маршрута.

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
            if e.code not in _RETRYABLE_API_CODES or attempt == retries:
                raise
            await asyncio.sleep(delay)
        except requests.exceptions.RequestException as e:
            last_exc = e
            if attempt == retries:
                raise
            await asyncio.sleep(delay)
    raise last_exc


async def _role_for(tg_id):
    """Возвращает (role, is_route_admin, is_dynamic_route_admin). role —
    что показывает раздел "Заказы": "admin" (управление точками/
    курьерами) или "courier" (меню "Поехали"/"Сдал"). is_route_admin —
    видит ли человек админский "Профиль" (видимость маршрута, расходы на
    логистику) — true и для основного админа бота (ADMIN_IDS), и для
    владельца (OWNER_TG_ID), и для курьеров, назначенных администраторами
    через "Курьеры" (см. is_dynamic_route_admin) — и остаётся true даже
    когда такой админ переключился в режим "Курьер" (иначе он не смог бы
    вернуться обратно — "Профиль" в этом режиме показывал бы
    courier-экран без переключателя). is_dynamic_route_admin — отдельно,
    т.к. нужен ещё раз в auth_middleware для can_toggle_mode.

    Раньше был ещё и статический список config.ROUTE_ADMIN_IDS
    (переменная окружения) — по прямой просьбе убран целиком: постоянное
    назначение прав больше не предусмотрено ни для кого, кроме самого
    владельца (OWNER_TG_ID) — любой другой администратор назначается и
    снимается ТОЛЬКО через "Курьеры" (см. is_courier_route_admin).

    OWNER_TG_ID/is_dynamic_route_admin проверяем ПЕРЕД ADMIN_IDS:
    основной админ бота (Влад) может одновременно быть и OWNER_TG_ID —
    если проверять ADMIN_IDS первым, для него role всегда оказывался бы
    "admin" независимо от сохранённого режима, и переключение в "Курьер"
    молча не действовало бы (воспроизведено: запись в "Режим Маршрута"
    сохранялась, но раздел "Заказы" после перезагрузки всё равно
    показывал админский интерфейс с перетаскиванием карточек). Основному
    админу, который ни владелец, ни назначенный администратор, самого
    переключения режима не показываем (см. api_route_admin_mode_set) — у
    него role всегда "admin", как и раньше."""
    if tg_id == config.OWNER_TG_ID:
        mode = await _retry_sheets(sheets.get_route_admin_mode, tg_id)
        return mode, True, False
    if await _retry_sheets(sheets.is_courier_route_admin, tg_id):
        mode = await _retry_sheets(sheets.get_route_admin_mode, tg_id)
        return mode, True, True
    if tg_id in config.ADMIN_IDS:
        return "admin", True, False
    if await _retry_sheets(sheets.is_courier, tg_id):
        return "courier", False, False
    return "", False, False


# Каждая из sheets.get_route_for_date/reorder_route/add_route_point/
# remove_route_point/mark_route_delivered сама по себе атомарна (читает
# текущие строки листа "Маршрут", решает, что делать, и пишет) — но НИЧЕГО
# не мешало ДВУМ таким операциям выполняться одновременно (два запроса от
# одного и того же браузера, если сработали быстро один за другим, или два
# разных клиента). Пока каждая из них считает номера строк по СВОЕМУ
# собственному снимку листа, а не по актуальному — например, один запрос
# удаляет строку 14, из-за чего все нижесидящие строки сдвигаются на одну
# вверх, а параллельный запрос, уже вычисливший "строка 15" по старому
# снимку, записывает результат уже в другую, чужую точку. Именно так
# перетаскивание и удаление, отправленные быстро друг за другом, могли
# столкнуться и испортить порядок/строки листа — воспроизведено и
# подтверждено на реальных данных. Единственный по-настоящему надёжный
# способ исключить это — не давать таким операциям идти параллельно вообще:
# все точки входа, которые читают или пишут "Маршрут" на конкретную дату,
# берут этот лок и работают строго по очереди, а не одновременно.
_route_lock = asyncio.Lock()


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
        tg_id, tg_name = _extract_tg_user(request)
        if tg_id is None:
            return web.json_response({"error": "unauthorized"}, status=401)
        role, is_route_admin, is_dynamic_route_admin = await _role_for(tg_id)
        if not role:
            return web.json_response({"error": "forbidden"}, status=403)
        request["tg_id"] = tg_id
        request["tg_name"] = tg_name
        request["role"] = role
        request["is_route_admin"] = is_route_admin
        # Владелец бота (config.OWNER_TG_ID) — единственный, кто может
        # назначать/снимать курьеров-администраторов (см.
        # api_courier_route_admin_set) — отдельно от is_route_admin, у
        # которого таких людей может быть много.
        request["is_owner"] = tg_id == config.OWNER_TG_ID
        # Переключатель "Режим" (admin/courier) — владельцу и курьерам,
        # назначенным администраторами через "Курьеры" — НЕ основному
        # админу бота (ADMIN_IDS) просто по умолчанию.
        request["can_toggle_mode"] = request["is_owner"] or is_dynamic_route_admin
    return await handler(request)


async def _today() -> str:
    # Раньше звала sheets.get_active_menu_date() синхронно, в обход
    # _retry_sheets — единственное место в webapp.py, где обращение к
    # Google Sheets не было ни защищено от временных 429/5xx (сразу
    # падало в необработанное исключение -> "server_error"), ни
    # вынесено в отдельный поток (блокировало event loop всего процесса,
    # включая поллинг бота, на время запроса) — воспроизведено и
    # подтверждено. Используется как запасной "сегодня" в 20 местах
    # ниже (date_str = ... or await _today()), поэтому ломала ровно те запросы,
    # где дата не передана явно.
    return await _retry_sheets(sheets.get_active_menu_date)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

async def api_me(request: web.Request):
    return web.json_response({
        "role": request["role"],
        "tg_id": request["tg_id"],
        "route_split_view": config.ROUTE_SPLIT_VIEW,
        "is_route_admin": request["is_route_admin"],
        "can_toggle_mode": request["can_toggle_mode"],
        "is_owner": request["is_owner"],
    })


async def api_route_get(request: web.Request):
    date_str = request.query.get("date") or await _today()
    role = request["role"]
    depot = {"name": config.DEPOT_NAME, "address": config.DEPOT_ADDRESS, "lat": config.DEPOT_LAT, "lon": config.DEPOT_LNG}
    visible = await _retry_sheets(sheets.is_route_visible_to_courier, date_str)

    # Админ видит маршрут всегда, независимо от этого флага — сам флаг
    # существует именно для того, чтобы админ мог спокойно собрать/поправить
    # маршрут, пока курьер его не видит. Гейт — только для курьера.
    if role == "courier" and not visible:
        return web.json_response({"date": date_str, "role": role, "points": [], "depot": depot, "visible": False})

    async with _route_lock:
        route = await _retry_sheets(sheets.get_route_for_date, date_str)
    # "Старт" (время первого "Поехали" за день, см. api_route_start) —
    # по курьеру, не по точке, поэтому отдельным словарём, а не полем
    # точки; видно и курьеру (свой старт), и админу (старты всех, по
    # вкладкам курьеров), см. app.js: renderStartBadge.
    starts = await _retry_sheets(sheets.get_route_starts, date_str)
    # "Наличные" (сумма, собранная на точке за дату, см. api_cash_record) —
    # тем же способом, что и "starts" выше: отдельным словарём {точка:
    # сумма}, не полем точки, свежим на каждый запрос (не кешируется вместе
    # с route — см. sheets.get_route_cash_totals).
    cash = await _retry_sheets(sheets.get_route_cash_totals, date_str)
    if role == "courier":
        tg_id = str(request["tg_id"])
        route = [p for p in route if tg_id in p["courier_tg_ids"]]
    return web.json_response({
        "date": date_str, "role": role, "points": route, "depot": depot,
        "visible": visible, "starts": starts, "cash": cash,
    })


async def api_route_visibility_get(request: web.Request):
    # "Центр управления" остаётся доступен и когда владелец/назначенный
    # администратор переключился в режим "Курьер" (см. docstring
    # _role_for) — тот же is_route_admin, что и у соседнего api_logistics_get
    # в этом же хабе ("Профиль" → "Центр управления"). Было: request["role"]
    # != "admin" — тот самый режимный флаг, который для is_route_admin явно
    # может быть "courier", так что владелец/админ-курьер получал 403 и
    # включить видимость маршрута себе не мог — воспроизведено.
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    dates = await _retry_sheets(sheets.get_route_visibility_status)
    return web.json_response({"dates": dates})


async def api_route_visibility_set(request: web.Request):
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or await _today()
    visible = bool(body.get("visible"))

    was_visible = await _retry_sheets(sheets.is_route_visible_to_courier, date_str)
    await _retry_sheets(sheets.set_route_visibility, date_str, visible)

    notified = 0
    # Пуш шлём только на переходе "было выключено -> включили сейчас" — не
    # на каждое сохранение (иначе повторное открытие того же переключателя
    # или случайный повторный запрос заспамили бы курьера одним и тем же).
    if visible and not was_visible:
        bot = request.app.get("bot")
        if bot is not None:
            notified = await _notify_couriers_route_ready(bot, date_str)
        else:
            logger.warning("Bot недоступен в webapp.app — пуш о готовности маршрута не отправлен")
    return web.json_response({"ok": True, "notified": notified})


async def _notify_couriers_route_ready(bot, date_str: str) -> int:
    """Уведомляет каждого курьера, у которого на эту дату есть хотя бы одна
    назначенная точка, что маршрут готов — с кнопкой сразу в Mini App на
    эту дату (см. index_page/app.js — читает ?date= из адреса при
    открытии)."""
    route = await _retry_sheets(sheets.get_route_for_date, date_str)
    courier_ids = {cid for p in route for cid in p["courier_tg_ids"]}
    if not courier_ids or not config.WEBAPP_URL:
        return 0

    # "Уведомления" у курьера (см. "Курьеры" → карточка курьера,
    # sheets.set_courier_notify_off) — выключает ТОЛЬКО этот пуш, доступ
    # к самому Mini App не трогает (в отличие от COURIER_DISABLED).
    notify_off = {c["tg_id"] for c in await _retry_sheets(sheets.get_couriers) if c["notify_off"]}
    courier_ids = courier_ids - notify_off
    if not courier_ids:
        return 0

    url = f"{config.WEBAPP_URL}/miniapp?date={date_str}"
    text = texts.ROUTE_READY_PUSH.format(date=date_str)
    sent = 0
    for tg_id in courier_ids:
        try:
            await bot.send_message(int(tg_id), text, reply_markup=kb.route_ready_kb(url))
            sent += 1
        except Exception:
            logger.exception("Не удалось отправить пуш о готовности маршрута курьеру ID %s", tg_id)
    return sent


async def api_route_admin_mode_set(request: web.Request):
    """Переключает "Режим" (admin/courier) для владельца и для курьеров,
    назначенных администраторами через "Курьеры" (см. can_toggle_mode в
    auth_middleware) — определяет, что человек увидит в разделе "Заказы"
    при следующем заходе. Основному админу бота (ADMIN_IDS) запрещено —
    у него can_toggle_mode всегда False."""
    if not request["can_toggle_mode"]:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    mode = (body.get("mode") or "").strip()
    if mode not in (config.ROUTE_ADMIN_MODE_ADMIN, config.ROUTE_ADMIN_MODE_COURIER):
        return web.json_response({"error": "bad_mode"}, status=400)
    await _retry_sheets(sheets.set_route_admin_mode, request["tg_id"], request["tg_name"], mode)
    return web.json_response({"ok": True, "mode": mode})


async def api_logistics_get(request: web.Request):
    """Расходы на логистику за один день — список действующих курьеров с
    уже сохранённой (если есть) суммой оплаты за смену + сумма, потраченная
    в этот день на доставку через сторонние сервисы (см. "Профиль" →
    "Расходы на логистику")."""
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    date_str = request.query.get("date") or await _today()
    couriers = await _retry_sheets(sheets.get_couriers)
    shift_pay = await _retry_sheets(sheets.get_logistics_expenses, date_str)
    delivery_expense = await _retry_sheets(sheets.get_delivery_expense, date_str)
    return web.json_response({
        "date": date_str,
        "couriers": [
            {"tg_id": c["tg_id"], "name": c["name"], "shift_pay": shift_pay.get(c["tg_id"], 0)}
            for c in couriers
        ],
        "delivery_expense": delivery_expense,
    })


async def api_logistics_set(request: web.Request):
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or await _today()
    shifts = body.get("shifts") or []
    for item in shifts:
        tg_id = str(item.get("tg_id") or "").strip()
        if not tg_id:
            continue
        try:
            amount = int(item.get("amount") or 0)
        except (TypeError, ValueError):
            amount = 0
        await _retry_sheets(sheets.set_logistics_expense, date_str, tg_id, item.get("name") or "", amount)
    try:
        delivery_expense = int(body.get("delivery_expense") or 0)
    except (TypeError, ValueError):
        delivery_expense = 0
    await _retry_sheets(sheets.set_delivery_expense, date_str, delivery_expense)
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# Курьеры — справочник (только isRouteAdmin, экран "Профиль" → "Центр
# управления" → "Курьеры"). Раньше строки сюда админ вписывал вручную прямо
# в Google Таблицу — теперь через форму в Mini App (см. sheets.add_courier).
# Отдельно от /api/couriers выше (та читает тот же sheets.get_couriers, но
# доступна только при role=="admin" — используется картой для назначения
# курьера на точку; этот же набор эндпоинтов должен остаться доступным и
# когда владелец/назначенный администратор переключился в режим "Курьер",
# как и весь остальной "Центр управления").
# ---------------------------------------------------------------------------

def _courier_tg_id_int(tg_id):
    try:
        return int(tg_id)
    except (TypeError, ValueError):
        return None


async def api_couriers_manage_list(request: web.Request):
    """Список курьеров для экрана "Курьеры" — с двумя добавленными
    полями, которых нет в sheets.get_couriers() (сырой флаг столбца
    "Курьеры"): "is_owner" (config.OWNER_TG_ID) и "effective_admin" (его
    же показывает бейдж "Админ"/"Курьер" в списке, см. app.js — владелец
    ИЛИ is_route_admin ИЗ ТАБЛИЦЫ, назначенный владельцем). Список
    отсортирован: владелец → администраторы → обычные курьеры, внутри
    группы — по имени, по прямой просьбе ("Главный админ (меня) до
    Админов, а потом курьеры")."""
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    couriers = await _retry_sheets(sheets.get_couriers)
    enriched = []
    for c in couriers:
        tg_id_int = _courier_tg_id_int(c["tg_id"])
        is_owner = tg_id_int is not None and tg_id_int == config.OWNER_TG_ID
        effective_admin = is_owner or c["is_route_admin"]
        enriched.append(dict(c, is_owner=is_owner, effective_admin=effective_admin))
    enriched.sort(key=lambda c: (
        0 if c["is_owner"] else 1 if c["effective_admin"] else 2,
        (c["name"] or c["tg_id"]).lower(),
    ))
    return web.json_response({"couriers": enriched})


async def api_couriers_manage_add(request: web.Request):
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    tg_id = str(body.get("tg_id") or "").strip()
    name = (body.get("name") or "").strip()
    phone = (body.get("phone") or "").strip()
    if not tg_id or not tg_id.lstrip("-").isdigit():
        return web.json_response({"error": "bad_tg_id"}, status=400)
    if not name:
        return web.json_response({"error": "name_required"}, status=400)
    await _retry_sheets(sheets.add_courier, tg_id, name, phone)
    return web.json_response({"ok": True})


async def api_courier_kpi_hidden_set(request: web.Request):
    """"Показать"/"Скрыть с главного экрана" у конкретного курьера (см.
    карточку курьера в "Курьеры") — скрытый курьер пропадает из мелких
    кружков под главным показателем, но продолжает учитываться в общем
    среднем (см. sheets.get_route_kpi)."""
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    tg_id = request.match_info.get("tg_id", "")
    body = await request.json()
    ok = await _retry_sheets(sheets.set_courier_kpi_hidden, tg_id, bool(body.get("hidden")))
    if not ok:
        return web.json_response({"error": "not_found"}, status=404)
    return web.json_response({"ok": True})


async def api_courier_route_admin_set(request: web.Request):
    """Назначает/снимает курьера администратором "Маршрута" (карточка
    курьера в "Курьеры" → "Администратор Маршрута") — доступно ТОЛЬКО
    владельцу бота (config.OWNER_TG_ID), по прямой просьбе: даже у других
    действующих администраторов "Маршрута" этого права нет."""
    if not request["is_owner"]:
        return web.json_response({"error": "forbidden"}, status=403)
    tg_id = request.match_info.get("tg_id", "")
    body = await request.json()
    ok = await _retry_sheets(sheets.set_courier_route_admin, tg_id, bool(body.get("is_admin")))
    if not ok:
        return web.json_response({"error": "not_found"}, status=404)
    return web.json_response({"ok": True})


async def api_courier_disabled_set(request: web.Request):
    """Включает/выключает доступ курьера к Mini App "Маршрут" целиком
    (карточка курьера в "Курьеры" → "Доступ к Mini App Маршрут") —
    доступно ЛЮБОМУ администратору "Маршрута" (is_route_admin), не
    только владельцу, по прямой просьбе."""
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    tg_id = request.match_info.get("tg_id", "")
    body = await request.json()
    ok = await _retry_sheets(sheets.set_courier_disabled, tg_id, bool(body.get("disabled")))
    if not ok:
        return web.json_response({"error": "not_found"}, status=404)
    return web.json_response({"ok": True})


async def api_courier_notify_off_set(request: web.Request):
    """Включает/выключает ЛИЧНЫЙ пуш о готовности маршрута у конкретного
    курьера (карточка курьера в "Курьеры" → "Уведомления") — тот самый,
    что уходит при включении видимости маршрута (см.
    _notify_couriers_route_ready). Доступ к Mini App не трогает — для
    этого отдельный переключатель "Доступ" (api_courier_disabled_set).
    Доступно ЛЮБОМУ администратору "Маршрута"."""
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    tg_id = request.match_info.get("tg_id", "")
    body = await request.json()
    ok = await _retry_sheets(sheets.set_courier_notify_off, tg_id, bool(body.get("off")))
    if not ok:
        return web.json_response({"error": "not_found"}, status=404)
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# Касса курьера — "Наличные у курьера"/"Доход курьера"/"Общая сумма у
# курьера" (по дням — см. sheets.get_courier_cash_for_day/
# get_courier_cash_balance_as_of), "Забрать наличные" (по выбранным
# дням) и "Заработок"/"Оплата за смену" (с выбором источника — из уже
# собранных наличных или отдельно). Экран "Мои доходы" (курьер, свои
# данные без контактов клиентов) и карточка курьера в "Курьеры" (админ,
# видит и контакты из get_cash_entries, и может отмечать забор наличных
# и вводить "Заработок") — см. app.js: renderCourierDetail/renderCashCard.
# ---------------------------------------------------------------------------

def _courier_scope_ok(request, tg_id: str) -> bool:
    """И admin (любой курьер), и сам курьер — только свои данные."""
    return request["is_route_admin"] or tg_id == str(request["tg_id"])


async def api_courier_cash_summary(request: web.Request):
    """"Наличные у курьера" (за ОДИН день), "Доход курьера" (за тот же
    день) и "Общая сумма у курьера" (накопительно по состоянию на этот
    день) — три прямоугольника карточки курьера/"Мои доходы" (см.
    sheets.get_courier_cash_for_day/get_logistics_total_for_courier/
    get_courier_cash_balance_as_of)."""
    tg_id = request.query.get("courier_tg_id") or str(request["tg_id"])
    if not _courier_scope_ok(request, tg_id):
        return web.json_response({"error": "forbidden"}, status=403)
    date_str = request.query.get("date") or await _today()
    cash_day = await _retry_sheets(sheets.get_courier_cash_for_day, tg_id, date_str)
    earned_day = await _retry_sheets(sheets.get_logistics_total_for_courier, tg_id, date_str, date_str)
    balance_as_of = await _retry_sheets(sheets.get_courier_cash_balance_as_of, tg_id, date_str)
    return web.json_response({
        "date": date_str, "cash_day": cash_day, "earned_day": earned_day, "balance_as_of": balance_as_of,
    })


async def api_courier_cash_by_day(request: web.Request):
    """История "Наличные у курьера"/"Общая сумма у курьера" по дням (без
    контактов клиентов — их видит только админ, см.
    api_courier_cash_day_entries) — для раскрытия списка по нажатию на
    любой из этих двух прямоугольников."""
    tg_id = request.query.get("courier_tg_id") or str(request["tg_id"])
    if not _courier_scope_ok(request, tg_id):
        return web.json_response({"error": "forbidden"}, status=403)
    days = await _retry_sheets(sheets.get_courier_cash_by_day, tg_id)
    return web.json_response({"days": days})


async def api_courier_cash_day_entries(request: web.Request):
    """Кто из клиентов, сколько и с какой точки дал наличные В ОДИН
    конкретный день — ТОЛЬКО для админа (контакты клиента: ID, имя,
    телефон, tg), по прямой просьбе."""
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    tg_id = request.query.get("courier_tg_id") or ""
    date_str = request.query.get("date") or await _today()
    entries = await _retry_sheets(sheets.get_cash_entries, tg_id, date_str, date_str)
    return web.json_response({"entries": entries})


async def api_courier_earnings_by_day(request: web.Request):
    """История "Доход курьера" по дням — для раскрытия списка по нажатию
    на прямоугольник "Доход курьера"."""
    tg_id = request.query.get("courier_tg_id") or str(request["tg_id"])
    if not _courier_scope_ok(request, tg_id):
        return web.json_response({"error": "forbidden"}, status=403)
    days = await _retry_sheets(sheets.get_courier_earnings_by_day, tg_id)
    return web.json_response({"days": days})


async def api_courier_withdraw_cash(request: web.Request):
    """"Забрать наличные" — админ отмечает дни (чекбоксы, см. app.js),
    по каждому списывается его текущий остаток или часть (см.
    sheets.withdraw_courier_cash)."""
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    tg_id = request.match_info.get("tg_id", "")
    body = await request.json()
    days = body.get("days") or {}
    if not isinstance(days, dict) or not days:
        return web.json_response({"error": "bad_request"}, status=400)
    couriers = await _retry_sheets(sheets.get_couriers)
    courier = next((c for c in couriers if c["tg_id"] == tg_id), None)
    if not courier:
        return web.json_response({"error": "not_found"}, status=404)
    total = await _retry_sheets(sheets.withdraw_courier_cash, tg_id, courier["name"], days)
    return web.json_response({"ok": True, "total": total})


async def api_courier_pay_shift(request: web.Request):
    """"Заработок"/"Оплата за смену" — с выбором источника: "из уже
    собранных курьером наличных" (from_cash=True, списывает ту же сумму
    с остатка наличных ЗА ЭТОТ ЖЕ ДЕНЬ, отклоняется, если наличных не
    хватает) или "отдельно" (from_cash=False, остаток не трогает) — см.
    sheets.pay_courier_shift."""
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    tg_id = request.match_info.get("tg_id", "")
    body = await request.json()
    date_str = body.get("date") or await _today()
    try:
        amount = int(body.get("amount") or 0)
    except (TypeError, ValueError):
        amount = 0
    if amount <= 0:
        return web.json_response({"error": "bad_amount"}, status=400)
    from_cash = bool(body.get("from_cash"))
    couriers = await _retry_sheets(sheets.get_couriers)
    courier = next((c for c in couriers if c["tg_id"] == tg_id), None)
    if not courier:
        return web.json_response({"error": "not_found"}, status=404)
    result = await _retry_sheets(sheets.pay_courier_shift, tg_id, courier["name"], date_str, amount, from_cash)
    if "error" in result:
        return web.json_response(result, status=400)
    return web.json_response(result)


# ---------------------------------------------------------------------------
# KPI доставки (только isRouteAdmin) — экран "Профиль" → "Центр управления"
# → шкала эффективности под ней, и настройка "Время сдачи заказов".
# ---------------------------------------------------------------------------

async def api_route_kpi_get(request: web.Request):
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    date_from = request.query.get("from") or await _today()
    date_to = request.query.get("to") or date_from
    data = await _retry_sheets(sheets.get_route_kpi, date_from, date_to, retries=2)
    return web.json_response(data)


async def api_route_deadline_get(request: web.Request):
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    deadline = await _retry_sheets(sheets.get_delivery_deadline)
    return web.json_response({"deadline": deadline})


async def api_route_deadline_set(request: web.Request):
    if not request["is_route_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    ok = await _retry_sheets(sheets.set_delivery_deadline, body.get("deadline") or "")
    if not ok:
        return web.json_response({"error": "bad_time"}, status=400)
    return web.json_response({"ok": True})


async def api_avatar_image(request: web.Request):
    """Аватар курьера из Telegram (его фото профиля) — для карточки
    курьера в "Курьеры". Та же механика, что и в PAUSE App (см.
    pauseapp.py: api_avatar_image) — bot.get_user_profile_photos +
    bot.download, чтобы не светить BOT_TOKEN во фронтенде прямой ссылкой
    на api.telegram.org/file/bot<TOKEN>/..."""
    if not request["is_route_admin"]:
        return web.Response(status=403)
    tg_id = request.match_info.get("tg_id", "")
    bot = request.app.get("bot")
    if not bot or not tg_id:
        return web.Response(status=404)
    try:
        tg_id_int = int(tg_id)
    except ValueError:
        return web.Response(status=404)
    try:
        photos = await bot.get_user_profile_photos(tg_id_int, limit=1)
    except Exception:
        logger.exception("Маршрут: не удалось получить аватар курьера (tg_id=%s)", tg_id)
        return web.Response(status=502)
    if not photos or not photos.photos:
        return web.Response(status=404)
    file_id = photos.photos[0][-1].file_id
    try:
        buf = await bot.download(file_id)
    except Exception:
        logger.exception("Маршрут: не удалось скачать аватар курьера (tg_id=%s)", tg_id)
        return web.Response(status=502)
    if buf is None:
        return web.Response(status=404)
    return web.Response(
        body=buf.read(), content_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=3600"},
    )


async def api_route_dates(request: web.Request):
    # Не трогает лист "Маршрут" (только "Справочники" через
    # get_active_menu_date) — блокировка _route_lock тут не нужна.
    dates = await _retry_sheets(sheets.get_route_available_dates)
    return web.json_response({"dates": dates, "active": await _today()})


async def api_delivery_points(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    return web.json_response({"points": await _retry_sheets(sheets.get_delivery_points)})


async def api_couriers(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    return web.json_response({"couriers": await _retry_sheets(sheets.get_couriers)})


async def api_route_assign(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or await _today()
    point = (body.get("point") or "").strip()
    # Полный итоговый набор ID (не добавление/удаление одного) — точку
    # можно закрепить сразу за несколькими курьерами (см. set_route_courier).
    courier_tg_ids = [str(x).strip() for x in (body.get("courier_tg_ids") or []) if str(x).strip()]
    if not point:
        return web.json_response({"error": "point required"}, status=400)
    async with _route_lock:
        await _retry_sheets(sheets.set_route_courier, date_str, point, courier_tg_ids)
    return web.json_response({"ok": True})


async def api_route_reorder(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or await _today()
    order_map = body.get("order") or {}
    # Это осознанное действие админа (перетащил карточку) — потерять его
    # обиднее, чем лишний повторный показ маршрута, поэтому здесь два повтора
    # вместо одного.
    async with _route_lock:
        await _retry_sheets(sheets.reorder_route, date_str, order_map, retries=2)
    return web.json_response({"ok": True})


async def api_route_pin(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or await _today()
    point = (body.get("point") or "").strip()
    pinned = bool(body.get("pinned"))
    if not point:
        return web.json_response({"error": "point required"}, status=400)
    async with _route_lock:
        await _retry_sheets(sheets.set_route_pinned, date_str, point, pinned)
    return web.json_response({"ok": True})


async def api_route_add(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or await _today()
    point = (body.get("point") or "").strip()
    if not point:
        return web.json_response({"error": "point required"}, status=400)
    async with _route_lock:
        await _retry_sheets(sheets.add_route_point, date_str, point)
    return web.json_response({"ok": True})


async def api_route_remove(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or await _today()
    point = (body.get("point") or "").strip()
    async with _route_lock:
        await _retry_sheets(sheets.remove_route_point, date_str, point)
    return web.json_response({"ok": True})


async def api_route_comment(request: web.Request):
    if request["role"] != "admin":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or await _today()
    point = (body.get("point") or "").strip()
    comment = (body.get("comment") or "").strip()
    if not point:
        return web.json_response({"error": "point required"}, status=400)
    async with _route_lock:
        await _retry_sheets(sheets.set_route_courier_comment, date_str, point, comment)
    return web.json_response({"ok": True})


async def api_route_complete(request: web.Request):
    body = await request.json()
    date_str = body.get("date") or await _today()
    point = (body.get("point") or "").strip()
    if not point:
        return web.json_response({"error": "point required"}, status=400)
    async with _route_lock:
        if request["role"] == "courier":
            # курьер может отмечать сданными только свои собственные точки
            route = await _retry_sheets(sheets.get_route_for_date, date_str)
            tg_id = str(request["tg_id"])
            mine = {p["point"] for p in route if tg_id in p["courier_tg_ids"]}
            if point not in mine:
                return web.json_response({"error": "forbidden"}, status=403)
        await _retry_sheets(sheets.mark_route_delivered, date_str, point, retries=2)
    return web.json_response({"ok": True})


async def api_route_start(request: web.Request):
    """"Поехали" — время первого за день нажатия (см. sheets.record_route_start).
    Только курьер: это его личная метка старта, у админа кнопки "Поехали"
    в интерфейсе нет вовсе (см. app.js: buildCard)."""
    if request["role"] != "courier":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or await _today()
    await _retry_sheets(sheets.record_route_start, date_str, request["tg_id"])
    return web.json_response({"ok": True})


async def api_cash_record(request: web.Request):
    """Курьер отмечает "Наличные" у конкретного человека на точке (кнопка
    рядом с "Поехали"/"Сдано" — выбор человека из people точки, см.
    app.js: openCashModal). Только курьер и только по своей точке на эту
    дату — та же проверка "mine", что и у api_route_complete."""
    if request["role"] != "courier":
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = body.get("date") or await _today()
    point = (body.get("point") or "").strip()
    client_id = str(body.get("client_id") or "").strip()
    try:
        amount = int(body.get("amount") or 0)
    except (TypeError, ValueError):
        amount = 0
    if not point or not client_id or amount <= 0:
        return web.json_response({"error": "bad_request"}, status=400)
    async with _route_lock:
        route = await _retry_sheets(sheets.get_route_for_date, date_str)
        tg_id = str(request["tg_id"])
        point_data = next((p for p in route if p["point"] == point), None)
        if not point_data or tg_id not in point_data["courier_tg_ids"]:
            return web.json_response({"error": "forbidden"}, status=403)
        person = next((p for p in point_data["people"] if p["client_id"] == client_id), None)
        if not person:
            return web.json_response({"error": "person_not_found"}, status=404)
        await _retry_sheets(
            sheets.record_cash_collection, date_str, tg_id, request["tg_name"], point,
            client_id, person["name"], person["contact"], person.get("telegram", ""), amount,
            retries=2,
        )
    return web.json_response({"ok": True})


async def api_earnings(request: web.Request):
    if request["role"] != "courier":
        return web.json_response({"error": "forbidden"}, status=403)
    date_str = request.query.get("date") or await _today()
    async with _route_lock:
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
    async with _route_lock:
        total = await _retry_sheets(sheets.get_courier_earnings_month, request["tg_id"], year, month)
    return web.json_response({"year": year, "month": month, "total": total})


def _static_version() -> str:
    """Короткая "версия" статики — по времени последнего изменения
    app.js/styles.css. Подставляется в index.html как ?v=... у ссылок на
    эти файлы (см. index_page) исключительно для того, чтобы WebView
    Telegram, который иногда держит старый app.js в кэше даже после
    редеплоя (воспроизведено на практике: человек заходит в Mini App
    "Маршрут" сразу после обновления кода и видит старый интерфейс, пока
    не закроет и не откроет Telegram заново), сам увидел новый URL файла
    и скачал его, а не отдавал кэш из прошлого раза."""
    try:
        ts = max(
            os.path.getmtime(os.path.join(STATIC_DIR, "app.js")),
            os.path.getmtime(os.path.join(STATIC_DIR, "styles.css")),
        )
        return str(int(ts))
    except OSError:
        return "0"


async def index_page(request: web.Request):
    path = os.path.join(STATIC_DIR, "index.html")
    with open(path, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("__STATIC_VERSION__", _static_version())
    return web.Response(text=html, content_type="text/html")


def create_app(bot=None) -> web.Application:
    app = web.Application(middlewares=[error_middleware, auth_middleware])
    # Нужен, чтобы слать пуш курьеру при включении видимости маршрута (см.
    # _notify_couriers_route_ready) — тот же самый Bot, на котором работает
    # polling (см. docstring выше про общий event loop), просто доступный
    # ещё и обработчикам aiohttp через request.app.
    app["bot"] = bot
    app.router.add_get("/miniapp", index_page)
    app.router.add_get("/miniapp/", index_page)
    app.router.add_static("/miniapp/static/", STATIC_DIR, show_index=False)
    app.router.add_get("/api/me", api_me)
    app.router.add_get("/api/route", api_route_get)
    app.router.add_get("/api/route/dates", api_route_dates)
    app.router.add_get("/api/route/visibility", api_route_visibility_get)
    app.router.add_post("/api/route/visibility", api_route_visibility_set)
    app.router.add_post("/api/route_admin/mode", api_route_admin_mode_set)
    app.router.add_get("/api/logistics", api_logistics_get)
    app.router.add_post("/api/logistics", api_logistics_set)
    app.router.add_get("/api/delivery_points", api_delivery_points)
    app.router.add_get("/api/couriers", api_couriers)
    app.router.add_get("/api/couriers/manage", api_couriers_manage_list)
    app.router.add_post("/api/couriers/manage", api_couriers_manage_add)
    app.router.add_post("/api/couriers/manage/{tg_id}/kpi-hidden", api_courier_kpi_hidden_set)
    app.router.add_post("/api/couriers/manage/{tg_id}/route-admin", api_courier_route_admin_set)
    app.router.add_post("/api/couriers/manage/{tg_id}/disabled", api_courier_disabled_set)
    app.router.add_post("/api/couriers/manage/{tg_id}/notify-off", api_courier_notify_off_set)
    app.router.add_post("/api/couriers/manage/{tg_id}/withdraw-cash", api_courier_withdraw_cash)
    app.router.add_post("/api/couriers/manage/{tg_id}/pay-shift", api_courier_pay_shift)
    app.router.add_get("/api/courier/cash-summary", api_courier_cash_summary)
    app.router.add_get("/api/courier/cash-by-day", api_courier_cash_by_day)
    app.router.add_get("/api/courier/cash-day-entries", api_courier_cash_day_entries)
    app.router.add_get("/api/courier/earnings-by-day", api_courier_earnings_by_day)
    app.router.add_post("/api/cash", api_cash_record)
    app.router.add_get("/api/avatar/{tg_id}", api_avatar_image)
    app.router.add_post("/api/route/reorder", api_route_reorder)
    app.router.add_post("/api/route/pin", api_route_pin)
    app.router.add_post("/api/route/add", api_route_add)
    app.router.add_post("/api/route/remove", api_route_remove)
    app.router.add_post("/api/route/comment", api_route_comment)
    app.router.add_post("/api/route/assign", api_route_assign)
    app.router.add_post("/api/route/complete", api_route_complete)
    app.router.add_post("/api/route/start", api_route_start)
    app.router.add_get("/api/route/kpi", api_route_kpi_get)
    app.router.add_get("/api/route/deadline", api_route_deadline_get)
    app.router.add_post("/api/route/deadline", api_route_deadline_set)
    app.router.add_get("/api/earnings", api_earnings)
    app.router.add_get("/api/earnings/month", api_earnings_month)
    return app


async def run_webapp(bot=None, extra_subapps: dict = None):
    """Запускает веб-сервер на config.WEBAPP_PORT — вызывать вместе с
    dp.start_polling(bot) через asyncio.gather, не вместо него. bot нужен
    для отправки пуш-уведомлений курьеру (см. create_app).

    extra_subapps — {"/путь/": aiohttp.web.Application, ...}: другие Mini
    App (например pauseapp.py) примонтированные рядом, БЕЗ единой правки
    в create_app()/маршрутах курьерского приложения выше — Railway отдаёт
    только один публичный порт, поэтому несколько aiohttp-приложений в
    одном процессе делятся именно так, через add_subapp. Параметр
    необязателен и по умолчанию ничего не меняет в поведении этой функции."""
    app = create_app(bot)
    for prefix, subapp in (extra_subapps or {}).items():
        app.add_subapp(prefix, subapp)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", config.WEBAPP_PORT)
    await site.start()
    logger.info("Mini App веб-сервер запущен на порту %s", config.WEBAPP_PORT)

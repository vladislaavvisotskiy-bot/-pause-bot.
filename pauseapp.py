# -*- coding: utf-8 -*-
"""
Telegram Mini App "PAUSE App" — новый клиентский интерфейс, ОТДЕЛЬНЫЙ от
Mini App "Маршрут" (webapp.py, не тронут ни строкой). Пока доступен только
админам (config.ADMIN_IDS) плюс отдельным tg_id из config.
PAUSEAPP_TEST_CLIENT_IDS — временный список для тестирования клиентской
стороны приложения до публичного запуска (см. admin_auth_middleware ниже).
Обычные клиенты продолжают заказывать через чат-бота как раньше; вся
админская часть (отчёты, рассылки, публикация меню и т.п.) остаётся
только в самом боте, сюда не переносится.

Работает в том же aiohttp-процессе, что и webapp.py — Railway отдаёт всего
один публичный порт, поэтому монтируется как отдельный aiohttp-subapp (см.
webapp.run_webapp(extra_subapps=...), bot.py) вместо создания второго
сервера. Ничего в маршрутах/поведении Mini App курьера при этом не меняется.

ЛОГИКА ЗАКАЗА/ПРОФИЛЯ/КЛУБА НЕ ДУБЛИРУЕТСЯ — эти эндпоинты вызывают ровно
те же функции sheets.py (и переиспользуют keyboards.py/admin_notify.py для
уведомлений админам), что и handlers/order.py, handlers/profile.py,
handlers/club.py в самом боте. Где сравнить с оригиналом, отмечено в
комментариях у каждой функции.
"""
import asyncio
import datetime as dt
import json
import logging
import os
import random
import time
import urllib.parse
import uuid

import aiohttp
from aiohttp import web
from aiogram.types import BufferedInputFile

import config
import geo
import sheets
import texts
import keyboards as kb
from admin_notify import notify_admins, notify_admins_photo
from care_phrases import CARE_PHRASES
from handlers.profile import _card_pending_status
from webapp import _extract_tg_id, _retry_sheets

logger = logging.getLogger("pause_bot")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "pauseapp_static")

MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024

# ВРЕМЕННО, по прямой просьбе пользователя: пока PAUSE App тестирует
# только он сам (реальных клиентов там ещё нет), приём заказов в самом
# приложении не закрывается по времени отсечки вообще — можно постоянно
# тестировать, не упираясь в "приём закрыт". Бота (чат) это НЕ касается —
# там config.ORDER_CUTOFF_TIME по-прежнему действует как обычно, затронуты
# только api_menu/api_order_submit ниже. Когда понадобится вернуть
# отсечку в PAUSE App — поставьте False.
PAUSEAPP_IGNORE_CUTOFF = True


@web.middleware
async def error_middleware(request: web.Request, handler):
    """Тот же приём, что и в webapp.py: последняя линия обороны — аккуратный
    JSON вместо голого 500, если Sheets/Telegram на секунду ответят ошибкой."""
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except Exception:
        logger.exception("Необработанная ошибка PAUSE App на %s %s", request.method, request.path)
        return web.json_response({"error": "server_error"}, status=503)


@web.middleware
async def admin_auth_middleware(request: web.Request, handler):
    """Доступ — ТОЛЬКО админам, проверяется на КАЖДОМ запросе к /api/* по
    подписи initData (см. webapp._verify_init_data — та же HMAC-проверка,
    что и у Mini App курьера, тот же секрет BOT_TOKEN), а не только тем,
    что кнопка входа скрыта в интерфейсе бота.

    Два уровня: главный админ (config.ADMIN_IDS) — доступ ко всему всегда;
    делегированный админ (лист "Админы PAUSE App", см. "Операционный
    центр" → "Администраторы") — базовый доступ к приложению плюс только
    те функции Операционного центра, что ему явно выданы (request["pa_finance"]/
    ["pa_debtors"]/["pa_menu"], см. проверки в соответствующих api_ops_*
    ниже). request["is_main_admin"] решает доступ к самому экрану
    "Администраторы" (api_pause_admins_*) — делегированному админу он
    никогда не показывается, не выдаётся как "функция" и не может быть
    включён отсюда.

    Третий, ВРЕМЕННЫЙ случай — config.PAUSEAPP_TEST_CLIENT_IDS (см. там
    же): пускает внутрь как обычного клиента, без единой админской
    привилегии, чтобы протестировать само приложение со стороны клиента
    до публичного запуска."""
    if "/api/" in request.path:
        tg_id = _extract_tg_id(request)
        if tg_id is None:
            return web.json_response({"error": "unauthorized"}, status=401)
        if tg_id in config.ADMIN_IDS:
            request["tg_id"] = tg_id
            request["is_main_admin"] = True
            request["pa_finance"] = True
            request["pa_debtors"] = True
            request["pa_menu"] = True
        elif tg_id in config.PAUSEAPP_TEST_CLIENT_IDS:
            request["tg_id"] = tg_id
            request["is_main_admin"] = False
            request["pa_finance"] = False
            request["pa_debtors"] = False
            request["pa_menu"] = False
        else:
            pa = await _retry_sheets(sheets.get_pause_admin, tg_id)
            if pa:
                request["tg_id"] = tg_id
                request["is_main_admin"] = False
                request["pa_finance"] = pa["finance"]
                request["pa_debtors"] = pa["debtors"]
                request["pa_menu"] = pa["menu"]
            else:
                # Обычный клиент: любой, кто прошёл регистрацию в боте
                # (есть в Sheet1) — без единой админской привилегии.
                client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
                if not client:
                    return web.json_response({"error": "forbidden"}, status=403)
                request["tg_id"] = tg_id
                request["is_main_admin"] = False
                request["pa_finance"] = False
                request["pa_debtors"] = False
                request["pa_menu"] = False
    return await handler(request)


# ---------------------------------------------------------------------------
# Служебное
# ---------------------------------------------------------------------------

def _static_version() -> str:
    """Версия для cache-busting query-параметра у styles.css/app.js —
    время изменения обоих файлов разом. Без этого Telegram WebView может
    годами отдавать закэшированную СТАРУЮ версию файла по тому же URL
    (сам файл на сервере уже новый, но клиент об этом не узнаёт без
    смены URL) — ровно так объяснялось, почему после правки палитры
    цвета у пользователя визуально не менялись."""
    try:
        css_m = os.path.getmtime(os.path.join(STATIC_DIR, "styles.css"))
        js_m = os.path.getmtime(os.path.join(STATIC_DIR, "app.js"))
        return str(int(max(css_m, js_m)))
    except OSError:
        return "0"


async def index_page(request: web.Request):
    with open(os.path.join(STATIC_DIR, "index.html"), "r", encoding="utf-8") as f:
        html = f.read()
    v = _static_version()
    html = html.replace('href="/pauseapp/static/styles.css"', f'href="/pauseapp/static/styles.css?v={v}"')
    html = html.replace('src="/pauseapp/static/app.js"', f'src="/pauseapp/static/app.js?v={v}"')
    return web.Response(text=html, content_type="text/html")


async def api_me(request: web.Request):
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    return web.json_response({
        "tg_id": tg_id,
        "registered": bool(client),
        "name": (client or {}).get("name", ""),
        "is_main_admin": request["is_main_admin"],
        "pa_finance": request["pa_finance"],
        "pa_debtors": request["pa_debtors"],
        "pa_menu": request["pa_menu"],
    })


# ---------------------------------------------------------------------------
# Меню и заказ — переиспользует ровно то, что handlers/order.py вызывает
# для того же самого шага в чат-боте (см. комментарии у каждого поля).
# ---------------------------------------------------------------------------

def _resolve_photo_url(raw: str) -> str:
    """Столбец "Фото-ссылка" в Справочниках содержит либо готовую
    публичную ссылку (вписана вручную прямо в таблицу), либо — если фото
    прислали боту через /admin → "🖼 Фото блюд" — голый Telegram file_id
    (см. sheets.set_set_photo). Второе нужно обернуть в прокси-путь;
    первое отдаём как есть. api_feed_image ниже уже умеет отдавать ЛЮБОЙ
    file_id (ничего специфичного для ленты CLUB в нём нет), переиспользуем
    его же, вместо отдельного эндпоинта под фото блюд."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    return "/pauseapp/api/feed/image/" + raw


def _split_description(raw: str) -> list:
    """Сырой текст из столбца "Описание" (см. sheets.set_set_description)
    в список буллетов на карточку — каждая непустая строка становится
    отдельным пунктом (см. pauseapp_static/app.js: buildMenuSetCard)."""
    return [line.strip() for line in (raw or "").splitlines() if line.strip()]


def _serialize_sets(sets_today: list, prices: dict, sets_with_garnish: set, extra: dict = None, garnish_map: dict = None) -> list:
    """Тот же порядок веток, что и в keyboards.set_kb/handlers/order.py:
    _proceed_after_set_choice — группа переменной цены (config.SET_VARIANTS)
    одной карточкой с вариантами, обычный сет — карточкой с ценой и (если
    есть) списком гарниров РОВНО этого сета на сегодня.

    Чистая функция — никаких обращений к Sheets внутри (garnish_map уже
    готов целиком, см. sheets.get_today_garnishes_for_all_sets). Раньше
    гарнир на каждый сет с Гарнир=Да дочитывался здесь ОТДЕЛЬНЫМ вызовом
    sheets.get_today_garnishes_for_set ПРЯМО В ЦИКЛЕ, синхронно, в обход
    _retry_sheets — на каталоге из нескольких таких сетов это было
    несколько лишних, ничем не защищённых обращений к Sheets на КАЖДОЕ
    открытие "Меню" любым клиентом, и именно они (а не сами чтения) были
    прямой причиной server_error под нагрузкой — воспроизведено и
    подтверждено.

    extra — sheets.get_set_extra(): категория/фото/описание на карточку
    (см. экран Меню в PAUSE App). Все поля необязательны — пустая строка,
    если админ их ещё не заполнил, фронт тогда просто не рисует
    соответствующий блок карточки (фото/буллеты) и не добавляет её ни в
    один чип категории, кроме "Все"."""
    extra = extra or {}
    garnish_map = garnish_map or {}
    items = []
    seen_groups = set()
    for name in sets_today:
        clean = name.strip()
        group = config.SET_VARIANT_GROUP.get(clean)
        if group:
            if group in seen_groups:
                continue
            seen_groups.add(group)
            variants = []
            for technical, label in config.SET_VARIANTS[group]:
                # Гарнир проверяем на КАЖДЫЙ технический вариант отдельно,
                # не только на группу — сейчас у "Самса"/"Самса без компота"
                # его нет (см. config.SET_VARIANTS), но это данные из
                # таблицы, а не жёстко зашитое предположение: если завтра
                # появится сет с переменной ценой И гарниром, это отработает
                # само, без правки кода.
                v_has_garnish = technical.strip().lower() in sets_with_garnish
                v_garnish_options = []
                if v_has_garnish:
                    v_raw = garnish_map.get(technical.strip().lower(), [])
                    v_garnish_options = [{"value": g, "display": texts.display_garnish(g)} for g in v_raw]
                variants.append({
                    "technical": technical, "label": label, "price": prices.get(technical, 0),
                    "has_garnish": bool(v_garnish_options), "garnish_options": v_garnish_options,
                })
            # Категория/фото группы берём с ПЕРВОГО технического варианта —
            # клиент видит группу одной карточкой, второй набор полей ей не нужен.
            first_extra = extra.get(config.SET_VARIANTS[group][0][0], {})
            items.append({
                "key": f"__variant__:{group}",
                "is_variant_group": True,
                "display_name": sheets.display_set_name(group),
                "variants": variants,
                "price": None,
                "has_garnish": False,
                "garnish_options": [],
                "category": first_extra.get("category", ""),
                "photo_url": _resolve_photo_url(first_extra.get("photo_url", "")),
                "description": _split_description(first_extra.get("description", "")),
            })
        else:
            has_garnish = clean.lower() in sets_with_garnish
            garnish_options = []
            if has_garnish:
                raw = garnish_map.get(clean.lower(), [])
                garnish_options = [{"value": g, "display": texts.display_garnish(g)} for g in raw]
            clean_extra = extra.get(clean, {})
            items.append({
                "key": clean,
                "is_variant_group": False,
                "display_name": sheets.display_set_name(clean),
                "variants": [],
                "price": prices.get(clean, 0),
                "has_garnish": bool(garnish_options),
                "garnish_options": garnish_options,
                "category": clean_extra.get("category", ""),
                "photo_url": _resolve_photo_url(clean_extra.get("photo_url", "")),
                "description": _split_description(clean_extra.get("description", "")),
            })
    return items


async def api_menu(request: web.Request):
    photo_ids, caption = await _retry_sheets(sheets.get_today_menu_photos)
    # "Меню не опубликовано" — своё состояние ЭТОГО приложения (в чат-боте
    # такого явного гейта нет: он просто не показывает фото, если их нет,
    # но всё равно даёт заказывать по тому, что есть в каталоге). Для
    # премиального приложения решили быть строже и явно попросить
    # подождать публикации, а не предлагать заказ по потенциально
    # устаревшим данным — см. отчёт пользователю.
    published = bool(photo_ids or caption)
    cutoff_passed = False if PAUSEAPP_IGNORE_CUTOFF else await _retry_sheets(sheets.is_after_cutoff)

    sets_today = await _retry_sheets(sheets.get_today_sets)
    prices = await _retry_sheets(sheets.get_set_prices)
    sets_with_garnish = await _retry_sheets(sheets.get_sets_with_garnish)
    sets_extra = await _retry_sheets(sheets.get_set_extra)
    garnish_map = await _retry_sheets(sheets.get_today_garnishes_for_all_sets)
    payment_options = [
        o for o in await _retry_sheets(sheets.get_payment_options)
        if "долг" not in o.lower() and "проверке" not in o.lower()
    ]

    return web.json_response({
        "date": await _retry_sheets(sheets.get_active_menu_date),
        "caption": caption,
        "published": published,
        "can_order": published and not cutoff_passed,
        "cutoff_passed": cutoff_passed,
        "cutoff_time": config.ORDER_CUTOFF_TIME,
        "sets": _serialize_sets(sets_today, prices, sets_with_garnish, sets_extra, garnish_map),
        "payment_options": payment_options,
        "card_requisites": texts.REQUISITES_TEXT,
    })


def _delivery_enabled(tg_id) -> bool:
    """Платная доставка по статусу клиента (config.CLUB_DELIVERY_FEES) —
    для всех, пока config.DELIVERY_FEES_ENABLED; иначе только тестовые."""
    return config.DELIVERY_FEES_ENABLED or tg_id in config.PAUSEAPP_TEST_CLIENT_IDS


async def api_zones(request: web.Request):
    return web.json_response({"zones": await _retry_sheets(sheets.get_zones)})


async def api_points(request: web.Request):
    zone = request.query.get("zone", "")
    return web.json_response({"points": await _retry_sheets(sheets.get_points, zone)})


async def api_delivery_points(request: web.Request):
    """Точки с реальными координатами — метки на карте выбора точки
    доставки (см. pauseapp_static/app.js: renderDeliveryMapPicker).
    "zone" у каждой — подсказка (см. sheets.get_point_zones), не то же
    самое, что хранится в самой "Точки доставки" (там района нет вовсе,
    см. config.py)."""
    points = await _retry_sheets(sheets.get_delivery_points)
    zones = await _retry_sheets(sheets.get_point_zones)
    out = []
    for p in points:
        try:
            lat = float(p["lat"])
            lon = float(p["lon"])
        except (TypeError, ValueError):
            continue
        out.append({"name": p["name"], "address": p["address"], "lat": lat, "lon": lon, "zone": zones.get(p["name"], "")})
    return web.json_response({"points": out})


async def api_geocode(request: web.Request):
    """Подсказки адреса/места при вводе — см. geo.search."""
    q = (request.query.get("q") or "").strip()
    return web.json_response({"results": await geo.search(q) if len(q) >= 2 else []})


async def api_reverse_geocode(request: web.Request):
    """Настоящий адрес и район по точке на карте — см. geo.reverse."""
    try:
        lat = float(request.query.get("lat", ""))
        lon = float(request.query.get("lon", ""))
    except ValueError:
        return web.json_response({"place": None})
    return web.json_response({"place": await geo.reverse(lat, lon)})


def _payment_value(payment: str, has_screenshot: bool) -> str:
    """Точная копия ветвления handlers/order.py:_order_payment_value, только
    источник данных другой — там card_status берётся из FSM (клиент прошёл
    card_decision/card_now/card_later по шагам), здесь то же самое решается
    сразу по двум полям, которые приложение прислало одним запросом
    (payment + был ли реально загружен скрин)."""
    # Пока админ/курьер не подтвердил оплату, в таблице стоит "В долг"
    # (способ — в скрытом столбце O_PAY_METHOD, см. _pay_method).
    if "карт" in payment.lower() or payment.strip() == "Наличными":
        return "В долг"
    return payment


def _pay_method(payment: str) -> str:
    if "карт" in payment.lower():
        return "Карта"
    if payment.strip() == "Наличными":
        return "Наличные"
    return ""


async def api_upload_screenshot(request: web.Request):
    """Скрин оплаты картой — заказ ещё не отправлен, это отдельный шаг
    визарда (как в боте: сначала скрин, потом сводка с подтверждением).
    НЕ хранилище: файл не сохраняется ни в какой новый лист/чат — только
    прогоняется через Telegram Bot API (bot.send_photo), чтобы получить
    настоящий Telegram file_id, тем же способом, каким этот file_id и так
    появляется у бота, когда клиент присылает скрин обычным сообщением в
    чат. Отправляется самому админу, который сейчас пользуется
    приложением (тот же человек, что увидит и итоговое уведомление о
    заказе) — как и в чат-боте, где ровно на этом шаге клиенту приходит
    "Скрин получен ✓"."""
    tg_id = request["tg_id"]
    bot = request.app.get("bot")
    if not bot:
        return web.json_response({"error": "bot_unavailable"}, status=503)

    reader = await request.multipart()
    field = await reader.next()
    if field is None or field.name != "photo":
        return web.json_response({"error": "photo_required"}, status=400)
    data = await field.read(decode=False)
    if not data:
        return web.json_response({"error": "photo_required"}, status=400)
    if len(data) > MAX_SCREENSHOT_BYTES:
        return web.json_response({"error": "too_large"}, status=400)

    filename = field.filename or "screenshot.jpg"
    try:
        msg = await bot.send_photo(
            tg_id, BufferedInputFile(data, filename=filename),
            caption=texts.CARD_SCREENSHOT_RECEIVED,
        )
    except Exception:
        logger.exception("PAUSE App: не удалось загрузить скрин оплаты (tg_id=%s)", tg_id)
        return web.json_response({"error": "upload_failed"}, status=502)

    return web.json_response({"file_id": msg.photo[-1].file_id})


async def _refresh_giveaway_state(tg_id: int, date_str: str) -> dict:
    """После оформления заказа — подхватить клиента в сегодняшний пул
    "Пауза в подарок", если уже положено по статусу (см.
    sheets.auto_join_daily_giveaway — именно под "свежий order_count сразу
    после своего же заказа" и был добавлен force= у find_client_by_tg_id).
    Не критично для самого заказа — ошибка тут не должна ронять его
    оформление, поэтому гасится на месте, а не всплывает наружу."""
    try:
        client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id, force=True)
        joined = bool(client) and await _retry_sheets(sheets.auto_join_daily_giveaway, date_str, client)
        has_ticket = await _retry_sheets(sheets.has_available_ticket, tg_id)
        return {"joined": bool(joined), "has_ticket": has_ticket}
    except Exception:
        logger.exception("PAUSE App: не удалось обновить состояние розыгрыша после заказа (tg_id=%s)", tg_id)
        return {"joined": False, "has_ticket": False}


_bg_tasks = set()


def _spawn(coro):
    """Фоновая задача, не блокирующая ответ клиенту (уведомления, второстепенные записи)."""
    task = asyncio.ensure_future(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


async def api_order_submit(request: web.Request):
    """Оформление заказа — те же два пути, что и confirm_order в
    handlers/order.py: обычная точка -> append_order на каждую позицию
    корзины с одним batch_id; новая (ещё не в каталоге) точка ->
    create_pending_order, заказ ждёт подтверждения координатором и в
    "Заказы" не попадает, пока admin не нажмёт "✅ Подтвердить" (см.
    handlers/admin.py: pending_point_approved — тот же обработчик, тот же
    callback_data, отдельно ничего не заводили)."""
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"error": "not_registered"}, status=404)

    after_cutoff, date_str = await asyncio.gather(
        _retry_sheets(sheets.is_after_cutoff), _retry_sheets(sheets.get_active_menu_date))
    if not PAUSEAPP_IGNORE_CUTOFF and after_cutoff:
        return web.json_response({"error": "cutoff_closed"}, status=409)

    body = await request.json()
    cart = body.get("cart") or []
    if not cart:
        return web.json_response({"error": "empty_cart"}, status=400)
    zone = (body.get("zone") or "").strip()
    point = (body.get("point") or "").strip()
    is_new_point = bool(body.get("is_new_point"))
    lat = body.get("lat")
    lon = body.get("lon")
    comment = (body.get("comment") or "").strip()
    payment = (body.get("payment") or "").strip()
    screenshot = (body.get("screenshot_file_id") or "").strip()
    ticket_item_index = body.get("ticket_item_index")
    if not zone or not point:
        return web.json_response({"error": "point_required"}, status=400)

    # Платная доставка по статусу — считаем здесь САМИ по order_count
    # клиента, не доверяя тому, что могла прислать корзина (сервер —
    # источник истины для суммы). Пока только для PAUSEAPP_TEST_CLIENT_IDS
    # (см. config.CLUB_DELIVERY_FEES) и только на уже известную точку —
    # на новую (is_new_point) заказ уходит на модерацию через отдельный,
    # ещё не тронутый этой логикой путь (create_pending_order), доставку
    # туда пока не добавляем.
    delivery_fee = (
        sheets.get_client_delivery_fee(client.get("order_count", 0))
        if _delivery_enabled(tg_id) and not is_new_point else 0
    )

    # Билет "Пауза в подарок" — ровно ОДНА ШТУКА из выбранной позиции
    # корзины, выбираемый отдельно от способа оплаты остального — корзина
    # может содержать и другие сеты (или бОльшее количество той же
    # позиции), оплачиваемые как обычно (см. app.js: stepCheckout —
    # переключатель "билетом" поверх наличных/карты, не вместо них).
    # Позиция с qty > 1 ниже делится на две строки заказа — 1 шт. билетом
    # и остаток обычной оплатой (см. append_orders_batch). Без скрина и
    # модерации на саму билетную строку (билет сам по себе уже
    # подтверждение, см. sheets.use_ticket). На новую (ещё не в каталоге)
    # точку билетом не принимаем — такой заказ и так уходит на модерацию
    # админу, а билет должен списаться сразу и один раз, без гонки с
    # решением админа по заявке.
    is_ticket_payment = ticket_item_index is not None
    if is_ticket_payment:
        if is_new_point:
            return web.json_response({"error": "ticket_new_point_not_allowed"}, status=400)
        if not isinstance(ticket_item_index, int) or not 0 <= ticket_item_index < len(cart):
            return web.json_response({"error": "ticket_single_set_only"}, status=400)
        if not await _retry_sheets(sheets.has_available_ticket, tg_id):
            return web.json_response({"error": "no_ticket"}, status=400)

    # Способ оплаты (наличные/карта) обязателен только для той части
    # заказа, что не покрыта билетом — если билет закрывает всю корзину
    # целиком (один сет, ровно 1 шт.) И доставка для этого клиента
    # бесплатна, remaining пуст и платить вообще нечем. Билет на саму
    # доставку не распространяется — она либо есть, либо нет, отдельно от
    # того, какой сет покрыт билетом.
    total_qty = sum(int(item.get("qty", 0)) for item in cart)
    has_remaining = not is_ticket_payment or total_qty > 1 or delivery_fee > 0
    if has_remaining and not payment:
        return web.json_response({"error": "payment_required"}, status=400)

    delivery_comment = (body.get("delivery_comment") or "").strip()[:500]
    if delivery_comment:
        async def _save_dc():
            try:
                await _retry_sheets(sheets.add_delivery_comment, date_str, client, point, delivery_comment)
            except Exception:
                logger.exception("PAUSE App: не удалось сохранить комментарий к доставке")
        _spawn(_save_dc())
    payment_value = _payment_value(payment, bool(screenshot))
    bot = request.app.get("bot")

    # Новая точка выбрана на карте (поиск адреса или метка вручную) —
    # сразу же, независимо от модерации самого заказа, пишем её с
    # координатами в "Точки доставки", чтобы курьерский Mini App "Маршрут"
    # сразу видел её на карте, а не ждал, пока админ впишет координаты
    # руками (см. sheets.create_or_update_delivery_point). Сам заказ на
    # новую точку всё равно уходит на модерацию — координаты тут ни при
    # чём, это две независимые вещи.
    if is_new_point and lat and lon:
        try:
            await _retry_sheets(sheets.create_or_update_delivery_point, point, point, float(lat), float(lon))
        except Exception:
            logger.exception("PAUSE App: не удалось сохранить координаты новой точки (заказ)")

    if is_new_point:
        pending_id = await _retry_sheets(
            sheets.create_pending_order,
            date_str=date_str, zone=zone, point=point,
            client_id=client["id"], client_name=client.get("name", ""),
            client_phone=client.get("contact", ""), cart=cart,
            payment=(payment_value + "|" + _pay_method(payment)) if _pay_method(payment) else payment_value,
            comment=comment, screenshot=screenshot,
        )
        if bot and config.ADMIN_IDS:
            try:
                prices = await _retry_sheets(sheets.get_set_prices)
                total = sum(prices.get(i["set"], 0) * int(i.get("qty", 0)) for i in cart)
                items_text = ", ".join(
                    f"{i['qty']}× {sheets.display_set_name(i['set'])}" + (f" ({i['garnish']})" if i.get("garnish") else "")
                    for i in cart
                )
                uname = (client.get("telegram") or "").strip().lstrip("@")
                alert = texts.ADMIN_PENDING_POINT_ALERT.format(
                    name=client.get("name", ""), client_id=client.get("id", ""),
                    username=("@" + uname) if uname else "—",
                    phone=client.get("contact") or "—",
                    zone=zone, point=point, items=items_text,
                    sum=f"{total:,}".replace(",", " "), payment=payment,
                )
                map_url = ""
                if config.WEBAPP_URL and lat and lon:
                    map_url = (f"{config.WEBAPP_URL}/pauseapp/point?lat={float(lat):.6f}&lon={float(lon):.6f}"
                               f"&n={urllib.parse.quote(point)}")
                markup = kb.pending_point_admin_kb(pending_id, map_url)
                if screenshot:
                    alert += texts.ADMIN_PENDING_SCREENSHOT_NOTE
                    await notify_admins_photo(bot, screenshot, alert, reply_markup=markup)
                else:
                    await notify_admins(bot, alert, reply_markup=markup)
            except Exception:
                logger.exception("PAUSE App: не удалось уведомить админов о заказе на новую точку")
        giveaway = await _refresh_giveaway_state(tg_id, date_str)
        return web.json_response({"status": "pending", "pending_id": pending_id, "giveaway": giveaway})

    batch_id = uuid.uuid4().hex
    # Билетная позиция пишется с PAYMENT_TICKET — если в ней было больше
    # 1 шт., делим на две строки: 1 шт. билетом + остаток обычной оплатой
    # (payment_value), т.к. один ряд "Заказы" несёт одно значение payment
    # сразу на весь qty этой строки. ticket_row_pos — индекс билетной
    # строки в итоговом списке (нужен ниже, чтобы списать билет на
    # правильный номер строки, а не row_nums[ticket_item_index] — после
    # возможного расщепления индексы уже не совпадают 1:1 с cart).
    items = []
    payment_values = []
    ticket_row_pos = None
    for i, item in enumerate(cart):
        qty = int(item["qty"])
        base = {"set": item["set"], "garnish": item.get("garnish", "")}
        if is_ticket_payment and i == ticket_item_index:
            ticket_row_pos = len(items)
            items.append(dict(base, qty=1))
            payment_values.append(config.PAYMENT_TICKET)
            if qty > 1:
                items.append(dict(base, qty=qty - 1))
                payment_values.append(payment_value)
        else:
            items.append(dict(base, qty=qty))
            payment_values.append(payment_value)
    row_nums = await _retry_sheets(
        sheets.append_orders_batch,
        date_str=date_str, zone=zone, point=point, client_id=client["id"], items=items,
        payment=payment_values if is_ticket_payment else payment_value,
        comment=comment, screenshot=screenshot, batch_id=batch_id, delivery_fee=delivery_fee,
        fee_payment=payment_value, pay_method=_pay_method(payment),
    )

    async def _save_point():
        try:
            await _retry_sheets(sheets.update_client_point, client["row"], zone, point)
        except Exception:
            logger.exception("PAUSE App: не удалось сохранить точку по умолчанию (tg_id=%s)", tg_id)

    async def _use_ticket():
        if not is_ticket_payment:
            return
        try:
            await _retry_sheets(sheets.use_ticket, tg_id, order_row=row_nums[ticket_row_pos])
        except Exception:
            logger.exception("PAUSE App: не удалось списать билет 'Пауза в подарок' (tg_id=%s)", tg_id)

    async def _care():
        number = await _retry_sheets(sheets.get_next_message_number)
        phrase = random.choice(CARE_PHRASES)
        await _retry_sheets(sheets.save_care_message, number, tg_id, client.get("name", ""), sheets.today_date_str(), phrase)
        return number, phrase

    async def _notify_screenshot():
        if not (screenshot and bot and config.ADMIN_IDS):
            return
        try:
            prices = await _retry_sheets(sheets.get_set_prices)
            total = sum(prices.get(i["set"], 0) * int(i.get("qty", 0)) for i in cart)
            if is_ticket_payment:
                # Скрин — на остаток ПОСЛЕ вычета 1 шт., закрытой билетом,
                # иначе админ сверял бы скрин с полной суммой корзины.
                total -= prices.get(cart[ticket_item_index]["set"], 0)
            total += delivery_fee
            items_text = ", ".join(
                f"{i['qty']}× {sheets.display_set_name(i['set'])}" + (f" ({i['garnish']})" if i.get("garnish") else "")
                for i in cart
            )
            caption = texts.ADMIN_CARD_PAYMENT_ALERT.format(
                name=client.get("name", ""), client_id=client.get("id", ""),
                items=items_text, sum=f"{total:,}".replace(",", " "),
            )
            rows_str = ",".join(str(r) for i, r in enumerate(row_nums) if not (is_ticket_payment and i == ticket_row_pos))
            await notify_admins_photo(bot, screenshot, caption, reply_markup=kb.card_confirm_admin_kb(rows_str))
        except Exception:
            logger.exception("PAUSE App: не удалось уведомить админов о скрине оплаты")

    _spawn(_notify_screenshot())
    async def _ticket_then_giveaway():
        await _use_ticket()  # состояние билета в розыгрыше — уже после списания
        return await _refresh_giveaway_state(tg_id, date_str)

    _, (number, phrase), giveaway = await asyncio.gather(
        _save_point(), _care(), _ticket_then_giveaway())

    return web.json_response({
        "status": "ok",
        "row_nums": row_nums,
        "care": {"number": number, "total": config.CARE_MESSAGE_TOTAL, "phrase": phrase},
        "giveaway": giveaway,
    })


# ---------------------------------------------------------------------------
# Профиль — та же логика, что handlers/profile.py (_show_profile,
# edit_name_save/edit_phone_save/_save_point).
# ---------------------------------------------------------------------------

async def api_profile(request: web.Request):
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"registered": False})
    order_count = client.get("order_count", 0)
    level = sheets.get_club_level(order_count)  # чистая функция, таблицу не трогает
    # has_ticket — нужен на экране оформления заказа (3-я плитка оплаты
    # "Билетом", см. app.js: stepCheckout), чтобы не делать отдельный
    # запрос только для этого; state.profile и так уже грузится первым
    # (см. loadHome) и переживает между экранами внутри сессии.
    has_ticket = await _retry_sheets(sheets.has_available_ticket, tg_id)
    # Платная доставка по статусу — ПОКА только для тестового аккаунта
    # (config.PAUSEAPP_TEST_CLIENT_IDS), остальные (включая других
    # админов) видят 0, как и раньше. См. config.CLUB_DELIVERY_FEES.
    # delivery_enabled — отдельно от суммы: у статуса "Гость" (первый
    # заказ) сумма легитимно 0, но строку "Доставка" в сверке всё равно
    # нужно показать (с прочерком, см. app.js: stepCheckout) — фронту
    # нужно различать "доставка для этого клиента вообще считается,
    # просто сейчас бесплатно" от "доставка для этого клиента не
    # включена вовсе" (обычные клиенты, не из тестового списка).
    delivery_enabled = _delivery_enabled(tg_id)
    delivery_fee = sheets.get_client_delivery_fee(order_count) if delivery_enabled else 0
    return web.json_response({
        "registered": True,
        "name": client.get("name", ""),
        "phone": client.get("contact", ""),
        "zone": client.get("zone", ""),
        "point": client.get("point", ""),
        "order_count": order_count,
        "reg_date": client.get("reg_date", ""),
        "has_ticket": has_ticket,
        "delivery_fee": delivery_fee,
        "delivery_enabled": delivery_enabled,
        "club": {
            "key": level.get("key"),
            "emoji": level["emoji"],
            "label": level["label"],
            "next_key": level.get("next_key"),
            "next_emoji": level.get("next_emoji"),
            "next_label": level.get("next_label"),
            "left": level.get("left", 0),
            # Полная шкала всех статусов (для экрана "Pause Club" — см.
            # renderClubLevelsScreen в app.js), сама по себе чистая
            # функция, доп. обращения к таблице не нужны.
            "levels": sheets.get_club_levels_overview(order_count),
        },
    })


# ---------------------------------------------------------------------------
# "Бонусы и промокоды" — пока только билеты "Пауза в подарок", выигранные в
# ежедневном розыгрыше (см. sheets.get_client_tickets). Список, новые
# сверху, со статусом "Доступен"/"Использован" на каждом.
# ---------------------------------------------------------------------------

async def api_bonuses(request: web.Request):
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"registered": False})
    tickets = await _retry_sheets(sheets.get_client_tickets, tg_id)
    # "available" — булевым, а не статусом-строкой на русском (как в
    # самом листе/в админском /api/ops/giveaway) — у фронтенда тут
    # i18n на 3 языка (см. I18N "bonuses.ticket*"), сравнивать с русским
    # текстом из таблицы ему не нужно.
    out = [
        {"date_won": tk["date_won"], "date_used": tk["date_used"],
         "available": tk["status"] == config.TICKET_STATUS_AVAILABLE}
        for tk in tickets
    ]
    return web.json_response({"registered": True, "tickets": out})


# ---------------------------------------------------------------------------
# Колокольчик уведомлений (шапка Главной, заменил собой переключатель
# языка — см. app.js: buildHeaderBell/loadNotifications). НЕ дублирует
# обычные сообщения бота (утреннее напоминание, публикация меню — см.
# предыдущий раздел с настройками уведомлений выше) — отдельный поток
# только для того, что стоит показать как отдельное событие внутри
# самого приложения. Первый источник — выигрыш в "Пауза в подарок" (см.
# run_daily_giveaway_draw ниже), пишется в config.SHEET_APP_NOTIFICATIONS
# (см. sheets.create_app_notification и соседние функции). По tg_id, без
# привязки к регистрации в "Клиенты" — колокольчик работает даже для
# того, кто ещё не успел /start.
# ---------------------------------------------------------------------------

async def api_notifications(request: web.Request):
    tg_id = request["tg_id"]
    items = await _retry_sheets(sheets.get_app_notifications, tg_id)
    unread = sum(1 for n in items if not n["read"])
    return web.json_response({
        "notifications": [
            {"created": n["created"], "kind": n["kind"], "text": n["text"], "read": n["read"]}
            for n in items
        ],
        "unread_count": unread,
    })


async def api_notifications_read(request: web.Request):
    tg_id = request["tg_id"]
    await _retry_sheets(sheets.mark_app_notifications_read, tg_id)
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# Настройки уведомлений — Профиль → Уведомления. Два независимых
# переключателя поверх уже существующих рассылок (см. bot.send_warm_broadcast
# и handlers/admin.py:_broadcast_new_menu — оба сами проверяют эти флаги на
# каждого клиента). Настоящего расписания "во сколько именно" здесь нет и
# в этой версии не будет: обе рассылки — общие по всем клиентам разом, в
# одно и то же время (см. config.WARM_BROADCAST_TIME), под каждого клиента
# отдельное время потребовало бы отдельного планировщика — это отдельная,
# более крупная задача.
# ---------------------------------------------------------------------------

async def api_notify(request: web.Request):
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"error": "not_registered"}, status=404)
    return web.json_response({
        "morning_on": not client.get("notify_morning_off"),
        "menu_on": not client.get("notify_menu_off"),
    })


async def api_notify_set(request: web.Request):
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"error": "not_registered"}, status=404)
    body = await request.json()
    if "morning_on" in body:
        col = config.COL_NOTIFY_MORNING_OFF
        await _retry_sheets(sheets.update_client_field, client["row"], col, "" if body["morning_on"] else "Да")
    if "menu_on" in body:
        col = config.COL_NOTIFY_MENU_OFF
        await _retry_sheets(sheets.update_client_field, client["row"], col, "" if body["menu_on"] else "Да")
    return web.json_response({"ok": True})


async def api_profile_edit(request: web.Request):
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"error": "not_registered"}, status=404)

    body = await request.json()
    name = (body.get("name") or "").strip()
    phone = (body.get("phone") or "").strip()
    zone = (body.get("zone") or "").strip()
    point = (body.get("point") or "").strip()
    is_new_point = bool(body.get("is_new_point"))
    lat = body.get("lat")
    lon = body.get("lon")

    # Приложение само не даёт отправить незаполненный/неверный номер (см.
    # pauseapp_static/app.js: buildPhoneField), но на сервере тоже
    # проверяем и приводим к единому виду — та же функция, что у бота
    # при регистрации/правке телефона (sheets.format_uz_phone), чтобы в
    # "Клиенты" номер хранился одинаково независимо от того, откуда он
    # пришёл.
    if phone:
        normalized = sheets.format_uz_phone(phone)
        if not normalized:
            return web.json_response({"error": "phone_invalid"}, status=400)
        phone = normalized

    if name:
        await _retry_sheets(sheets.update_client_field, client["row"], config.COL_NAME, name)
    if phone:
        await _retry_sheets(sheets.update_client_field, client["row"], config.COL_CONTACT, phone)
    if zone and point:
        await _retry_sheets(sheets.update_client_point, client["row"], zone, point)
        if is_new_point and lat and lon:
            try:
                await _retry_sheets(sheets.create_or_update_delivery_point, point, point, float(lat), float(lon))
            except Exception:
                logger.exception("PAUSE App: не удалось сохранить координаты новой точки (профиль)")
        if is_new_point:
            bot = request.app.get("bot")
            if bot and config.ADMIN_IDS:
                try:
                    await notify_admins(bot, texts.ADMIN_NEW_POINT_ALERT.format(
                        name=client.get("name", ""), client_id=client.get("id", ""),
                        zone=zone, point=point,
                    ))
                except Exception:
                    logger.exception("PAUSE App: не удалось уведомить админов о новой точке из профиля")
    return web.json_response({"ok": True})


async def api_account_delete_request(request: web.Request):
    """Заявка на удаление аккаунта — сам бот НИЧЕГО не удаляет и не
    трогает данные клиента, только уведомляет админов в Telegram; сам
    аккаунт/заказы разбираются вручную (та же осторожная логика, что и у
    "новой точки"/pending-заказов — необратимые вещи админ подтверждает
    сам, не бот в одно касание)."""
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"error": "not_registered"}, status=404)
    bot = request.app.get("bot")
    if bot and config.ADMIN_IDS:
        try:
            await notify_admins(bot, texts.ADMIN_DELETE_ACCOUNT_ALERT.format(
                name=client.get("name", ""), client_id=client.get("id", ""),
                contact=client.get("contact", ""),
            ))
        except Exception:
            logger.exception("PAUSE App: не удалось уведомить админов о заявке на удаление аккаунта")
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# Мои заказы / отмена — та же логика, что handlers/profile.py
# (my_orders, cancel_order_start/cancel_order_yes).
# ---------------------------------------------------------------------------

async def api_orders(request: web.Request):
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"error": "not_registered"}, status=404)

    # Один проход по листу "Заказы" на двоих (группы + долг), а не два —
    # раньше get_client_order_groups и get_client_debt каждый читали ВЕСЬ
    # лист заново (800+ строк), из-за чего "Мои заказы" заметно тормозило
    # независимо от устройства клиента.
    pending = await _retry_sheets(sheets.get_client_pending_orders, client["id"])
    order_rows = await _retry_sheets(sheets.get_client_orders, client["id"], limit=10**9)
    groups = await _retry_sheets(sheets.get_client_order_groups, client["id"], limit=10, rows=order_rows)
    debt = await _retry_sheets(sheets.get_client_debt_from_orders, order_rows)

    pending_out = [{
        "date": p["date"],
        "items": [{"set": sheets.display_set_name(i["set"]), "qty": i["qty"]} for i in p["items"]],
        "payment": p["payment"],
        "status": "pending_point",
    } for p in pending]

    groups_out = []
    for g in groups:
        can_cancel = (
            not g["canceled"]
            and not sheets.is_after_cancel_cutoff(g["date"])
            and not _card_pending_status(g["payment"])
            and not g.get("card_review")
        )
        # Клиенту — только клиентские названия (те же, что на карточках в
        # Меню), техническое имя столбца G "Заказы" наружу не уходит.
        display_items = [
            {"set": sheets.display_set_name(i["set"]), "qty": i["qty"]}
            for i in g["items"]
        ]
        groups_out.append({
            "review": bool(g.get("review")),
            "date": g["date"],
            "items": display_items,
            "payment": g["payment"],
            "canceled": g["canceled"],
            "is_debt": g["payment"] == "В долг" and not g.get("review"),
            "delivery_fee": g.get("delivery_fee", 0),
            "sets_sum": g.get("sets_sum", 0),
            "methods": g.get("methods", []),
            "day_key": g["date"],
            "delivery_state": (
                "paid" if g.get("delivery_payment") in ("Картой", "Наличными")
                else "review" if g.get("delivery_payment") == "На проверке" or (g.get("delivery_payment") == "В долг" and g.get("review"))
                else "debt" if g.get("delivery_payment") == "В долг"
                else "unpaid"
            ) if g.get("delivery_fee") else "",
            "paid": g["paid"],
            "complete": sheets.is_order_complete(g["date"]) if not g["canceled"] else False,
            "can_cancel": can_cancel,
            "row_for_feedback": g["rows"][0] if g["rows"] else None,
        })

    debt_days = await _retry_sheets(sheets.get_client_debt_by_day, order_rows)
    return web.json_response({"pending": pending_out, "orders": groups_out, "debt": debt, "debt_days": debt_days})


async def api_debt_pay(request: web.Request):
    """Оплата долга скрином из "Мои заказы": все строки "В долг" клиента
    уходят на проверку админу (скрин уже загружен через /api/order/screenshot)."""
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"error": "not_registered"}, status=404)
    try:
        body = await request.json()
    except Exception:
        body = {}
    file_id = (body.get("file_id") or "").strip()
    if not file_id:
        return web.json_response({"error": "photo_required"}, status=400)

    dates = body.get("dates")
    dates = {str(d).strip() for d in dates} if isinstance(dates, list) and dates else None
    order_rows = await _retry_sheets(sheets.get_client_orders, client["id"], limit=10**9)
    days = await _retry_sheets(sheets.get_client_debt_by_day, order_rows)
    debt = sum(d["amount"] for d in days if dates is None or d["date"] in dates)
    row_nums = await _retry_sheets(sheets.submit_debt_payment, client["id"], file_id, dates)
    if not row_nums:
        return web.json_response({"error": "no_debt"}, status=409)

    bot = request.app.get("bot")
    if bot and config.ADMIN_IDS:
        try:
            caption = texts.ADMIN_CARD_PAYMENT_ALERT.format(
                name=client.get("name", ""), client_id=client.get("id", ""),
                items="оплата долга" + (" за " + ", ".join(sorted(dates)) if dates else ""), sum=f"{debt:,}".replace(",", " "),
            )
            await notify_admins_photo(
                bot, file_id, caption,
                reply_markup=kb.card_confirm_admin_kb(",".join(str(r) for r in row_nums)),
            )
        except Exception:
            logger.exception("PAUSE App: не удалось уведомить админов об оплате долга")
    return web.json_response({"status": "ok"})


async def api_orders_cancel(request: web.Request):
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"error": "not_registered"}, status=404)

    groups = await _retry_sheets(sheets.get_client_order_groups, client["id"], limit=1)
    if not groups or groups[0]["canceled"]:
        return web.json_response({"error": "already_canceled"}, status=409)
    g = groups[0]
    if await _retry_sheets(sheets.is_after_cancel_cutoff, g["date"]):
        return web.json_response({"error": "too_late", "cutoff": config.CANCEL_CUTOFF_TIME}, status=409)
    card_status = _card_pending_status(g["payment"]) or ("на проверке" if g.get("card_review") else "")
    if card_status:
        return web.json_response({"error": "card_pending", "status": card_status}, status=409)

    await _retry_sheets(sheets.cancel_order_rows, g["rows"])

    bot = request.app.get("bot")
    if bot and config.ADMIN_IDS:
        try:
            items_text = ", ".join(f"{i['qty']}× {sheets.display_set_name(i['set'])}" for i in g["items"])
            await notify_admins(bot, texts.ADMIN_ORDER_CANCELLED_ALERT.format(
                name=client.get("name", ""), client_id=client.get("id", ""),
                contact=client.get("contact", ""), date=g["date"],
                zone=g.get("zone", ""), items=items_text,
            ))
        except Exception:
            logger.exception("PAUSE App: не удалось уведомить админов об отмене заказа")

    return web.json_response({"ok": True})


def _serialize_favorite_sets(keys: list, prices: dict, extra: dict) -> list:
    """Карточки избранных блюд клиента — переиспользует ровно ту же
    сборку карточки, что и сегодняшнее меню (_serialize_sets: фото,
    категория, описание, цена, варианты), только без гарнира (сохранённое
    блюдо — не заказ, гарнир выбирается заново на шаге заказа) и без
    привязки к тому, что подаётся именно сегодня — сет мог выпасть из
    сегодняшнего меню, но остаться в избранном. Порядок сохраняется тот
    же, что и в keys (см. sheets.get_favorite_sets — от старых к новым),
    т.к. _serialize_sets сам идёт по порядку входного списка."""
    names = [k.split(":", 1)[1] if k.startswith("__variant__:") else k for k in keys]
    return _serialize_sets(names, prices, set(), extra)


async def api_favorites(request: web.Request):
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"error": "not_registered"}, status=404)
    keys = await _retry_sheets(sheets.get_favorite_sets, client["id"])
    prices = await _retry_sheets(sheets.get_set_prices)
    extra = await _retry_sheets(sheets.get_set_extra)
    return web.json_response({"keys": keys, "favorites": _serialize_favorite_sets(keys, prices, extra)})


async def api_favorites_toggle(request: web.Request):
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"error": "not_registered"}, status=404)
    body = await request.json()
    key = (body.get("key") or "").strip()
    if not key:
        return web.json_response({"error": "key_required"}, status=400)
    favorited = await _retry_sheets(sheets.toggle_favorite_set, client["id"], key)
    return web.json_response({"ok": True, "favorited": favorited})


async def api_feedback(request: web.Request):
    """Отзыв к конкретному заказу — та же логика, что
    handlers/profile.py: feedback_start/feedback_save."""
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"error": "not_registered"}, status=404)

    body = await request.json()
    text = (body.get("text") or "").strip()
    order_label = (body.get("order_label") or "—").strip()
    try:
        stars = int(body.get("stars") or 0)
    except (TypeError, ValueError):
        stars = 0
    stars = max(0, min(5, stars))
    if not stars and not text:
        return web.json_response({"error": "text_required"}, status=400)

    bot = request.app.get("bot")
    if bot and config.ADMIN_IDS:
        try:
            stars_line = ("★" * stars + "☆" * (5 - stars)) if stars else "без оценки"
            await notify_admins(bot, texts.ADMIN_FEEDBACK_ALERT.format(
                name=client.get("name", ""), client_id=client.get("id", ""),
                order=order_label, stars=stars_line, text=text or "(без комментария)",
            ))
        except Exception:
            logger.exception("PAUSE App: не удалось уведомить админов об отзыве")
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# Мои послания — та же логика, что handlers/profile.py: my_messages.
# ---------------------------------------------------------------------------

async def api_care_pending(request: web.Request):
    """Послание, которое ещё не показано (первый заказ на новую точку —
    выдаётся после подтверждения адреса). Приложение показывает окно."""
    m = await _retry_sheets(sheets.get_unseen_care_message, request["tg_id"])
    if not m:
        return web.json_response({"care": None})
    return web.json_response({"care": {"number": m["number"], "total": config.CARE_MESSAGE_TOTAL, "phrase": m["text"]}})


async def api_care_seen(request: web.Request):
    body = await request.json()
    await _retry_sheets(sheets.mark_care_message_seen, request["tg_id"], body.get("number"))
    return web.json_response({"ok": True})


async def point_map_page(request: web.Request):
    """Страница-карта для админа: где находится новая точка (кнопка в
    уведомлении о проверке адреса). Статика, без данных — координаты и
    название берутся из query."""
    with open(os.path.join(STATIC_DIR, "point.html"), "r", encoding="utf-8") as f:
        return web.Response(text=f.read(), content_type="text/html")


async def api_messages(request: web.Request):
    tg_id = request["tg_id"]
    messages = await _retry_sheets(sheets.get_client_messages, tg_id)
    return web.json_response({
        "messages": list(reversed(messages)),
        "total": config.CARE_MESSAGE_TOTAL,
    })


# ---------------------------------------------------------------------------
# Pause Club — таблица лидеров (топ-10 по числу заказов, экран "Pause Club").
# ---------------------------------------------------------------------------

async def api_club_leaderboard(request: web.Request):
    leaderboard = await _retry_sheets(sheets.get_club_leaderboard)
    total_clients = await _retry_sheets(sheets.get_total_clients_count)
    me, ranked_total = await _retry_sheets(sheets.get_club_leaderboard_me, request["tg_id"])
    return web.json_response({"leaderboard": leaderboard, "total_clients": total_clients, "me": me, "ranked_total": ranked_total})


# ---------------------------------------------------------------------------
# "Пауза в подарок" — ежедневный розыгрыш, видимый ВСЕМ во вкладке Pause
# Club (и участникам, и тем, кому статус пока не позволяет — им просто
# показывается, какой статус нужен заработать, см. config.GIVEAWAY_REQUIRED_
# LEVEL). Добавление в сегодняшний пул — автоматом после заказа (см.
# _refresh_giveaway_state выше), подведение итога — по расписанию (см.
# bot.py: scheduler, pauseapp.run_daily_giveaway_draw). Этот эндпоинт сам
# ничего не решает и не пишет — чистое отображение текущего состояния.
# ---------------------------------------------------------------------------

async def api_club_giveaway(request: web.Request):
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    order_count = client.get("order_count", 0) if client else 0

    required_key, required_threshold, required_emoji, required_label = next(
        lvl for lvl in config.CLUB_LEVELS if lvl[0] == config.GIVEAWAY_REQUIRED_LEVEL
    )
    eligible = sheets.is_giveaway_eligible(order_count)

    date_str = await _retry_sheets(sheets.get_active_menu_date)
    closed = await _retry_sheets(sheets.is_giveaway_window_closed)
    participants = await _retry_sheets(sheets.get_daily_giveaway_participants, date_str)
    joined = bool(client) and any(p["tg_id"] == str(tg_id) for p in participants)
    winner = await _retry_sheets(sheets.get_daily_giveaway_winner, date_str) if closed else None

    return web.json_response({
        "eligible": eligible,
        "joined": joined,
        "closed": closed,
        "winner_name": winner["name"] if winner else None,
        "participant_names": [p["name"] for p in participants],
        "participant_count": len(participants),
        "required_level": {
            "key": required_key, "emoji": required_emoji, "label": required_label,
            "threshold": required_threshold, "left": max(0, required_threshold - order_count),
        },
        "draw_time": config.GIVEAWAY_DRAW_TIME,
    })


async def run_daily_giveaway_draw(bot):
    """Ежедневный автоматический розыгрыш "Пауза в подарок" — запускается
    планировщиком в config.GIVEAWAY_DRAW_TIME (см. bot.py: scheduler).
    Сам выбор победителя и начисление билета — в sheets.
    pick_daily_giveaway_winner (идемпотентна сама по себе, безопасно
    звать повторно — см. её докстринг); здесь только уведомления:
    победителю лично и админам, для учёта (см. api_ops_giveaway). Вызовы
    sheets — синхронные, как и у остальных once-a-day джобов бота (см.
    send_morning_reports/send_warm_broadcast) — не через _retry_sheets,
    тот нужен только под нагрузкой параллельных HTTP-запросов самого
    Mini App."""
    date_str = sheets.get_active_menu_date()
    try:
        winner = sheets.pick_daily_giveaway_winner(date_str)
    except Exception:
        logger.exception("Не удалось подвести ежедневный розыгрыш 'Пауза в подарок' (%s)", date_str)
        return

    if not winner:
        await notify_admins(bot, texts.APP_ADMIN_DAILY_GIVEAWAY_EMPTY_ALERT.format(date=date_str))
        return

    try:
        await bot.send_message(int(winner["tg_id"]), texts.APP_DAILY_GIVEAWAY_WINNER_MSG)
    except Exception:
        logger.exception("Не удалось уведомить победителя 'Паузы в подарок' (tg_id=%s)", winner.get("tg_id"))

    # Тот же текст — ещё и в колокольчик PAUSE App (см. api_notifications
    # выше), отдельно от личного сообщения бота: человек может не
    # заметить/удалить чат с ботом, а уведомление в приложении останется,
    # пока он сам его не откроет.
    try:
        sheets.create_app_notification(winner["tg_id"], texts.APP_DAILY_GIVEAWAY_WINNER_MSG, kind="giveaway_win")
    except Exception:
        logger.exception("Не удалось записать уведомление в колокольчик PAUSE App (tg_id=%s)", winner.get("tg_id"))

    await notify_admins(bot, texts.APP_ADMIN_DAILY_GIVEAWAY_WINNER_ALERT.format(
        date=date_str, name=winner.get("name", ""), client_id=winner.get("client_id", ""),
    ))


async def api_avatar_image(request: web.Request):
    """Аватар клиента из Telegram (его собственное фото профиля) — и для
    таблицы лидеров (чужие аватарки), и для своего же профиля (см. app.js:
    renderProfileScreen) — initDataUnsafe.user.photo_url Telegram отдаёт
    ТОЛЬКО если Mini App открыт из attachment menu, у нас же всегда через
    обычную inline-кнопку (web_app), так что единственный надёжный способ —
    спросить Bot API самим (getUserProfilePhotos) и отдать клиенту уже
    готовые байты, не светя сам BOT_TOKEN во фронтенде (прямая ссылка
    api.telegram.org/file/bot<TOKEN>/... его как раз содержит). Тот же
    приём скачивания, что и у api_feed_image выше (bot.download сам делает
    getFile + скачивание).

    Кеш браузеру НЕ разрешаем (ни одного Cache-Control на долгий срок) —
    это живое фото профиля, человек может сменить его в Telegram в любой
    момент и тут же открыть приложение снова; раньше здесь стоял
    max-age=3600, из-за которого смена аватарки не подхватывалась иногда
    даже после нескольких перезаходов в течение этого часа."""
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
        logger.exception("PAUSE App: не удалось получить аватар клиента (tg_id=%s)", tg_id)
        return web.Response(status=502)
    if not photos or not photos.photos:
        return web.Response(status=404)
    file_id = photos.photos[0][-1].file_id
    try:
        buf = await bot.download(file_id)
    except Exception:
        logger.exception("PAUSE App: не удалось скачать аватар клиента (tg_id=%s)", tg_id)
        return web.Response(status=502)
    if buf is None:
        return web.Response(status=404)
    return web.Response(
        body=buf.read(), content_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )


# ---------------------------------------------------------------------------
# PAUSE Club — лента. Фото НЕ хранятся ни на сервере, ни в самой таблице —
# только в закрытом Telegram-канале config.MEDIA_CHAT_ID: бот отправляет
# туда фото (api_feed_publish), Telegram возвращает настоящий file_id, это
# он и пишется в лист "Лента" (см. sheets.create_feed_post). Клиенту
# картинка отдаётся через api_feed_image — сервер сам скачивает байты у
# Telegram и отдаёт их с НАШЕГО домена, токен бота наружу не уходит
# никогда. Публикация/удаление — только с этого экрана приложения, в
# /admin бота ничего не переносилось (см. договорённость в чате).
# ---------------------------------------------------------------------------

def _feed_post_out(p: dict) -> dict:
    # Абсолютный путь (с /pauseapp) — картинки идут прямо в <img src>, а не
    # через api()/API_BASE в app.js, поэтому префикс нужно дописать здесь,
    # а не полагаться на относительное разрешение URL в браузере.
    return {
        "id": p["id"], "date": p["date"], "type": p["type"],
        "caption": p["caption"], "author": p["author"],
        "image_urls": ["/pauseapp/api/feed/image/" + fid for fid in p["file_ids"]],
    }


async def api_feed_list(request: web.Request):
    posts = await _retry_sheets(sheets.get_feed_posts, 50)
    return web.json_response({"posts": [_feed_post_out(p) for p in posts]})


async def api_feed_publish(request: web.Request):
    """multipart: type, caption (опционально для type=photo), author не
    принимается от клиента — берём из его же профиля на сервере (см.
    ниже), чтобы имя автора нельзя было подделать через запрос. photos —
    0 и более полей "photo" (альбом)."""
    if not config.MEDIA_CHAT_ID:
        return web.json_response({"error": "media_chat_not_configured"}, status=503)
    bot = request.app.get("bot")
    if not bot:
        return web.json_response({"error": "bot_unavailable"}, status=503)

    post_type = "message"
    caption = ""
    photos = []
    reader = await request.multipart()
    async for field in reader:
        if field.name == "type":
            post_type = (await field.text()).strip() or "message"
        elif field.name == "caption":
            caption = (await field.text()).strip()
        elif field.name == "photo":
            data = await field.read(decode=False)
            if data:
                photos.append((data, field.filename or "photo.jpg"))

    if post_type not in config.FEED_POST_TYPES:
        return web.json_response({"error": "bad_type"}, status=400)
    if post_type == "photo" and not photos:
        return web.json_response({"error": "photo_required"}, status=400)
    if not caption and post_type != "photo":
        return web.json_response({"error": "caption_required"}, status=400)

    file_ids = []
    try:
        for data, filename in photos:
            msg = await bot.send_photo(int(config.MEDIA_CHAT_ID), BufferedInputFile(data, filename=filename))
            file_ids.append(msg.photo[-1].file_id)
    except Exception:
        logger.exception("PAUSE App: не удалось загрузить фото ленты в канал")
        return web.json_response({"error": "upload_failed"}, status=502)

    client = await _retry_sheets(sheets.find_client_by_tg_id, request["tg_id"])
    author = (client or {}).get("name") or str(request["tg_id"])
    post_id = await _retry_sheets(sheets.create_feed_post, post_type, caption, file_ids, author)
    return web.json_response({"ok": True, "id": post_id})


async def api_feed_delete(request: web.Request):
    _require_any_admin(request)
    body = await request.json()
    post_id = (body.get("id") or "").strip()
    if not post_id:
        return web.json_response({"error": "id_required"}, status=400)
    await _retry_sheets(sheets.delete_feed_post, post_id)
    return web.json_response({"ok": True})


async def api_feed_image(request: web.Request):
    """Сама картинка — см. докстринг раздела выше. bot.download() в
    aiogram сам делает getFile + скачивание, отдаёт готовый BytesIO."""
    file_id = request.match_info.get("file_id", "")
    bot = request.app.get("bot")
    if not bot or not file_id:
        return web.Response(status=404)
    try:
        buf = await bot.download(file_id)
    except Exception:
        logger.exception("PAUSE App: не удалось скачать фото ленты (file_id=%s)", file_id)
        return web.Response(status=502)
    if buf is None:
        return web.Response(status=404)
    return web.Response(
        body=buf.read(), content_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=86400"},
    )


# ---------------------------------------------------------------------------
# PAUSE MOMENTS — стена постов клиентов. Читать и писать (пост/комментарий)
# может любой зарегистрированный клиент, удалять — только админ.
# ---------------------------------------------------------------------------

def _is_any_admin(request: web.Request) -> bool:
    return bool(request["is_main_admin"] or request["pa_finance"] or request["pa_debtors"] or request["pa_menu"])


def _require_any_admin(request: web.Request):
    if not _is_any_admin(request):
        raise web.HTTPForbidden(text=json.dumps({"error": "forbidden"}), content_type="application/json")


def _moment_out(p: dict) -> dict:
    return {
        "id": p["id"], "ts": p["ts"], "tg_id": p["tg_id"], "name": p["name"], "text": p["text"],
        "image_urls": ["/pauseapp/api/feed/image/" + fid for fid in p.get("file_ids", [])],
        "comment_count": p.get("comment_count", 0),
        "like_count": p.get("like_count", 0), "liked": bool(p.get("liked")),
    }


async def api_moments_list(request: web.Request):
    posts = await _retry_sheets(sheets.get_moments, 50, request["tg_id"])
    return web.json_response({"posts": [_moment_out(p) for p in posts]})


async def api_moments_publish(request: web.Request):
    """multipart: text, photo (0..MOMENT_MAX_PHOTOS). Имя автора — из его
    профиля клиента на сервере, а не из запроса."""
    client = await _retry_sheets(sheets.find_client_by_tg_id, request["tg_id"])
    if not client:
        return web.json_response({"error": "not_registered"}, status=403)
    text = ""
    photos = []
    reader = await request.multipart()
    async for field in reader:
        if field.name == "text":
            text = (await field.text()).strip()
        elif field.name == "photo" and len(photos) < config.MOMENT_MAX_PHOTOS:
            data = await field.read(decode=False)
            if data:
                if len(data) > MAX_SCREENSHOT_BYTES:
                    return web.json_response({"error": "too_large"}, status=400)
                photos.append((data, field.filename or "moment.jpg"))
    text = text[:config.MOMENT_MAX_TEXT]
    if not text and not photos:
        return web.json_response({"error": "empty"}, status=400)
    file_ids = []
    if photos:
        if not config.MEDIA_CHAT_ID:
            return web.json_response({"error": "media_chat_not_configured"}, status=503)
        bot = request.app.get("bot")
        if not bot:
            return web.json_response({"error": "bot_unavailable"}, status=503)
        try:
            for data, filename in photos:
                msg = await bot.send_photo(int(config.MEDIA_CHAT_ID), BufferedInputFile(data, filename=filename))
                file_ids.append(msg.photo[-1].file_id)
        except Exception:
            logger.exception("PAUSE App: не удалось загрузить фото момента в канал")
            return web.json_response({"error": "upload_failed"}, status=502)
    post = await _retry_sheets(sheets.create_moment, request["tg_id"], client.get("name", ""), text, file_ids)
    post["comment_count"] = 0
    return web.json_response({"ok": True, "post": _moment_out(post)})


async def api_moments_delete(request: web.Request):
    _require_any_admin(request)
    body = await request.json()
    await _retry_sheets(sheets.delete_moment, (body.get("id") or "").strip())
    return web.json_response({"ok": True})


def _comment_out(c: dict) -> dict:
    return {"id": c["id"], "ts": c["ts"], "tg_id": c["tg_id"], "name": c["name"], "text": c["text"]}


async def api_moment_comments_list(request: web.Request):
    items = await _retry_sheets(sheets.get_moment_comments, request.match_info["post_id"])
    return web.json_response({"comments": [_comment_out(c) for c in items]})


async def api_moment_comment_add(request: web.Request):
    client = await _retry_sheets(sheets.find_client_by_tg_id, request["tg_id"])
    if not client:
        return web.json_response({"error": "not_registered"}, status=403)
    body = await request.json()
    text = (body.get("text") or "").strip()[:config.MOMENT_MAX_COMMENT]
    if not text:
        return web.json_response({"error": "empty"}, status=400)
    post_id = request.match_info["post_id"]
    c = await _retry_sheets(sheets.add_moment_comment, post_id, request["tg_id"], client.get("name", ""), text)
    # Уведомление автору поста в колокольчик приложения (не себе самому).
    try:
        author = await _retry_sheets(sheets.get_moment_author, post_id)
        if author and author != str(request["tg_id"]):
            snippet = text if len(text) <= 80 else text[:77] + "…"
            await _retry_sheets(
                sheets.create_app_notification, author,
                f"{client.get('name') or 'Кто-то'} прокомментировал(а) ваш момент: «{snippet}»",
                f"moment_comment:{post_id}",
            )
    except Exception:
        logger.exception("PAUSE App: не удалось записать уведомление о комментарии (post=%s)", post_id)
    return web.json_response({"ok": True, "comment": _comment_out(c)})


async def api_moment_like(request: web.Request):
    liked, count = await _retry_sheets(sheets.toggle_moment_like, request.match_info["post_id"], request["tg_id"])
    return web.json_response({"liked": liked, "like_count": count})


async def api_moment_comment_delete(request: web.Request):
    _require_any_admin(request)
    body = await request.json()
    await _retry_sheets(sheets.delete_moment_comment, (body.get("id") or "").strip())
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# Операционный центр — экран "Профиль → Операционный центр", пока только
# обзор/заказы (этап 1). Отдельного гейта на доступ НЕТ и не нужен — весь
# PAUSE App уже закрыт admin_auth_middleware (см. начало файла), этот
# раздел ничем не отличается от остальных /api/* в этом плане.
# ---------------------------------------------------------------------------

def _ops_date_range(request: web.Request):
    """?from=ДД.ММ.ГГГГ&to=ДД.ММ.ГГГГ — обе обязательны (экран сам всегда
    их шлёт, готовые под выбранный период/диапазон). None, если формат не
    распознан; переставляет местами, если from случайно позже to."""
    date_from = (request.query.get("from") or "").strip()
    date_to = (request.query.get("to") or "").strip()
    try:
        d1 = dt.datetime.strptime(date_from, "%d.%m.%Y")
        d2 = dt.datetime.strptime(date_to, "%d.%m.%Y")
    except ValueError:
        return None
    if d1 > d2:
        date_from, date_to = date_to, date_from
    return date_from, date_to


def _ops_order_key(item: dict):
    """Один заказ — (дата, batch); у строк без batch (дооформленные до
    появления batch_id) группируем по (дата, клиент) — та же идея, что и
    sheets.get_client_order_groups, только не на одного клиента, а на
    весь лист сразу."""
    if item["batch"]:
        return ("b", item["date"], item["batch"])
    return ("c", item["date"], item["client_id"])


async def api_ops_summary(request: web.Request):
    if not request["pa_finance"]:
        return web.json_response({"error": "forbidden"}, status=403)
    rng = _ops_date_range(request)
    if not rng:
        return web.json_response({"error": "bad_range"}, status=400)
    date_from, date_to = rng
    # "Финансы" — самый "тяжёлый" экран по числу обращений к Sheets за один
    # показ (несколько листов разом, см. ниже) — retries/delay подняты
    # против дефолтных (2/1.2с), чтобы пережить кратковременный 429 от
    # Google (лимит запросов в минуту) не падая в server_error у админа.
    items = await _retry_sheets(sheets.get_orders_in_range, date_from, date_to, retries=3, delay=1.5)
    margins = await _retry_sheets(sheets.get_set_margins, retries=3, delay=1.5)

    revenue = 0
    profit = 0
    by_set = {}    # ключ — КЛИЕНТСКОЕ название (display_name), не сырое из
                   # "Заказы": по прямой просьбе везде показываем то же
                   # имя, что видит клиент; "Самса"/"Самса без компота"
                   # (разные строки в таблице, одно клиентское имя
                   # "Пауза дуо." — см. texts.SET_DISPLAY_NAMES) из-за
                   # этого корректно складываются в одну строку отчёта.
    by_zone = {}
    people = {}    # ключ — client_id
    for i in items:
        key = _ops_order_key(i)
        revenue += i["sum"]
        item_profit = margins.get(i["set"], 0) * i["qty"]
        profit += item_profit

        display_name = sheets.display_set_name(i["set"])
        s = by_set.setdefault(display_name, {"display_name": display_name, "qty": 0, "revenue": 0, "profit": 0})
        s["qty"] += i["qty"]
        s["revenue"] += i["sum"]
        s["profit"] += item_profit

        zone = i["zone"] or "—"
        z = by_zone.setdefault(zone, {"zone": zone, "revenue": 0, "_orders": set()})
        z["_orders"].add(key)
        z["revenue"] += i["sum"]

        p = people.setdefault(i["client_id"], {"client_id": i["client_id"], "name": i["name"], "sets": {}})
        p["sets"][display_name] = p["sets"].get(display_name, 0) + i["qty"]

    total_qty = sum(s["qty"] for s in by_set.values())
    by_set_list = sorted(
        [
            dict(
                s,
                pct=round(s["qty"] / total_qty * 100, 1) if total_qty else 0,
                kitchen=s["revenue"] - s["profit"],
            )
            for s in by_set.values()
        ],
        key=lambda x: -x["qty"],
    )
    by_zone_list = sorted(
        [{"zone": z["zone"], "order_count": len(z["_orders"]), "revenue": z["revenue"]} for z in by_zone.values()],
        key=lambda x: -x["revenue"],
    )
    people_list = sorted(
        [
            {
                "client_id": p["client_id"], "name": p["name"],
                "sets": [{"display_name": k, "qty": v} for k, v in p["sets"].items()],
            }
            for p in people.values()
        ],
        key=lambda x: x["name"],
    )

    kitchen = revenue - profit
    # "Доставка" в "Чистая прибыль" — два слагаемых, оба вводятся в Mini
    # App "Маршрут" ("Профиль" → "Расходы на логистику", см.
    # webapp.api_logistics_set): расходы на сторонние сервисы (Яндекс,
    # Uklon и т.п.) + оплата за смену всем курьерам. Раньше учитывалась
    # только первая часть — поймано на реальном примере (оплата курьеру
    # не прибавлялась к расходу на доставку) и исправлено.
    delivery_services_cost = await _retry_sheets(sheets.get_delivery_expense_total, date_from, date_to, retries=3, delay=1.5)
    couriers_cost = await _retry_sheets(sheets.get_logistics_expense_total, date_from, date_to, retries=3, delay=1.5)
    delivery_cost = delivery_services_cost + couriers_cost
    net_profit = profit - delivery_cost

    # Маржа — для маленькой строки под "Валовая прибыль"/"Чистая прибыль"
    # в карточках (см. pauseapp_static/app.js: opsStatTile). Сама сумма
    # прибыли не меняется, это чисто производный процент от выручки за
    # тот же период.
    profit_margin_pct = round(profit / revenue * 100) if revenue else 0
    net_margin_pct = round(net_profit / revenue * 100) if revenue else 0

    return web.json_response({
        "date_from": date_from, "date_to": date_to,
        # "заказов" считаем по количеству проданных сетов (штук), а не по
        # числу оформленных заказов — так попросил админ.
        "order_count": total_qty, "revenue": revenue, "profit": profit,
        "kitchen": kitchen, "delivery_cost": delivery_cost, "net_profit": net_profit,
        "profit_margin_pct": profit_margin_pct, "net_margin_pct": net_margin_pct,
        "people_count": len(people_list),
        "by_set": by_set_list, "by_zone": by_zone_list, "people": people_list,
    })


async def api_ops_orders(request: web.Request):
    if not request["pa_finance"]:
        return web.json_response({"error": "forbidden"}, status=403)
    rng = _ops_date_range(request)
    if not rng:
        return web.json_response({"error": "bad_range"}, status=400)
    date_from, date_to = rng
    set_filter = (request.query.get("set") or "").strip()
    zone_filter = (request.query.get("zone") or "").strip()
    status_filter = (request.query.get("status") or "").strip()  # "" | paid | unpaid | review
    q = (request.query.get("q") or "").strip().lower()

    # retries/delay подняты, как и в api_ops_summary (см. там) — тот же
    # "тяжёлый" экран "Финансы", этот запрос обычно уходит почти
    # одновременно с ним (см. pauseapp_static/app.js: Promise.all).
    items = await _retry_sheets(sheets.get_orders_in_range, date_from, date_to, retries=3, delay=1.5)

    groups = {}
    order = []
    for i in items:
        key = _ops_order_key(i)
        if key not in groups:
            groups[key] = {
                "date": i["date"], "zone": i["zone"], "point": i["point"],
                "client_id": i["client_id"], "name": i["name"],
                "payment_raw": i["payment_raw"], "pay_status": i["pay_status"],
                "items": [], "sum": 0,
            }
            order.append(key)
        g = groups[key]
        g["items"].append({"set": i["set"], "display_name": sheets.display_set_name(i["set"]), "qty": i["qty"], "garnish": i["garnish"]})
        g["sum"] += i["sum"]

    out = []
    for key in order:
        g = groups[key]
        if zone_filter and g["zone"] != zone_filter:
            continue
        if status_filter and g["pay_status"] != status_filter:
            continue
        if set_filter and not any(it["display_name"] == set_filter for it in g["items"]):
            continue
        if q and q not in g["name"].lower():
            continue
        out.append(g)

    # От новых к старым — по дате (ДД.ММ.ГГГГ сортируется только через
    # разбор, не лексикографически).
    out.sort(key=lambda g: dt.datetime.strptime(g["date"], "%d.%m.%Y"), reverse=True)

    return web.json_response({"date_from": date_from, "date_to": date_to, "orders": out})


# ---------------------------------------------------------------------------
# Операционный центр → Должники. Сам долг по-прежнему из "Заказы"
# (sheets.get_all_debtors/get_debtor_lines) — комментарии и напоминания
# в отдельных листах, бот заводит их сам при первом обращении
# (см. sheets._ws_or_create).
# ---------------------------------------------------------------------------

async def api_ops_debtors(request: web.Request):
    if not request["pa_debtors"]:
        return web.json_response({"error": "forbidden"}, status=403)
    # Больше НЕ чистим автоматически: клиент, закрывший весь долг, должен
    # остаться виден в списке (с суммой 0, в самом низу — см.
    # sheets.get_all_debtors) до тех пор, пока админ сам явно не нажмёт
    # "Удалить историю долгов" на его карточке (прямая просьба).
    debtors = await _retry_sheets(sheets.get_all_debtors)
    return web.json_response({"debtors": debtors})


async def api_ops_delivery(request: web.Request):
    """Экран "Доставки": начислено/оплачено/в долге по платной доставке
    за период (по умолчанию — сегодня) и список заказов с доставкой."""
    if not (request["is_main_admin"] or request["pa_finance"] or request["pa_debtors"]):
        return web.json_response({"error": "forbidden"}, status=403)
    today = sheets.today_date_str()
    d_from = (request.query.get("from") or today).strip()
    d_to = (request.query.get("to") or d_from).strip()
    data = await _retry_sheets(sheets.get_delivery_overview, d_from, d_to)
    return web.json_response(data)


async def api_ops_debtor_detail(request: web.Request):
    if not request["pa_debtors"]:
        return web.json_response({"error": "forbidden"}, status=403)
    client_id = request.match_info.get("client_id", "")
    client = await _retry_sheets(sheets.get_client_by_id, client_id)
    lines = await _retry_sheets(sheets.get_debtor_lines, client_id)
    comments = await _retry_sheets(sheets.get_debt_comments, client_id)
    reminders = await _retry_sheets(sheets.get_debt_reminders, client_id)

    lines_out = [
        {
            "row": l["row"], "date": l["date"], "set": l["set"],
            "display_name": sheets.display_set_name(l["set"]), "qty": l["qty"],
            "sum": l["sum"], "delivery": l.get("delivery", 0), "resolved": l["resolved"],
        }
        for l in lines
    ]
    # "Написать" — ЮЗЕРНЕЙМ в приоритете: https://t.me/<юзернейм> открывается
    # через WebApp.openTelegramLink (см. app.js: openTelegramChat) —
    # надёжно работает из Mini App на всех платформах. tg://user?id=... —
    # запасной вариант только если юзернейма нет вообще: это НЕ надёжная
    # ссылка (резолвится только если Telegram-клиент уже знает этот ID из
    # прошлого контакта/группы), раньше стояла первым приоритетом и из-за
    # этого "Написать" у клиентов с известным юзернеймом молча ничего не
    # делала — воспроизведено и подтверждено. Ни юзернейма, ни tg_id нет —
    # кнопка неактивна на фронте.
    tg_id = (client or {}).get("tg_id", "")
    telegram_username = ((client or {}).get("telegram") or "").strip().lstrip("@")
    if telegram_username:
        tg_link = f"https://t.me/{telegram_username}"
    elif tg_id:
        tg_link = f"tg://user?id={tg_id}"
    else:
        tg_link = ""
    return web.json_response({
        "client_id": client_id,
        "name": (client or {}).get("name") or client_id,
        "phone": (client or {}).get("contact", ""),
        "telegram": (client or {}).get("telegram", ""),
        "tg_link": tg_link,
        # Итог — только НЕпогашенные строки (та же сумма, что покажет
        # список должников), погашенные дни остаются в lines для истории,
        # но в долг больше не идут.
        "total": sum(l["sum"] for l in lines if not l["resolved"]),
        "all_resolved": bool(lines) and all(l["resolved"] for l in lines),
        "lines": lines_out,
        "comments": comments,
        "reminders": reminders,
    })


async def api_ops_debtor_comment(request: web.Request):
    if not request["pa_debtors"]:
        return web.json_response({"error": "forbidden"}, status=403)
    client_id = request.match_info.get("client_id", "")
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        return web.json_response({"error": "text_required"}, status=400)
    await _retry_sheets(sheets.add_debt_comment, client_id, text)
    comments = await _retry_sheets(sheets.get_debt_comments, client_id)
    return web.json_response({"comments": comments})


async def api_ops_debtor_reminder_set(request: web.Request):
    if not request["pa_debtors"]:
        return web.json_response({"error": "forbidden"}, status=403)
    client_id = request.match_info.get("client_id", "")
    body = await request.json()
    date_str = (body.get("date") or "").strip()
    note = (body.get("note") or "").strip()
    try:
        dt.datetime.strptime(date_str, "%d.%m.%Y")
    except ValueError:
        return web.json_response({"error": "bad_date"}, status=400)
    await _retry_sheets(sheets.set_debt_reminder, client_id, date_str, note)
    reminders = await _retry_sheets(sheets.get_debt_reminders, client_id)
    return web.json_response({"reminders": reminders})


async def api_ops_debtor_reminder_delete(request: web.Request):
    if not request["pa_debtors"]:
        return web.json_response({"error": "forbidden"}, status=403)
    client_id = request.match_info.get("client_id", "")
    body = await request.json()
    row = body.get("row")
    if not isinstance(row, int):
        return web.json_response({"error": "row_required"}, status=400)
    await _retry_sheets(sheets.delete_debt_reminder, row)
    reminders = await _retry_sheets(sheets.get_debt_reminders, client_id)
    return web.json_response({"reminders": reminders})


async def api_ops_debtor_line_pay(request: web.Request):
    if not request["pa_debtors"]:
        return web.json_response({"error": "forbidden"}, status=403)
    client_id = request.match_info.get("client_id", "")
    body = await request.json()
    row = body.get("row")
    if not isinstance(row, int):
        return web.json_response({"error": "row_required"}, status=400)
    await _retry_sheets(sheets.mark_debt_line_paid, row)
    lines = await _retry_sheets(sheets.get_debtor_lines, client_id)
    return web.json_response({
        "lines": [
            {"row": l["row"], "date": l["date"], "set": l["set"], "display_name": sheets.display_set_name(l["set"]),
             "qty": l["qty"], "sum": l["sum"], "resolved": l["resolved"]}
            for l in lines
        ],
        "total": sum(l["sum"] for l in lines if not l["resolved"]),
        "all_resolved": bool(lines) and all(l["resolved"] for l in lines),
    })


async def api_ops_debtor_lines_pay(request: web.Request):
    """Пакетная версия api_ops_debtor_line_pay — отмечает оплаченными
    сразу несколько дней долга (галочки + кнопка "Оплатить отмеченные",
    либо "Закрыть весь долг" со всеми непогашенными row разом)."""
    if not request["pa_debtors"]:
        return web.json_response({"error": "forbidden"}, status=403)
    client_id = request.match_info.get("client_id", "")
    body = await request.json()
    rows = body.get("rows")
    if not isinstance(rows, list) or not rows or not all(isinstance(r, int) for r in rows):
        return web.json_response({"error": "rows_required"}, status=400)
    await _retry_sheets(sheets.mark_debt_lines_paid, rows)
    lines = await _retry_sheets(sheets.get_debtor_lines, client_id)
    return web.json_response({
        "lines": [
            {"row": l["row"], "date": l["date"], "set": l["set"], "display_name": sheets.display_set_name(l["set"]),
             "qty": l["qty"], "sum": l["sum"], "resolved": l["resolved"]}
            for l in lines
        ],
        "total": sum(l["sum"] for l in lines if not l["resolved"]),
        "all_resolved": bool(lines) and all(l["resolved"] for l in lines),
    })


async def api_ops_debtor_line_unpay(request: web.Request):
    if not request["pa_debtors"]:
        return web.json_response({"error": "forbidden"}, status=403)
    client_id = request.match_info.get("client_id", "")
    body = await request.json()
    row = body.get("row")
    if not isinstance(row, int):
        return web.json_response({"error": "row_required"}, status=400)
    await _retry_sheets(sheets.unmark_debt_line_paid, row)
    lines = await _retry_sheets(sheets.get_debtor_lines, client_id)
    return web.json_response({
        "lines": [
            {"row": l["row"], "date": l["date"], "set": l["set"], "display_name": sheets.display_set_name(l["set"]),
             "qty": l["qty"], "sum": l["sum"], "resolved": l["resolved"]}
            for l in lines
        ],
        "total": sum(l["sum"] for l in lines if not l["resolved"]),
        "all_resolved": bool(lines) and all(l["resolved"] for l in lines),
    })


async def api_ops_debtor_delete_history(request: web.Request):
    if not request["pa_debtors"]:
        return web.json_response({"error": "forbidden"}, status=403)
    client_id = request.match_info.get("client_id", "")
    ok = await _retry_sheets(sheets.delete_debtor_history, client_id)
    if not ok:
        return web.json_response({"error": "still_has_debt"}, status=409)
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# Операционный центр → Розыгрыш "Пауза в подарок" (доступ как у "Финансы" —
# pa_finance: начисление бесплатных сетов — это расходы бренда, тот же
# контур ответственности). Полная история победителей + потрачен ли билет
# или нет (см. sheets.get_all_tickets).
# ---------------------------------------------------------------------------

async def api_ops_giveaway(request: web.Request):
    if not request["pa_finance"]:
        return web.json_response({"error": "forbidden"}, status=403)
    tickets = await _retry_sheets(sheets.get_all_tickets)
    return web.json_response({"tickets": tickets})


# ---------------------------------------------------------------------------
# Операционный центр → Меню → "Карточки сетов" (доступ — pa_menu, см.
# admin_auth_middleware). Постоянные catalog-атрибуты КАЖДОГО сета — фото,
# описание, доступен ли гарнир в принципе, кастомное клиентское имя — то,
# что раньше можно было задать только через бот ("/admin → 🖼 Фото блюд" /
# "✉️ Описание блюд") или вообще только вручную в самой таблице (гарнир
# Да/Нет). НЕ часть черновика/публикации меню (см. раздел ниже) — эти
# атрибуты живут сами по себе, день в день, пока админ их не поменяет.
# ---------------------------------------------------------------------------

async def _catalog_overview() -> list:
    """Один элемент на карточку — группа переменной цены (config.
    SET_VARIANTS) одной строкой с несколькими ценами внутри, обычный сет —
    отдельной строкой. Чистая функция поверх уже прочитанных данных (та же
    дисциплина, что и в _serialize_sets) — display_name считаем тут же, не
    через sheets.display_set_name в цикле, чтобы не плодить по одному
    обращению к Sheets на каждый сет каталога."""
    sets = await _retry_sheets(sheets.get_sets)
    prices = await _retry_sheets(sheets.get_set_prices)
    sets_with_garnish = await _retry_sheets(sheets.get_sets_with_garnish)
    extra = await _retry_sheets(sheets.get_set_extra)
    overrides = await _retry_sheets(sheets.get_set_display_name_overrides)

    def _name(n):
        return overrides.get(n) or texts.SET_DISPLAY_NAMES.get(n, n)

    items = []
    seen_groups = set()
    for name in sets:
        group = config.SET_VARIANT_GROUP.get(name)
        if group:
            if group in seen_groups:
                continue
            seen_groups.add(group)
            technicals = [t for t, _ in config.SET_VARIANTS[group]]
            first_extra = extra.get(technicals[0], {})
            items.append({
                "key": group, "is_group": True, "technical_names": technicals,
                "display_name": _name(group),
                "prices": {t: prices.get(t, 0) for t in technicals},
                "has_garnish": technicals[0].strip().lower() in sets_with_garnish,
                "photo_url": _resolve_photo_url(first_extra.get("photo_url", "")),
                "description": first_extra.get("description", ""),
            })
        else:
            e = extra.get(name, {})
            items.append({
                "key": name, "is_group": False, "technical_names": [name],
                "display_name": _name(name),
                "prices": {name: prices.get(name, 0)},
                "has_garnish": name.strip().lower() in sets_with_garnish,
                "photo_url": _resolve_photo_url(e.get("photo_url", "")),
                "description": e.get("description", ""),
            })
    return items


async def api_ops_menu_catalog(request: web.Request):
    if not request["pa_menu"]:
        return web.json_response({"error": "forbidden"}, status=403)
    items = await _catalog_overview()
    garnish_reference = await _retry_sheets(sheets.get_garnishes)
    return web.json_response({"sets": items, "garnish_reference": garnish_reference})


async def api_ops_menu_set_photo(request: web.Request):
    """multipart: photo (одно фото) — как бот ("🖼 Фото блюд"), только из
    Mini App: ре-загружаем в MEDIA_CHAT_ID (как фото ленты CLUB, см.
    api_feed_publish), а не храним голый file_id напрямую из chat-сообщения
    — тот же приём для устойчивого file_id, уже используемый везде, где
    фото загружают из самого приложения."""
    if not request["pa_menu"]:
        return web.json_response({"error": "forbidden"}, status=403)
    set_key = request.match_info.get("set_key", "")
    if not set_key:
        return web.json_response({"error": "set_required"}, status=400)
    if not config.MEDIA_CHAT_ID:
        return web.json_response({"error": "media_chat_not_configured"}, status=503)
    bot = request.app.get("bot")
    if not bot:
        return web.json_response({"error": "bot_unavailable"}, status=503)

    reader = await request.multipart()
    field = await reader.next()
    if field is None or field.name != "photo":
        return web.json_response({"error": "photo_required"}, status=400)
    data = await field.read(decode=False)
    if not data:
        return web.json_response({"error": "photo_required"}, status=400)
    if len(data) > MAX_SCREENSHOT_BYTES:
        return web.json_response({"error": "too_large"}, status=400)

    try:
        msg = await bot.send_photo(int(config.MEDIA_CHAT_ID), BufferedInputFile(data, filename=field.filename or "set.jpg"))
    except Exception:
        logger.exception("PAUSE App: не удалось загрузить фото сета в канал (set=%s)", set_key)
        return web.json_response({"error": "upload_failed"}, status=502)

    file_id = msg.photo[-1].file_id
    await _retry_sheets(sheets.set_set_photo, set_key, file_id)
    return web.json_response({"ok": True, "photo_url": _resolve_photo_url(file_id)})


async def api_ops_menu_set_description(request: web.Request):
    if not request["pa_menu"]:
        return web.json_response({"error": "forbidden"}, status=403)
    set_key = request.match_info.get("set_key", "")
    if not set_key:
        return web.json_response({"error": "set_required"}, status=400)
    body = await request.json()
    description = (body.get("description") or "").strip()
    await _retry_sheets(sheets.set_set_description, set_key, description)
    return web.json_response({"ok": True})


async def api_ops_menu_set_garnish_flag(request: web.Request):
    if not request["pa_menu"]:
        return web.json_response({"error": "forbidden"}, status=403)
    set_key = request.match_info.get("set_key", "")
    if not set_key:
        return web.json_response({"error": "set_required"}, status=400)
    body = await request.json()
    enabled = bool(body.get("enabled"))
    await _retry_sheets(sheets.set_set_garnish_flag, set_key, enabled)
    return web.json_response({"ok": True})


async def api_ops_menu_set_display_name(request: web.Request):
    if not request["pa_menu"]:
        return web.json_response({"error": "forbidden"}, status=403)
    set_key = request.match_info.get("set_key", "")
    if not set_key:
        return web.json_response({"error": "set_required"}, status=400)
    body = await request.json()
    display_name = (body.get("display_name") or "").strip()
    await _retry_sheets(sheets.set_set_display_name, set_key, display_name)
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# Операционный центр → Меню → "Меню дня" (доступ — pa_menu). Черновик,
# готовится ДО публикации, ровно та же механика и те же ячейки черновика
# (K1/K2/K8/столбец L в "Справочники"), что и у бота — см. handlers/
# admin.py: AdminMenu FSM, sheets.start_new_menu_draft/set_draft_sets/
# set_draft_garnishes_for_set/publish_draft_menu. Mini App — просто другой
# интерфейс поверх ТЕХ ЖЕ данных: если координатор начнёт черновик в чате
# бота, а потом откроет "Меню дня" в приложении, увидит тот же черновик (и
# наоборот) — состояние общее, не раздельное.
# ---------------------------------------------------------------------------

async def api_ops_menu_draft(request: web.Request):
    if not request["pa_menu"]:
        return web.json_response({"error": "forbidden"}, status=403)
    photo_ids, caption = await _retry_sheets(sheets.get_draft_menu)
    selected_keys = await _retry_sheets(sheets.get_draft_sets_raw)
    catalog = await _catalog_overview()
    catalog_by_key = {c["key"]: c for c in catalog}

    garnish = {}
    for key in selected_keys:
        c = catalog_by_key.get(key)
        if c and c["has_garnish"]:
            garnish[key] = await _retry_sheets(sheets.get_draft_garnishes_for_set, key)

    active_date = await _retry_sheets(sheets.get_active_menu_date)
    garnish_reference = await _retry_sheets(sheets.get_garnishes)
    return web.json_response({
        "photo_urls": [_resolve_photo_url(fid) for fid in photo_ids],
        "caption": caption,
        "selected_keys": selected_keys,
        "garnish": garnish,
        "catalog": catalog,
        "garnish_reference": garnish_reference,
        "active_menu_date": active_date,
    })


async def api_ops_menu_draft_new(request: web.Request):
    """Полный сброс черновика — та же точка входа, что "координатор
    прислал новое фото" в боте (см. sheets.start_new_menu_draft: фото/
    текст/сеты/гарниры черновика все на "не заданы"). Активное
    (клиентское) меню не трогает вообще."""
    if not request["pa_menu"]:
        return web.json_response({"error": "forbidden"}, status=403)
    await _retry_sheets(sheets.start_new_menu_draft, [], "")
    return web.json_response({"ok": True})


async def api_ops_menu_draft_sets(request: web.Request):
    if not request["pa_menu"]:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    sets = body.get("sets")
    if not isinstance(sets, list):
        return web.json_response({"error": "bad_sets"}, status=400)
    clean = [str(s).strip() for s in sets if str(s).strip()]
    await _retry_sheets(sheets.set_draft_sets, clean)
    return web.json_response({"ok": True})


async def api_ops_menu_draft_garnish(request: web.Request):
    if not request["pa_menu"]:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    set_key = (body.get("set") or "").strip()
    if not set_key:
        return web.json_response({"error": "set_required"}, status=400)
    garnishes = body.get("garnishes")
    if not isinstance(garnishes, list):
        return web.json_response({"error": "bad_garnishes"}, status=400)
    clean = [str(g).strip() for g in garnishes if str(g).strip()]
    await _retry_sheets(sheets.set_draft_garnishes_for_set, set_key, clean)
    return web.json_response({"ok": True})


async def api_ops_menu_draft_photo(request: web.Request):
    """multipart: 0+ полей "photo" (новый набор фото объявления — ПОЛНОСТЬЮ
    заменяет прежний, если хоть одно фото прислано; если ни одного — старые
    фото остаются как есть, трогаем только подпись), "caption" (текст,
    опционально — если поле не прислано, подпись остаётся прежней),
    "clear_photos"="1" — явно стереть фото (отдельно от "не присылать
    новых"). Та же логика ре-загрузки в MEDIA_CHAT_ID, что у "Карточки
    сетов"/ленты CLUB."""
    if not request["pa_menu"]:
        return web.json_response({"error": "forbidden"}, status=403)

    photos = []
    caption = None
    clear_photos = False
    reader = await request.multipart()
    async for field in reader:
        if field.name == "photo":
            data = await field.read(decode=False)
            if data:
                if len(data) > MAX_SCREENSHOT_BYTES:
                    return web.json_response({"error": "too_large"}, status=400)
                photos.append((data, field.filename or "menu.jpg"))
        elif field.name == "caption":
            caption = await field.text()
        elif field.name == "clear_photos":
            clear_photos = (await field.text()).strip() == "1"

    existing_ids, existing_caption = await _retry_sheets(sheets.get_draft_menu)
    if caption is None:
        caption = existing_caption

    photo_ids = existing_ids
    if clear_photos:
        photo_ids = []
    if photos:
        if not config.MEDIA_CHAT_ID:
            return web.json_response({"error": "media_chat_not_configured"}, status=503)
        bot = request.app.get("bot")
        if not bot:
            return web.json_response({"error": "bot_unavailable"}, status=503)
        new_ids = []
        try:
            for data, filename in photos:
                msg = await bot.send_photo(int(config.MEDIA_CHAT_ID), BufferedInputFile(data, filename=filename))
                new_ids.append(msg.photo[-1].file_id)
        except Exception:
            logger.exception("PAUSE App: не удалось загрузить фото черновика меню в канал")
            return web.json_response({"error": "upload_failed"}, status=502)
        photo_ids = new_ids

    await _retry_sheets(sheets.set_draft_menu, photo_ids, caption)
    return web.json_response({
        "ok": True, "caption": caption,
        "photo_urls": [_resolve_photo_url(fid) for fid in photo_ids],
    })


async def _broadcast_new_menu_from_app(bot):
    """Точная копия handlers/admin.py:_broadcast_new_menu — своя копия, а
    не импорт из handlers.admin, чтобы не тащить в pauseapp.py чужие
    зависимости того модуля (например pdf_report) только ради одной
    функции рассылки."""
    for c in await _retry_sheets(sheets.get_broadcast_clients):
        if c.get("notify_menu_off"):
            continue
        try:
            greeting = texts.NEW_MENU_GREETING.format(name=c.get("name") or "")
            await bot.send_message(int(c["tg_id"]), greeting, reply_markup=kb.menu_broadcast_kb())
        except Exception:
            logger.exception("PAUSE App: не удалось отправить оповещение о новом меню клиенту ID %s", c.get("id"))
        await asyncio.sleep(config.BROADCAST_DELAY_SECONDS)


async def api_ops_menu_draft_publish(request: web.Request):
    """Единственный шаг, переносящий черновик в активные ячейки (см.
    sheets.publish_draft_menu) — до этого клиенты продолжают видеть
    предыдущее опубликованное меню. Рассылка клиентам (как в боте, см.
    _broadcast_new_menu_from_app) запускается ФОНОВОЙ задачей, а не
    ожидается внутри самого запроса — иначе админ сидел бы с крутящимся
    спиннером в приложении, пока бот по очереди пишет каждому клиенту
    (может быть десятки секунд и больше на большой базе)."""
    if not request["pa_menu"]:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    date_str = (body.get("date") or "").strip()
    if not date_str:
        return web.json_response({"error": "date_required"}, status=400)

    await _retry_sheets(sheets.publish_draft_menu, date_str)

    bot = request.app.get("bot")
    will_broadcast = bool(bot) and not await _retry_sheets(sheets.is_broadcasts_disabled)
    if will_broadcast:
        asyncio.create_task(_broadcast_new_menu_from_app(bot))

    return web.json_response({"ok": True, "date": date_str, "broadcasted": will_broadcast})


# ---------------------------------------------------------------------------
# Операционный центр → Администраторы (только главный админ — ADMIN_IDS).
# Даёт/забирает делегированным админам доступ к "Финансы"/"Должники" —
# см. admin_auth_middleware (request["is_main_admin"]/["pa_finance"]/
# ["pa_debtors"]) и sheets.get_pause_admins/add_pause_admin/
# set_pause_admin_feature/remove_pause_admin.
# ---------------------------------------------------------------------------

async def api_pause_admins_list(request: web.Request):
    if not request["is_main_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    admins = await _retry_sheets(sheets.get_pause_admins)
    return web.json_response({"admins": admins})


async def api_pause_admins_add(request: web.Request):
    if not request["is_main_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    tg_id = (str(body.get("tg_id") or "")).strip()
    name = (body.get("name") or "").strip()
    if not tg_id or not tg_id.lstrip("-").isdigit():
        return web.json_response({"error": "bad_tg_id"}, status=400)
    await _retry_sheets(sheets.add_pause_admin, tg_id, name)
    admins = await _retry_sheets(sheets.get_pause_admins)
    return web.json_response({"admins": admins})


async def api_pause_admins_feature(request: web.Request):
    if not request["is_main_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    tg_id = request.match_info.get("tg_id", "")
    body = await request.json()
    feature = (body.get("feature") or "").strip()
    if feature not in ("finance", "debtors", "menu"):
        return web.json_response({"error": "bad_feature"}, status=400)
    allowed = bool(body.get("allowed"))
    await _retry_sheets(sheets.set_pause_admin_feature, tg_id, feature, allowed)
    admin = await _retry_sheets(sheets.get_pause_admin, tg_id)
    return web.json_response({"admin": admin})


async def api_pause_admins_remove(request: web.Request):
    if not request["is_main_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    tg_id = request.match_info.get("tg_id", "")
    await _retry_sheets(sheets.remove_pause_admin, tg_id)
    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# CRM (PAUSE App, Операционный центр → CRM) — "Клиенты" (учёт/фильтры/
# полная карточка) и "Лиды" (холодные/тёплые/дожим, комментарии,
# напоминания, перевод в "Продажа"). Строго is_main_admin — отдельного
# делегируемого права под CRM по прямой просьбе не заводили (в отличие
# от "Должники"/"Меню"), это инструмент только для владельца.
# ---------------------------------------------------------------------------

async def api_crm_clients(request: web.Request):
    if not request["is_main_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    clients = await _retry_sheets(sheets.get_crm_clients_list)
    return web.json_response({"clients": clients})


async def api_crm_client_detail(request: web.Request):
    if not request["is_main_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    client_id = request.match_info.get("client_id", "")
    profile = await _retry_sheets(sheets.get_client_full_profile, client_id)
    if not profile:
        return web.json_response({"error": "not_found"}, status=404)
    return web.json_response(profile)


async def api_crm_leads(request: web.Request):
    if not request["is_main_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    overview = await _retry_sheets(sheets.get_crm_leads_overview)
    return web.json_response(overview)


async def api_crm_stage_set(request: web.Request):
    if not request["is_main_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    client_id = request.match_info.get("client_id", "")
    body = await request.json()
    stage = (body.get("stage") or "").strip()
    if stage not in (config.CRM_STAGE_WARM, config.CRM_STAGE_DOZHIM, config.CRM_STAGE_SALE, config.CRM_STAGE_COLD):
        return web.json_response({"error": "bad_stage"}, status=400)
    await _retry_sheets(sheets.set_crm_stage, client_id, stage)
    return web.json_response({"stage": stage})


async def api_crm_comment_add(request: web.Request):
    if not request["is_main_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    client_id = request.match_info.get("client_id", "")
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        return web.json_response({"error": "text_required"}, status=400)
    await _retry_sheets(sheets.add_crm_comment, client_id, text)
    comments = await _retry_sheets(sheets.get_crm_comments, client_id)
    stage = await _retry_sheets(sheets.get_crm_stage, client_id)
    return web.json_response({"comments": comments, "stage": stage})


async def api_crm_reminder_set(request: web.Request):
    if not request["is_main_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    client_id = request.match_info.get("client_id", "")
    body = await request.json()
    date_str = (body.get("date") or "").strip()
    note = (body.get("note") or "").strip()
    try:
        dt.datetime.strptime(date_str, "%d.%m.%Y")
    except ValueError:
        return web.json_response({"error": "bad_date"}, status=400)
    await _retry_sheets(sheets.set_crm_reminder, client_id, date_str, note)
    reminders = await _retry_sheets(sheets.get_crm_reminders, client_id)
    stage = await _retry_sheets(sheets.get_crm_stage, client_id)
    return web.json_response({"reminders": reminders, "stage": stage})


async def api_crm_reminder_done(request: web.Request):
    if not request["is_main_admin"]:
        return web.json_response({"error": "forbidden"}, status=403)
    client_id = request.match_info.get("client_id", "")
    body = await request.json()
    row = body.get("row")
    if not isinstance(row, int):
        return web.json_response({"error": "row_required"}, status=400)
    await _retry_sheets(sheets.mark_crm_reminder_done, row)
    reminders = await _retry_sheets(sheets.get_crm_reminders, client_id)
    return web.json_response({"reminders": reminders})


# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Pause Club: карточки "Сейчас в клубе" (sheets.get_club_cards). Читать их
# может любой пользователь приложения, править — только главный админ
# ("Операционный центр" → "Управление Pause Club").
# ---------------------------------------------------------------------------

def _club_cards_payload(cards: list) -> dict:
    out = []
    for c in cards:
        d = dict(c)
        d["photo_url"] = _resolve_photo_url(d.pop("photo", ""))
        out.append(d)
    return {"cards": out}


async def api_club_cards(request: web.Request):
    cards = await _retry_sheets(sheets.get_club_cards)
    return web.json_response(_club_cards_payload(cards))


def _require_main_admin(request: web.Request):
    if not request["is_main_admin"]:
        raise web.HTTPForbidden(text=json.dumps({"error": "forbidden"}), content_type="application/json")


async def api_ops_club_cards_add(request: web.Request):
    _require_main_admin(request)
    body = await request.json() if request.can_read_body else {}
    cards = await _retry_sheets(sheets.add_club_card, (body.get("kind") or "custom"))
    return web.json_response(_club_cards_payload(cards))


async def api_ops_club_card_update(request: web.Request):
    _require_main_admin(request)
    body = await request.json()
    cards = await _retry_sheets(sheets.update_club_card, request.match_info["card_id"], body)
    return web.json_response(_club_cards_payload(cards))


async def api_ops_club_card_delete(request: web.Request):
    _require_main_admin(request)
    cards = await _retry_sheets(sheets.delete_club_card, request.match_info["card_id"])
    return web.json_response(_club_cards_payload(cards))


async def api_ops_club_card_move(request: web.Request):
    _require_main_admin(request)
    body = await request.json()
    cards = await _retry_sheets(sheets.move_club_card, request.match_info["card_id"], int(body.get("delta") or 0))
    return web.json_response(_club_cards_payload(cards))


async def api_ops_club_card_photo(request: web.Request):
    """multipart: photo — тот же приём, что у фото сета (api_ops_menu_set_photo):
    перезаливаем в MEDIA_CHAT_ID и храним устойчивый file_id."""
    _require_main_admin(request)
    if not config.MEDIA_CHAT_ID:
        return web.json_response({"error": "media_chat_not_configured"}, status=503)
    bot = request.app.get("bot")
    if not bot:
        return web.json_response({"error": "bot_unavailable"}, status=503)
    reader = await request.multipart()
    field = await reader.next()
    if field is None or field.name != "photo":
        return web.json_response({"error": "photo_required"}, status=400)
    data = await field.read(decode=False)
    if not data:
        return web.json_response({"error": "photo_required"}, status=400)
    if len(data) > MAX_SCREENSHOT_BYTES:
        return web.json_response({"error": "too_large"}, status=400)
    try:
        msg = await bot.send_photo(int(config.MEDIA_CHAT_ID), BufferedInputFile(data, filename=field.filename or "club.jpg"))
    except Exception:
        logger.exception("PAUSE App: не удалось загрузить фото карточки клуба в канал")
        return web.json_response({"error": "upload_failed"}, status=502)
    cards = await _retry_sheets(sheets.set_club_card_photo, request.match_info["card_id"], msg.photo[-1].file_id)
    return web.json_response(_club_cards_payload(cards))


async def api_ops_club_card_photo_delete(request: web.Request):
    _require_main_admin(request)
    cards = await _retry_sheets(sheets.set_club_card_photo, request.match_info["card_id"], "")
    return web.json_response(_club_cards_payload(cards))


def create_app(bot=None) -> web.Application:
    app = web.Application(middlewares=[error_middleware, admin_auth_middleware])
    app["bot"] = bot
    app.router.add_get("/", index_page)
    app.router.add_get("/point", point_map_page)
    app.router.add_static("/static/", STATIC_DIR, show_index=False)

    app.router.add_get("/api/me", api_me)
    app.router.add_get("/api/menu", api_menu)
    app.router.add_get("/api/zones", api_zones)
    app.router.add_get("/api/points", api_points)
    app.router.add_get("/api/delivery-points", api_delivery_points)
    app.router.add_get("/api/geocode", api_geocode)
    app.router.add_get("/api/reverse", api_reverse_geocode)
    app.router.add_post("/api/order", api_order_submit)
    app.router.add_post("/api/order/screenshot", api_upload_screenshot)
    app.router.add_get("/api/profile", api_profile)
    app.router.add_post("/api/profile", api_profile_edit)
    app.router.add_get("/api/notify", api_notify)
    app.router.add_post("/api/notify", api_notify_set)
    app.router.add_post("/api/account/delete-request", api_account_delete_request)
    app.router.add_get("/api/orders", api_orders)
    app.router.add_post("/api/orders/cancel", api_orders_cancel)
    app.router.add_post("/api/debt/pay", api_debt_pay)
    app.router.add_get("/api/favorites", api_favorites)
    app.router.add_post("/api/favorites/toggle", api_favorites_toggle)
    app.router.add_post("/api/feedback", api_feedback)
    app.router.add_get("/api/messages", api_messages)
    app.router.add_get("/api/care/pending", api_care_pending)
    app.router.add_post("/api/care/seen", api_care_seen)
    app.router.add_get("/api/club/leaderboard", api_club_leaderboard)
    app.router.add_get("/api/club/giveaway", api_club_giveaway)
    app.router.add_get("/api/club/cards", api_club_cards)
    app.router.add_post("/api/ops/club/cards", api_ops_club_cards_add)
    app.router.add_post("/api/ops/club/cards/{card_id}", api_ops_club_card_update)
    app.router.add_post("/api/ops/club/cards/{card_id}/delete", api_ops_club_card_delete)
    app.router.add_post("/api/ops/club/cards/{card_id}/move", api_ops_club_card_move)
    app.router.add_post("/api/ops/club/cards/{card_id}/photo", api_ops_club_card_photo)
    app.router.add_post("/api/ops/club/cards/{card_id}/photo/delete", api_ops_club_card_photo_delete)
    app.router.add_get("/api/bonuses", api_bonuses)
    app.router.add_get("/api/notifications", api_notifications)
    app.router.add_post("/api/notifications/read", api_notifications_read)
    app.router.add_get("/api/ops/giveaway", api_ops_giveaway)
    app.router.add_get("/api/ops/menu/catalog", api_ops_menu_catalog)
    app.router.add_post("/api/ops/menu/catalog/{set_key}/photo", api_ops_menu_set_photo)
    app.router.add_post("/api/ops/menu/catalog/{set_key}/description", api_ops_menu_set_description)
    app.router.add_post("/api/ops/menu/catalog/{set_key}/garnish-flag", api_ops_menu_set_garnish_flag)
    app.router.add_post("/api/ops/menu/catalog/{set_key}/display-name", api_ops_menu_set_display_name)
    app.router.add_get("/api/ops/menu/draft", api_ops_menu_draft)
    app.router.add_post("/api/ops/menu/draft/new", api_ops_menu_draft_new)
    app.router.add_post("/api/ops/menu/draft/sets", api_ops_menu_draft_sets)
    app.router.add_post("/api/ops/menu/draft/garnish", api_ops_menu_draft_garnish)
    app.router.add_post("/api/ops/menu/draft/photo", api_ops_menu_draft_photo)
    app.router.add_post("/api/ops/menu/draft/publish", api_ops_menu_draft_publish)
    app.router.add_get("/api/avatar/{tg_id}", api_avatar_image)
    app.router.add_get("/api/feed", api_feed_list)
    app.router.add_post("/api/feed", api_feed_publish)
    app.router.add_post("/api/feed/delete", api_feed_delete)
    app.router.add_get("/api/feed/image/{file_id}", api_feed_image)
    app.router.add_get("/api/moments", api_moments_list)
    app.router.add_post("/api/moments", api_moments_publish)
    app.router.add_post("/api/moments/delete", api_moments_delete)
    app.router.add_post("/api/moments/comments/delete", api_moment_comment_delete)
    app.router.add_post("/api/moments/{post_id}/like", api_moment_like)
    app.router.add_get("/api/moments/{post_id}/comments", api_moment_comments_list)
    app.router.add_post("/api/moments/{post_id}/comments", api_moment_comment_add)
    app.router.add_get("/api/ops/summary", api_ops_summary)
    app.router.add_get("/api/ops/orders", api_ops_orders)
    app.router.add_get("/api/ops/delivery", api_ops_delivery)
    app.router.add_get("/api/ops/debtors", api_ops_debtors)
    app.router.add_get("/api/ops/debtors/{client_id}", api_ops_debtor_detail)
    app.router.add_post("/api/ops/debtors/{client_id}/comment", api_ops_debtor_comment)
    app.router.add_post("/api/ops/debtors/{client_id}/reminder", api_ops_debtor_reminder_set)
    app.router.add_post("/api/ops/debtors/{client_id}/reminder/delete", api_ops_debtor_reminder_delete)
    app.router.add_post("/api/ops/debtors/{client_id}/line/pay", api_ops_debtor_line_pay)
    app.router.add_post("/api/ops/debtors/{client_id}/lines/pay", api_ops_debtor_lines_pay)
    app.router.add_post("/api/ops/debtors/{client_id}/line/unpay", api_ops_debtor_line_unpay)
    app.router.add_post("/api/ops/debtors/{client_id}/delete-history", api_ops_debtor_delete_history)
    app.router.add_get("/api/pause-admins", api_pause_admins_list)
    app.router.add_post("/api/pause-admins", api_pause_admins_add)
    app.router.add_post("/api/pause-admins/{tg_id}/feature", api_pause_admins_feature)
    app.router.add_post("/api/pause-admins/{tg_id}/remove", api_pause_admins_remove)
    app.router.add_get("/api/crm/clients", api_crm_clients)
    app.router.add_get("/api/crm/clients/{client_id}", api_crm_client_detail)
    app.router.add_get("/api/crm/leads", api_crm_leads)
    app.router.add_post("/api/crm/clients/{client_id}/stage", api_crm_stage_set)
    app.router.add_post("/api/crm/clients/{client_id}/comment", api_crm_comment_add)
    app.router.add_post("/api/crm/clients/{client_id}/reminder", api_crm_reminder_set)
    app.router.add_post("/api/crm/clients/{client_id}/reminder/done", api_crm_reminder_done)
    return app

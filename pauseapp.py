# -*- coding: utf-8 -*-
"""
Telegram Mini App "PAUSE App" — новый клиентский интерфейс, ОТДЕЛЬНЫЙ от
Mini App "Маршрут" (webapp.py, не тронут ни строкой). Пока доступен только
админам (config.ADMIN_IDS) — обычные клиенты продолжают заказывать через
чат-бота как раньше; вся админская часть (отчёты, рассылки, публикация
меню и т.п.) остаётся только в самом боте, сюда не переносится.

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
import logging
import os
import random
import urllib.parse
import uuid

import aiohttp
from aiohttp import web
from aiogram.types import BufferedInputFile

import config
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
    что кнопка входа скрыта в интерфейсе бота."""
    if "/api/" in request.path:
        tg_id = _extract_tg_id(request)
        if tg_id is None:
            return web.json_response({"error": "unauthorized"}, status=401)
        if tg_id not in config.ADMIN_IDS:
            return web.json_response({"error": "forbidden"}, status=403)
        request["tg_id"] = tg_id
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


def _serialize_sets(sets_today: list, prices: dict, sets_with_garnish: set, extra: dict = None) -> list:
    """Тот же порядок веток, что и в keyboards.set_kb/handlers/order.py:
    _proceed_after_set_choice — группа переменной цены (config.SET_VARIANTS)
    одной карточкой с вариантами, обычный сет — карточкой с ценой и (если
    есть) списком гарниров РОВНО этого сета на сегодня (см.
    sheets.get_today_garnishes_for_set).

    extra — sheets.get_set_extra(): категория/фото/описание на карточку
    (см. экран Меню в PAUSE App). Все поля необязательны — пустая строка,
    если админ их ещё не заполнил, фронт тогда просто не рисует
    соответствующий блок карточки (фото/буллеты) и не добавляет её ни в
    один чип категории, кроме "Все"."""
    extra = extra or {}
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
                    v_raw = sheets.get_today_garnishes_for_set(technical)
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
                "display_name": texts.display_set_name(group),
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
                raw = sheets.get_today_garnishes_for_set(clean)
                garnish_options = [{"value": g, "display": texts.display_garnish(g)} for g in raw]
            clean_extra = extra.get(clean, {})
            items.append({
                "key": clean,
                "is_variant_group": False,
                "display_name": texts.display_set_name(clean),
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
    cutoff_passed = await _retry_sheets(sheets.is_after_cutoff)

    sets_today = await _retry_sheets(sheets.get_today_sets)
    prices = await _retry_sheets(sheets.get_set_prices)
    sets_with_garnish = await _retry_sheets(sheets.get_sets_with_garnish)
    sets_extra = await _retry_sheets(sheets.get_set_extra)
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
        "sets": _serialize_sets(sets_today, prices, sets_with_garnish, sets_extra),
        "payment_options": payment_options,
        "card_requisites": texts.REQUISITES_TEXT,
    })


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


# Ташкент — примерная рамка города (юго-запад/северо-восток), чтобы
# Nominatim не путал местные названия с похожими в других странах.
_TASHKENT_VIEWBOX = "68.9,41.45,69.6,41.15"
_NOMINATIM_USER_AGENT = "PauseAppTashkent/1.0 (lunch delivery mini app; Telegram bot)"


async def api_geocode(request: web.Request):
    """Поиск адреса при выборе новой точки доставки на карте — бесплатный
    геокодер OpenStreetMap (Nominatim), без API-ключа: в отличие от
    Яндекс/Google Maps, которым для геокодирования нужен платный или
    требующий регистрации ключ, которого у проекта сейчас нет. Точность
    для местных ташкентских адресов не всегда идеальна — если станет
    проблемой, можно будет подключить платный геокодер отдельно."""
    q = (request.query.get("q") or "").strip()
    if len(q) < 3:
        return web.json_response({"results": []})
    params = {
        "format": "jsonv2", "q": q, "limit": "6",
        "viewbox": _TASHKENT_VIEWBOX, "bounded": "1",
        "countrycodes": "uz", "accept-language": "ru",
    }
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=6)) as session:
            async with session.get(url, headers={"User-Agent": _NOMINATIM_USER_AGENT}) as resp:
                data = await resp.json(content_type=None)
    except Exception:
        logger.exception("PAUSE App: не удалось выполнить поиск адреса (q=%s)", q)
        return web.json_response({"results": []})
    out = [
        {"display_name": d.get("display_name", ""), "lat": d.get("lat"), "lon": d.get("lon")}
        for d in (data or [])
        if d.get("lat") and d.get("lon")
    ]
    return web.json_response({"results": out})


def _payment_value(payment: str, has_screenshot: bool) -> str:
    """Точная копия ветвления handlers/order.py:_order_payment_value, только
    источник данных другой — там card_status берётся из FSM (клиент прошёл
    card_decision/card_now/card_later по шагам), здесь то же самое решается
    сразу по двум полям, которые приложение прислало одним запросом
    (payment + был ли реально загружен скрин)."""
    if "карт" in payment.lower():
        return "На проверке" if has_screenshot else ""
    if payment.strip() == "Наличными":
        return "На проверке"
    return payment


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

    if await _retry_sheets(sheets.is_after_cutoff):
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
    if not zone or not point:
        return web.json_response({"error": "point_required"}, status=400)
    if not payment:
        return web.json_response({"error": "payment_required"}, status=400)

    date_str = await _retry_sheets(sheets.get_active_menu_date)
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
            payment=payment_value, comment=comment, screenshot=screenshot,
        )
        if bot and config.ADMIN_IDS:
            try:
                prices = await _retry_sheets(sheets.get_set_prices)
                total = sum(prices.get(i["set"], 0) * int(i.get("qty", 0)) for i in cart)
                items_text = ", ".join(
                    f"{i['qty']}× {texts.display_set_name(i['set'])}" + (f" ({i['garnish']})" if i.get("garnish") else "")
                    for i in cart
                )
                alert = texts.ADMIN_PENDING_POINT_ALERT.format(
                    name=client.get("name", ""), client_id=client.get("id", ""),
                    zone=zone, point=point, items=items_text,
                    sum=f"{total:,}".replace(",", " "), payment=payment,
                )
                markup = kb.pending_point_admin_kb(pending_id)
                if screenshot:
                    alert += texts.ADMIN_PENDING_SCREENSHOT_NOTE
                    await notify_admins_photo(bot, screenshot, alert, reply_markup=markup)
                else:
                    await notify_admins(bot, alert, reply_markup=markup)
            except Exception:
                logger.exception("PAUSE App: не удалось уведомить админов о заказе на новую точку")
        return web.json_response({"status": "pending", "pending_id": pending_id})

    batch_id = uuid.uuid4().hex
    row_nums = []
    for item in cart:
        row_num = await _retry_sheets(
            sheets.append_order,
            date_str=date_str, zone=zone, point=point, client_id=client["id"],
            set_name=item["set"], qty=int(item["qty"]), garnish=item.get("garnish", ""),
            payment=payment_value, comment=comment, screenshot=screenshot, batch_id=batch_id,
        )
        row_nums.append(row_num)

    try:
        await _retry_sheets(sheets.update_client_point, client["row"], zone, point)
    except Exception:
        logger.exception("PAUSE App: не удалось сохранить точку по умолчанию (tg_id=%s)", tg_id)

    if screenshot and bot and config.ADMIN_IDS:
        try:
            prices = await _retry_sheets(sheets.get_set_prices)
            total = sum(prices.get(i["set"], 0) * int(i.get("qty", 0)) for i in cart)
            items_text = ", ".join(
                f"{i['qty']}× {texts.display_set_name(i['set'])}" + (f" ({i['garnish']})" if i.get("garnish") else "")
                for i in cart
            )
            caption = texts.ADMIN_CARD_PAYMENT_ALERT.format(
                name=client.get("name", ""), client_id=client.get("id", ""),
                items=items_text, sum=f"{total:,}".replace(",", " "),
            )
            rows_str = ",".join(str(r) for r in row_nums)
            await notify_admins_photo(bot, screenshot, caption, reply_markup=kb.card_confirm_admin_kb(rows_str))
        except Exception:
            logger.exception("PAUSE App: не удалось уведомить админов о скрине оплаты")

    number = await _retry_sheets(sheets.get_next_message_number)
    phrase = random.choice(CARE_PHRASES)
    date_today = sheets.today_date_str()
    await _retry_sheets(sheets.save_care_message, number, tg_id, client.get("name", ""), date_today, phrase)

    return web.json_response({
        "status": "ok",
        "row_nums": row_nums,
        "care": {"number": number, "total": config.CARE_MESSAGE_TOTAL, "phrase": phrase},
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
    level = sheets.get_club_level(client.get("order_count", 0))  # чистая функция, таблицу не трогает
    return web.json_response({
        "registered": True,
        "name": client.get("name", ""),
        "phone": client.get("contact", ""),
        "zone": client.get("zone", ""),
        "point": client.get("point", ""),
        "order_count": client.get("order_count", 0),
        "reg_date": client.get("reg_date", ""),
        "club": {
            "emoji": level["emoji"],
            "label": level["label"],
            "next_emoji": level.get("next_emoji"),
            "next_label": level.get("next_label"),
            "left": level.get("left", 0),
        },
    })


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
        "items": [{"set": texts.display_set_name(i["set"]), "qty": i["qty"]} for i in p["items"]],
        "payment": p["payment"],
        "status": "pending_point",
    } for p in pending]

    groups_out = []
    for g in groups:
        can_cancel = (
            not g["canceled"]
            and not sheets.is_after_cancel_cutoff(g["date"])
            and not _card_pending_status(g["payment"])
        )
        # Клиенту — только клиентские названия (те же, что на карточках в
        # Меню), техническое имя столбца G "Заказы" наружу не уходит.
        display_items = [
            {"set": texts.display_set_name(i["set"]), "qty": i["qty"]}
            for i in g["items"]
        ]
        groups_out.append({
            "date": g["date"],
            "items": display_items,
            "payment": g["payment"],
            "canceled": g["canceled"],
            "is_debt": g["payment"] == "В долг",
            "paid": g["paid"],
            "complete": sheets.is_order_complete(g["date"]) if not g["canceled"] else False,
            "can_cancel": can_cancel,
            "row_for_feedback": g["rows"][0] if g["rows"] else None,
        })

    return web.json_response({"pending": pending_out, "orders": groups_out, "debt": debt})


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
    card_status = _card_pending_status(g["payment"])
    if card_status:
        return web.json_response({"error": "card_pending", "status": card_status}, status=409)

    await _retry_sheets(sheets.cancel_order_rows, g["rows"])

    bot = request.app.get("bot")
    if bot and config.ADMIN_IDS:
        try:
            items_text = ", ".join(f"{i['qty']}× {texts.display_set_name(i['set'])}" for i in g["items"])
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

async def api_messages(request: web.Request):
    tg_id = request["tg_id"]
    messages = await _retry_sheets(sheets.get_client_messages, tg_id)
    return web.json_response({
        "messages": list(reversed(messages)),
        "total": config.CARE_MESSAGE_TOTAL,
    })


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

def create_app(bot=None) -> web.Application:
    app = web.Application(middlewares=[error_middleware, admin_auth_middleware])
    app["bot"] = bot
    app.router.add_get("/", index_page)
    app.router.add_static("/static/", STATIC_DIR, show_index=False)

    app.router.add_get("/api/me", api_me)
    app.router.add_get("/api/menu", api_menu)
    app.router.add_get("/api/zones", api_zones)
    app.router.add_get("/api/points", api_points)
    app.router.add_get("/api/delivery-points", api_delivery_points)
    app.router.add_get("/api/geocode", api_geocode)
    app.router.add_post("/api/order", api_order_submit)
    app.router.add_post("/api/order/screenshot", api_upload_screenshot)
    app.router.add_get("/api/profile", api_profile)
    app.router.add_post("/api/profile", api_profile_edit)
    app.router.add_get("/api/notify", api_notify)
    app.router.add_post("/api/notify", api_notify_set)
    app.router.add_post("/api/account/delete-request", api_account_delete_request)
    app.router.add_get("/api/orders", api_orders)
    app.router.add_post("/api/orders/cancel", api_orders_cancel)
    app.router.add_get("/api/favorites", api_favorites)
    app.router.add_post("/api/favorites/toggle", api_favorites_toggle)
    app.router.add_post("/api/feedback", api_feedback)
    app.router.add_get("/api/messages", api_messages)
    app.router.add_get("/api/feed", api_feed_list)
    app.router.add_post("/api/feed", api_feed_publish)
    app.router.add_post("/api/feed/delete", api_feed_delete)
    app.router.add_get("/api/feed/image/{file_id}", api_feed_image)
    return app

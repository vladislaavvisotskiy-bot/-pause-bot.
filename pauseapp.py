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
import uuid

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

async def index_page(request: web.Request):
    return web.FileResponse(os.path.join(STATIC_DIR, "index.html"))


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

def _serialize_sets(sets_today: list, prices: dict, sets_with_garnish: set) -> list:
    """Тот же порядок веток, что и в keyboards.set_kb/handlers/order.py:
    _proceed_after_set_choice — группа переменной цены (config.SET_VARIANTS)
    одной карточкой с вариантами, обычный сет — карточкой с ценой и (если
    есть) списком гарниров РОВНО этого сета на сегодня (см.
    sheets.get_today_garnishes_for_set)."""
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
            items.append({
                "key": f"__variant__:{group}",
                "is_variant_group": True,
                "display_name": texts.display_set_name(group),
                "variants": variants,
                "price": None,
                "has_garnish": False,
                "garnish_options": [],
            })
        else:
            has_garnish = clean.lower() in sets_with_garnish
            garnish_options = []
            if has_garnish:
                raw = sheets.get_today_garnishes_for_set(clean)
                garnish_options = [{"value": g, "display": texts.display_garnish(g)} for g in raw]
            items.append({
                "key": clean,
                "is_variant_group": False,
                "display_name": texts.display_set_name(clean),
                "variants": [],
                "price": prices.get(clean, 0),
                "has_garnish": bool(garnish_options),
                "garnish_options": garnish_options,
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
        "sets": _serialize_sets(sets_today, prices, sets_with_garnish),
        "payment_options": payment_options,
        "card_requisites": texts.REQUISITES_TEXT,
    })


async def api_zones(request: web.Request):
    return web.json_response({"zones": await _retry_sheets(sheets.get_zones)})


async def api_points(request: web.Request):
    zone = request.query.get("zone", "")
    return web.json_response({"points": await _retry_sheets(sheets.get_points, zone)})


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

    if name:
        await _retry_sheets(sheets.update_client_field, client["row"], config.COL_NAME, name)
    if phone:
        await _retry_sheets(sheets.update_client_field, client["row"], config.COL_CONTACT, phone)
    if zone and point:
        await _retry_sheets(sheets.update_client_point, client["row"], zone, point)
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


# ---------------------------------------------------------------------------
# Мои заказы / отмена — та же логика, что handlers/profile.py
# (my_orders, cancel_order_start/cancel_order_yes).
# ---------------------------------------------------------------------------

async def api_orders(request: web.Request):
    tg_id = request["tg_id"]
    client = await _retry_sheets(sheets.find_client_by_tg_id, tg_id)
    if not client:
        return web.json_response({"error": "not_registered"}, status=404)

    pending = await _retry_sheets(sheets.get_client_pending_orders, client["id"])
    groups = await _retry_sheets(sheets.get_client_order_groups, client["id"], limit=10)
    debt = await _retry_sheets(sheets.get_client_debt, client["id"])

    pending_out = [{
        "date": p["date"],
        "items": p["items"],
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
        groups_out.append({
            "date": g["date"],
            "items": g["items"],
            "payment": g["payment"],
            "canceled": g["canceled"],
            "is_debt": g["payment"] == "В долг",
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
    if not text:
        return web.json_response({"error": "text_required"}, status=400)

    bot = request.app.get("bot")
    if bot and config.ADMIN_IDS:
        try:
            await notify_admins(bot, texts.ADMIN_FEEDBACK_ALERT.format(
                name=client.get("name", ""), client_id=client.get("id", ""),
                order=order_label, text=text,
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

def create_app(bot=None) -> web.Application:
    app = web.Application(middlewares=[error_middleware, admin_auth_middleware])
    app["bot"] = bot
    app.router.add_get("/", index_page)
    app.router.add_static("/static/", STATIC_DIR, show_index=False)

    app.router.add_get("/api/me", api_me)
    app.router.add_get("/api/menu", api_menu)
    app.router.add_get("/api/zones", api_zones)
    app.router.add_get("/api/points", api_points)
    app.router.add_post("/api/order", api_order_submit)
    app.router.add_post("/api/order/screenshot", api_upload_screenshot)
    app.router.add_get("/api/profile", api_profile)
    app.router.add_post("/api/profile", api_profile_edit)
    app.router.add_get("/api/orders", api_orders)
    app.router.add_post("/api/orders/cancel", api_orders_cancel)
    app.router.add_post("/api/feedback", api_feedback)
    app.router.add_get("/api/messages", api_messages)
    return app

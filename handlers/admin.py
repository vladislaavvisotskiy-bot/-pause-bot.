# -*- coding: utf-8 -*-
import asyncio
import datetime as dt
import logging
import uuid

from aiogram import Router, F, Bot
from aiogram.filters import Command, CommandObject
from aiogram.types import Message, CallbackQuery, BufferedInputFile, InputMediaPhoto
from aiogram.fsm.context import FSMContext

import sheets
import texts
import keyboards as kb
import config
import pdf_report
from states import AdminClub, AdminMenu

router = Router()
logger = logging.getLogger("pause_bot")

# Буфер для сбора альбома фотографий меню (Telegram присылает каждое фото
# альбома отдельным сообщением с одним и тем же media_group_id).
_pending_albums: dict = {}
_ALBUM_WAIT = 1.5  # секунд ждём остальные фото альбома, прежде чем сохранить меню


def _is_admin(user_id: int) -> bool:
    return user_id in config.ADMIN_IDS


@router.message(Command("webapp_debug"))
async def cmd_webapp_debug(message: Message):
    """Диагностика кнопки Mini App прямо на живом сервере — специально без
    проверки _is_admin: если сама проблема в том, что ADMIN_CHAT_ID не
    совпадает, обычная admin-only команда молчала бы и ничего бы не
    объяснила. Команда не в /admin и не в списке команд бота — набирается
    вручную."""
    tg_id = message.from_user.id
    is_admin = tg_id in config.ADMIN_IDS
    is_courier = sheets.is_courier(tg_id)

    lines = [
        f"Ваш Telegram ID: {tg_id}",
        "WEBAPP_URL на сервере: " + (config.WEBAPP_URL if config.WEBAPP_URL else "⚠️ НЕ ЗАДАН (пусто)"),
        "ADMIN_CHAT_ID задан: " + ("да, админов: " + str(len(config.ADMIN_IDS)) if config.ADMIN_IDS else "⚠️ НЕТ (пусто)"),
        "Ваш ID есть в списке админов: " + ("да" if is_admin else "нет"),
        "Вы в листе «Курьеры»: " + ("да" if is_courier else "нет"),
    ]
    should_show = bool(config.WEBAPP_URL) and (is_admin or is_courier)
    lines.append("")
    lines.append("Кнопка маршрута должна показываться: " + ("ДА ✅" if should_show else "НЕТ ❌"))
    await message.answer("\n".join(lines))


@router.message(Command("chatid"))
@router.channel_post(Command("chatid"))
async def cmd_chatid(message: Message):
    """Разовая диагностика для настройки PAUSE Club (хранение фото ленты в
    закрытом канале, см. FEED_CHAT_ID в config.py) — печатает числовой ID
    текущего чата, чтобы не гадать/не звать сторонних ботов. Специально
    без проверки _is_admin: канал для хранения фото приватный сам по себе
    (в него и так никто чужой не попадёт), а /chatid нужно набрать именно
    ИЗ этого канала, где бот — админ; команда не в /admin и не в списке
    команд бота — набирается вручную. В канале сообщения приходят отдельным
    типом обновления (channel_post), не обычным message — отсюда два
    декоратора на одну функцию."""
    await message.answer(f"ID этого чата: {message.chat.id}")


async def _show_admin_panel(send):
    """send — bound answer-метод (message.answer или callback.message.answer),
    общий вход в панель и для текстовой команды /admin, и для кнопки
    "⚙️ Администратор" в главном меню, и для возврата кнопкой "Назад"."""
    await send(texts.ADMIN_ACTIVE_MENU_DATE.format(date=sheets.get_active_menu_date()))
    await send("Панель администратора:", reply_markup=kb.admin_panel_kb())


@router.message(Command("admin"))
async def admin_panel(message: Message):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    await _show_admin_panel(message.answer)


@router.message(Command("app"))
async def cmd_open_pauseapp(message: Message):
    """Отдельная явная точка входа в PAUSE Mini App (UI-прототип), помимо
    кнопки в /admin — оба места admin-only на уровне бота (кнопка/команда
    не показываются кому попало), но настоящая защита всё равно на
    сервере (см. pauseapp.py:api_verify — проверка initData+ADMIN_IDS),
    т.к. URL Mini App технически можно переслать кому угодно."""
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_APP_ONLY)
        return
    if not config.WEBAPP_URL:
        await message.answer("WEBAPP_URL не задан на сервере — открыть Mini App нельзя.")
        return
    await message.answer("PAUSE Mini App:", reply_markup=kb.pauseapp_open_kb())


@router.callback_query(F.data == "admin_panel_open")
async def admin_panel_open(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    await _show_admin_panel(callback.message.answer)
    await callback.answer()


@router.callback_query(F.data.startswith("admin_back:"))
async def admin_back(callback: CallbackQuery):
    """Кнопка "‹ Назад" внутри отдельных разделов панели — возвращает на
    экран выше, а не сразу в главное меню (см. report_dates_kb,
    admin_kitchen_format_kb, admin_broadcast_toggle_kb, admin_club_panel_kb,
    admin_back_kb)."""
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    target = callback.data.split(":", 1)[1]
    if target == "kitchen_dates":
        await _ask_report_date(callback.message, "kitchen_pick")
    elif target == "courier_dates":
        await _ask_report_date(callback.message, "courier")
    elif target == "payments_dates":
        await _ask_report_date(callback.message, "payments")
    else:
        await _show_admin_panel(callback.message.answer)
    await callback.answer()


@router.callback_query(F.data == "admin_instructions")
async def admin_instructions(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    chunks = (
        texts.ADMIN_INSTRUCTIONS_1, texts.ADMIN_INSTRUCTIONS_2, texts.ADMIN_INSTRUCTIONS_3,
        texts.ADMIN_INSTRUCTIONS_4, texts.ADMIN_INSTRUCTIONS_5, texts.ADMIN_INSTRUCTIONS_6,
        texts.ADMIN_INSTRUCTIONS_7, texts.ADMIN_INSTRUCTIONS_8,
    )
    for chunk in chunks[:-1]:
        await callback.message.answer(chunk)
    await callback.message.answer(chunks[-1], reply_markup=kb.admin_back_kb())
    await callback.answer()


# ---------------------------------------------------------------------------
# Меню на сегодня — координатор просто присылает фото(и) с подписью
# ---------------------------------------------------------------------------

@router.message(F.photo, F.from_user.id.in_(config.ADMIN_IDS))
async def admin_menu_photo(message: Message, bot: Bot, state: FSMContext):
    file_id = message.photo[-1].file_id
    caption = message.caption or ""
    media_group_id = message.media_group_id

    if not media_group_id:
        await _save_menu_and_notify(bot, message.chat.id, [file_id], caption, state)
        return

    entry = _pending_albums.get(media_group_id)
    if entry is None:
        entry = {"photos": [], "caption": "", "chat_id": message.chat.id, "state": state}
        _pending_albums[media_group_id] = entry
        asyncio.create_task(_flush_album(bot, media_group_id))

    entry["photos"].append(file_id)
    if caption:
        entry["caption"] = caption


async def _flush_album(bot: Bot, media_group_id: str):
    await asyncio.sleep(_ALBUM_WAIT)
    entry = _pending_albums.pop(media_group_id, None)
    if not entry:
        return
    await _save_menu_and_notify(bot, entry["chat_id"], entry["photos"], entry["caption"], entry["state"])


async def _save_menu_and_notify(bot: Bot, chat_id: int, photo_ids: list, caption: str, state: FSMContext):
    # Сохраняем как ЧЕРНОВИК (см. sheets.start_new_menu_draft) — клиенты его
    # пока не видят вообще. Активное меню (то, что видят клиенты) тронет
    # только publish_draft_menu, после шагов сеты -> гарниры -> предпросмотр
    # -> дата -> "✅ Опубликовать" (см. admin_publish_confirmed).
    sheets.start_new_menu_draft(photo_ids, caption)
    await bot.send_message(chat_id, texts.ADMIN_MENU_SAVED)
    await state.update_data(sets_selected=[])
    await bot.send_message(
        chat_id, texts.ADMIN_ASK_TODAY_SETS,
        reply_markup=kb.admin_sets_toggle_kb(sheets.get_sets(), []),
    )
    await state.set_state(AdminMenu.waiting_sets)


async def _show_preview(message: Message, state: FSMContext):
    """Шаг 4 публикации — показывает черновик РОВНО так, как его увидят
    клиенты (фото/подпись + кнопки сетов), и переводит в состояние preview.
    Кнопки сетов идут с отдельным префиксом "pvset:" (см.
    keyboards.admin_preview_kb) — нажатие только показывает всплывающую
    подсказку с ценой и гарниром (см. admin_preview_set_info), никакого
    заказа при этом никуда не пишется. message — либо message.answer, либо
    callback.message (для возврата "‹ Назад к предпросмотру"/"Изменить
    гарниры")."""
    photo_ids, caption = sheets.get_draft_menu()
    if not photo_ids and not caption:
        await message.answer(texts.ADMIN_PREVIEW_NO_PHOTO)
        await state.clear()
        return

    if photo_ids:
        if len(photo_ids) == 1:
            await message.answer_photo(photo_ids[0], caption=caption or None)
        else:
            media = [InputMediaPhoto(media=p) for p in photo_ids]
            if caption:
                media[0].caption = caption
            await message.bot.send_media_group(message.chat.id, media)
    elif caption:
        await message.answer(caption)

    sets = sheets.get_draft_sets()
    await message.answer(texts.ADMIN_PREVIEW_HEADER, reply_markup=kb.admin_preview_kb(sets))
    await state.set_state(AdminMenu.preview)


@router.callback_query(AdminMenu.preview, F.data.startswith("pvset:"))
async def admin_preview_set_info(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    value = callback.data.split(":", 1)[1]
    prices = sheets.get_set_prices()

    if value.startswith("__variant__:"):
        group = value.split(":", 1)[1]
        garnishes = sheets.get_draft_garnishes_for_set(group)
        lines = [texts.display_set_name(group)]
        for technical, label in config.SET_VARIANTS[group]:
            price_text = f"{prices.get(technical, 0):,}".replace(",", " ")
            lines.append(f"{label}: {price_text} сум")
        lines.append("Гарнир: " + (", ".join(garnishes) if garnishes else "нет"))
        await callback.answer("\n".join(lines), show_alert=True)
        return

    price_text = f"{prices.get(value, 0):,}".replace(",", " ")
    garnishes = sheets.get_draft_garnishes_for_set(value)
    lines = [texts.display_set_name(value), f"Цена: {price_text} сум"]
    lines.append("Гарнир: " + (", ".join(garnishes) if garnishes else "нет"))
    await callback.answer("\n".join(lines), show_alert=True)


@router.callback_query(AdminMenu.preview, F.data == "pveditsets")
async def admin_preview_edit_sets(callback: CallbackQuery, state: FSMContext):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    selected = sheets.get_draft_sets_raw()
    await state.update_data(sets_selected=selected)
    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass
    await callback.message.answer(
        texts.ADMIN_ASK_TODAY_SETS,
        reply_markup=kb.admin_sets_toggle_kb(sheets.get_sets(), selected),
    )
    await state.set_state(AdminMenu.waiting_sets)
    await callback.answer()


@router.callback_query(AdminMenu.preview, F.data == "pveditgarnish")
async def admin_preview_edit_garnish(callback: CallbackQuery, state: FSMContext):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass
    await _start_garnish_queue(callback.message, state)
    await callback.answer()


@router.callback_query(AdminMenu.preview, F.data == "pvnext")
async def admin_preview_next(callback: CallbackQuery, state: FSMContext):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass
    today = sheets.today_date_str()
    tomorrow = sheets.get_tomorrow_date_str()
    await callback.message.answer(texts.ADMIN_ASK_MENU_DATE, reply_markup=kb.admin_menu_date_kb(today, tomorrow))
    await state.set_state(AdminMenu.waiting_date)
    await callback.answer()


async def _show_publish_confirm(message: Message, date_str: str, state: FSMContext):
    await state.update_data(publish_date=date_str)
    await message.answer(texts.ADMIN_CONFIRM_PUBLISH.format(date=date_str), reply_markup=kb.admin_publish_confirm_kb())
    await state.set_state(AdminMenu.confirming_publish)


@router.callback_query(AdminMenu.waiting_date, F.data.startswith("menudate:"))
async def admin_menu_date_chosen(callback: CallbackQuery, state: FSMContext):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    date_str = callback.data.split(":", 1)[1]
    await _show_publish_confirm(callback.message, date_str, state)
    await callback.answer()


@router.message(AdminMenu.waiting_date)
async def admin_menu_date_manual(message: Message, state: FSMContext):
    date_str = _parse_date_arg(message.text or "")
    if not date_str:
        await message.answer(texts.ADMIN_BAD_DATE_FORMAT)
        return
    await _show_publish_confirm(message, date_str, state)


@router.callback_query(AdminMenu.confirming_publish, F.data == "pubconfirm")
async def admin_publish_confirmed(callback: CallbackQuery, state: FSMContext, bot: Bot):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    data = await state.get_data()
    date_str = data.get("publish_date") or sheets.today_date_str()
    # Единственное место, которое переносит черновик в активные ячейки
    # (см. sheets.publish_draft_menu) — до этого момента клиенты видели
    # предыдущее активное меню как ни в чём не бывало.
    sheets.publish_draft_menu(date_str)
    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass
    await callback.message.answer(texts.ADMIN_MENU_PUBLISHED.format(date=date_str))
    if not sheets.is_broadcasts_disabled():
        await _broadcast_new_menu(bot)
    await state.clear()
    await callback.answer()


@router.callback_query(AdminMenu.confirming_publish, F.data == "pubback")
async def admin_publish_back(callback: CallbackQuery, state: FSMContext):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass
    await _show_preview(callback.message, state)
    await callback.answer()


async def _broadcast_new_menu(bot: Bot):
    """Персональное оповещение всем клиентам о том, что меню на сегодня
    опубликовано — по имени, в тёплом духе, с кнопкой сразу в «Меню»."""
    for c in sheets.get_broadcast_clients():
        try:
            greeting = texts.NEW_MENU_GREETING.format(name=c.get("name") or "")
            await bot.send_message(int(c["tg_id"]), greeting, reply_markup=kb.menu_broadcast_kb())
        except Exception:
            logger.exception("Не удалось отправить оповещение о новом меню клиенту ID %s", c.get("id"))
        await asyncio.sleep(config.BROADCAST_DELAY_SECONDS)


@router.message(AdminMenu.waiting_sets)
async def admin_sets_text_reminder(message: Message):
    # Выбор сетов теперь только кнопками (см. kb.admin_sets_toggle_kb) —
    # текстовый ввод и распознавание заголовков в тексте меню сюда
    # сознательно не подключены. Мягкое напоминание вместо тишины, если
    # админ по привычке напишет текстом.
    await message.answer(texts.ADMIN_SETS_USE_BUTTONS)


@router.callback_query(AdminMenu.waiting_sets, F.data.startswith("settoggle:"))
async def admin_sets_toggle(callback: CallbackQuery, state: FSMContext):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    set_name = callback.data.split(":", 1)[1]
    data = await state.get_data()
    selected = data.get("sets_selected", [])
    if set_name in selected:
        selected = [s for s in selected if s != set_name]
    else:
        selected = selected + [set_name]
    await state.update_data(sets_selected=selected)
    try:
        await callback.message.edit_reply_markup(
            reply_markup=kb.admin_sets_toggle_kb(sheets.get_sets(), selected)
        )
    except Exception:
        pass
    await callback.answer()


@router.callback_query(AdminMenu.waiting_sets, F.data == "setsall_toggle")
async def admin_sets_toggle_all(callback: CallbackQuery, state: FSMContext):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    catalog = sheets.get_sets()
    all_keys = []
    seen = set()
    for name in catalog:
        key = config.SET_VARIANT_GROUP.get(name, name)
        if key not in seen:
            seen.add(key)
            all_keys.append(key)
    await state.update_data(sets_selected=all_keys)
    try:
        await callback.message.edit_reply_markup(reply_markup=kb.admin_sets_toggle_kb(catalog, all_keys))
    except Exception:
        pass
    await callback.answer()


@router.callback_query(AdminMenu.waiting_sets, F.data == "setsdone")
async def admin_sets_done(callback: CallbackQuery, state: FSMContext):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    data = await state.get_data()
    selected = data.get("sets_selected", [])
    sheets.set_draft_sets(selected)
    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass
    if selected:
        await callback.message.answer(texts.ADMIN_SETS_SAVED.format(list=", ".join(selected)))
    else:
        await callback.message.answer(texts.ADMIN_SETS_ALL)
    await _start_garnish_queue(callback.message, state)
    await callback.answer()


async def _start_garnish_queue(message: Message, state: FSMContext):
    """После того как известны сегодняшние сеты черновика — строим очередь
    вопросов про гарнир, по одному на КАЖДЫЙ сет с Гарнир=Да, реально
    входящий в черновик (см. sheets.get_sets_with_garnish/get_draft_sets).
    Сет с переменной ценой (config.SET_VARIANTS, например "Самса") — один
    вопрос на всю группу, а не на каждый технический вариант отдельно
    (гарнир у них общий, в отличие от цены). Если ни у одного сета
    черновика нет гарнира — вопросов не будет вовсе, сразу переходим к
    предпросмотру (шаг 4)."""
    today_sets = sheets.get_draft_sets()
    sets_with_garnish = sheets.get_sets_with_garnish()
    queue = []
    seen = set()
    for s in today_sets:
        if s.strip().lower() not in sets_with_garnish:
            continue
        key = config.SET_VARIANT_GROUP.get(s, s)
        if key in seen:
            continue
        seen.add(key)
        queue.append(key)

    if not queue:
        await _show_preview(message, state)
        return
    await _ask_next_garnish(message, state, queue)


async def _ask_next_garnish(message: Message, state: FSMContext, queue: list):
    # Админу показываем ТЕХНИЧЕСКОЕ имя сета (как в Справочники), а не
    # клиентское отображаемое — тот же принцип, что и в ADMIN_ASK_TODAY_SETS
    # ("технические названиями из каталога, как в «Справочники»"); иначе для
    # разных сетов вопрос выглядел бы непоследовательно — часть по
    # техническому имени, часть по клиентскому (например "Сет стандарт" ->
    # "Для тебя.").
    cur_set, remaining = queue[0], queue[1:]
    await state.update_data(garnish_queue=remaining, cur_garnish_set=cur_set)
    await message.answer(
        texts.ADMIN_ASK_TODAY_GARNISH.format(set=cur_set),
        reply_markup=kb.admin_garnish_kb(),
    )
    await state.set_state(AdminMenu.waiting_garnishes)


@router.message(AdminMenu.waiting_garnishes)
async def admin_today_garnish_save(message: Message, state: FSMContext):
    text = (message.text or "").strip()
    garnishes = [g.strip() for g in text.split(",") if g.strip()]
    data = await state.get_data()
    cur_set = data.get("cur_garnish_set", "")
    sheets.set_draft_garnishes_for_set(cur_set, garnishes)
    if garnishes:
        await message.answer(texts.ADMIN_GARNISH_SAVED.format(set=cur_set, list=", ".join(garnishes)))
    else:
        await message.answer(texts.ADMIN_GARNISH_CLEARED.format(set=cur_set))
    queue = data.get("garnish_queue", [])
    if queue:
        await _ask_next_garnish(message, state, queue)
    else:
        await _show_preview(message, state)


@router.callback_query(AdminMenu.waiting_garnishes, F.data == "garnish_none")
async def admin_garnish_none(callback: CallbackQuery, state: FSMContext):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    data = await state.get_data()
    cur_set = data.get("cur_garnish_set", "")
    sheets.set_draft_garnishes_for_set(cur_set, [])
    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass
    await callback.message.answer(texts.ADMIN_GARNISH_CLEARED.format(set=cur_set))
    queue = data.get("garnish_queue", [])
    if queue:
        await _ask_next_garnish(callback.message, state, queue)
    else:
        await _show_preview(callback.message, state)
    await callback.answer()


# ---------------------------------------------------------------------------
# Подтверждение оплаты картой по присланному клиентом скрину
# ---------------------------------------------------------------------------

@router.callback_query(F.data.startswith("cardok:"))
async def card_payment_confirmed(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    rows_str = callback.data.split(":", 1)[1]
    row_nums = [int(r) for r in rows_str.split(",") if r.strip().isdigit()]
    sheets.confirm_card_payment(row_nums)
    try:
        await callback.message.edit_caption(
            caption=(callback.message.caption or "") + texts.ADMIN_CARD_CONFIRMED_SUFFIX
        )
    except Exception:
        pass
    await callback.answer(texts.ADMIN_CARD_CONFIRMED_TOAST)


# ---------------------------------------------------------------------------
# Подтверждение оплаты наличными — админ лично получил деньги
# ---------------------------------------------------------------------------

@router.callback_query(F.data.startswith("cashok:"))
async def cash_payment_confirmed(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    rows_str = callback.data.split(":", 1)[1]
    row_nums = [int(r) for r in rows_str.split(",") if r.strip().isdigit()]
    sheets.confirm_cash_payment(row_nums)
    try:
        await callback.message.edit_text(
            (callback.message.text or "") + texts.ADMIN_CARD_CONFIRMED_SUFFIX,
            reply_markup=None,
        )
    except Exception:
        pass
    await callback.answer(texts.ADMIN_CARD_CONFIRMED_TOAST)


# ---------------------------------------------------------------------------
# Подтверждение/отклонение заказа на новую точку доставки
# ---------------------------------------------------------------------------

@router.callback_query(F.data.startswith("pendok:"))
async def pending_point_approved(callback: CallbackQuery, bot: Bot):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    pending_id = callback.data.split(":", 1)[1]
    pending = sheets.get_pending_order(pending_id)
    if not pending or pending["status"] != config.PENDING_STATUS_WAITING:
        await callback.answer(texts.ADMIN_PENDING_ALREADY_HANDLED, show_alert=True)
        return

    # Одна метка на ВСЮ корзину этого подтверждения — тот же приём, что и
    # для обычного оформления (см. config.O_ORDER_BATCH/handlers/order.py).
    batch_id = uuid.uuid4().hex
    row_nums = []
    for item in pending["cart"]:
        row_num = sheets.append_order(
            date_str=pending["date"],
            zone=pending["zone"],
            point=pending["point"],
            client_id=pending["client_id"],
            set_name=item["set"],
            qty=item["qty"],
            garnish=item.get("garnish", ""),
            payment=pending["payment"],
            comment=pending["comment"],
            batch_id=batch_id,
        )
        row_nums.append(row_num)

    client = sheets.get_client_by_id(pending["client_id"])
    if client:
        sheets.update_client_point(client["row"], pending["zone"], pending["point"])

    if pending["screenshot"]:
        sheets.confirm_card_payment(row_nums)

    sheets.set_pending_status(pending["row"], config.PENDING_STATUS_APPROVED)

    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass

    if client and client.get("tg_id"):
        try:
            await bot.send_message(int(client["tg_id"]), texts.ORDER_POINT_APPROVED)
        except Exception:
            pass

    await callback.answer(texts.ADMIN_PENDING_APPROVED_TOAST)


@router.callback_query(F.data.startswith("penddeny:"))
async def pending_point_denied(callback: CallbackQuery, bot: Bot):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    pending_id = callback.data.split(":", 1)[1]
    pending = sheets.get_pending_order(pending_id)
    if not pending or pending["status"] != config.PENDING_STATUS_WAITING:
        await callback.answer(texts.ADMIN_PENDING_ALREADY_HANDLED, show_alert=True)
        return

    sheets.set_pending_status(pending["row"], config.PENDING_STATUS_DENIED)

    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass

    client = sheets.get_client_by_id(pending["client_id"])
    if client and client.get("tg_id"):
        try:
            await bot.send_message(
                int(client["tg_id"]), texts.ORDER_POINT_DENIED.format(support=texts.SUPPORT_USERNAME)
            )
        except Exception:
            pass

    await callback.answer(texts.ADMIN_PENDING_DENIED_TOAST)


# ---------------------------------------------------------------------------
# Должники
# ---------------------------------------------------------------------------

@router.callback_query(F.data == "admin_debtors")
async def admin_debtors(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    debtors = sheets.get_all_debtors()
    if not debtors:
        await callback.message.answer(texts.ADMIN_DEBTORS_EMPTY, reply_markup=kb.admin_back_kb())
        await callback.answer()
        return

    lines = [texts.ADMIN_DEBTORS_HEADER, ""]
    total = 0
    for d in debtors:
        lines.append(f"○ {d['name']} (ID {d['id']}) — {d['sum']:,} сум".replace(",", " "))
        total += d["sum"]
    lines.append("")
    lines.append(f"Итого: {total:,} сум".replace(",", " "))
    await callback.message.answer("\n".join(lines), reply_markup=kb.admin_back_kb())
    await callback.answer()


def _parse_date_arg(arg: str):
    """Дата, присланная аргументом команды (/kitchen 25.08.2026) — строго
    ДД.ММ.ГГГГ. None, если не распознали."""
    arg = (arg or "").strip()
    if not arg:
        return None
    try:
        d = dt.datetime.strptime(arg, "%d.%m.%Y")
    except ValueError:
        return None
    return d.strftime("%d.%m.%Y")


async def _ask_report_date(message: Message, report_type: str):
    dates = sheets.get_recent_order_dates()
    if not dates:
        await message.answer(texts.ADMIN_NO_RECENT_ORDERS)
        return
    await message.answer(texts.ADMIN_ASK_REPORT_DATE, reply_markup=kb.report_dates_kb(report_type, dates))


async def _send_report_by_type(bot: Bot, chat_id: int, report_type: str, date_str: str):
    if report_type == "kitchen":
        report = sheets.build_kitchen_report(date_str)
        await bot.send_message(
            chat_id, report or texts.ADMIN_NO_ORDERS_FOR_DATE.format(date=date_str),
            reply_markup=kb.admin_back_kb(),
        )
    elif report_type == "courier":
        report = sheets.build_courier_report(date_str)
        await bot.send_message(
            chat_id, report or texts.ADMIN_NO_ORDERS_FOR_DATE.format(date=date_str),
            reply_markup=kb.admin_back_kb(),
        )
    elif report_type == "kitchen_pdf":
        await send_kitchen_pdf(bot, chat_id, date_str)
    elif report_type == "payments":
        await _send_payments_for_date(bot, chat_id, date_str)
    elif report_type == "kitchen_pick":
        # Панель /admin: после даты сначала спрашиваем формат (PDF или
        # текст), а не шлём отчёт сразу — сами PDF/текст используют ту же
        # логику, что и report_type "kitchen"/"kitchen_pdf" выше.
        await bot.send_message(
            chat_id, texts.ADMIN_KITCHEN_FORMAT_PROMPT.format(date=date_str),
            reply_markup=kb.admin_kitchen_format_kb(date_str),
        )


@router.callback_query(F.data.startswith("adminrep:"))
async def admin_report_date_chosen(callback: CallbackQuery, bot: Bot):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    _, report_type, date_str = callback.data.split(":", 2)
    await _send_report_by_type(bot, callback.message.chat.id, report_type, date_str)
    await callback.answer()


@router.callback_query(F.data.startswith("kitchenfmt:"))
async def admin_kitchen_format_chosen(callback: CallbackQuery, bot: Bot):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    _, fmt, date_str = callback.data.split(":", 2)
    report_type = "kitchen_pdf" if fmt == "pdf" else "kitchen"
    await _send_report_by_type(bot, callback.message.chat.id, report_type, date_str)
    await callback.answer()


# ---------------------------------------------------------------------------
# Панель /admin — кнопки, ведущие в ту же логику отчётов/оплаты/рассылок,
# что и соответствующие команды текстом (см. ниже).
# ---------------------------------------------------------------------------

@router.callback_query(F.data == "admin_kitchen_report")
async def admin_panel_kitchen(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    await _ask_report_date(callback.message, "kitchen_pick")
    await callback.answer()


@router.callback_query(F.data == "admin_courier_report")
async def admin_panel_courier(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    await _ask_report_date(callback.message, "courier")
    await callback.answer()


@router.callback_query(F.data == "admin_payments_report")
async def admin_panel_payments(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    await _ask_report_date(callback.message, "payments")
    await callback.answer()


@router.callback_query(F.data == "admin_broadcast_panel")
async def admin_panel_broadcast(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    disabled = sheets.is_broadcasts_disabled()
    status_text = texts.ADMIN_BROADCASTS_STATUS_OFF if disabled else texts.ADMIN_BROADCASTS_STATUS_ON
    await callback.message.answer(status_text, reply_markup=kb.admin_broadcast_toggle_kb(disabled))
    await callback.answer()


@router.callback_query(F.data == "broadcast_toggle_off")
async def admin_panel_broadcast_off(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    sheets.set_broadcasts_disabled(True)
    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass
    await callback.message.answer(texts.ADMIN_BROADCASTS_OFF)
    await callback.answer()


@router.callback_query(F.data == "broadcast_toggle_on")
async def admin_panel_broadcast_on(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    sheets.set_broadcasts_disabled(False)
    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass
    await callback.message.answer(texts.ADMIN_BROADCASTS_ON)
    await callback.answer()


@router.message(Command("kitchen"))
async def cmd_kitchen(message: Message, bot: Bot, command: CommandObject):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    if command.args:
        date_str = _parse_date_arg(command.args)
        if not date_str:
            await message.answer(texts.ADMIN_BAD_DATE_FORMAT)
            return
        await _send_report_by_type(bot, message.chat.id, "kitchen", date_str)
        return
    await _ask_report_date(message, "kitchen")


@router.message(Command("courier"))
async def cmd_courier(message: Message, bot: Bot, command: CommandObject):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    if command.args:
        date_str = _parse_date_arg(command.args)
        if not date_str:
            await message.answer(texts.ADMIN_BAD_DATE_FORMAT)
            return
        await _send_report_by_type(bot, message.chat.id, "courier", date_str)
        return
    await _ask_report_date(message, "courier")


# ---------------------------------------------------------------------------
# PDF-отчёт для кухни
# ---------------------------------------------------------------------------

async def send_kitchen_pdf(bot: Bot, chat_id: int, date_str: str):
    data = pdf_report.build_kitchen_report_pdf(date_str)
    filename = f"kitchen_{date_str.replace('.', '-')}.pdf"
    await bot.send_document(
        chat_id,
        BufferedInputFile(data, filename=filename),
        caption=texts.ADMIN_KITCHEN_PDF_CAPTION.format(date=date_str),
        reply_markup=kb.admin_back_kb(),
    )


@router.message(Command("kitchen_pdf"))
async def cmd_kitchen_pdf(message: Message, bot: Bot, command: CommandObject):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    if command.args:
        date_str = _parse_date_arg(command.args)
        if not date_str:
            await message.answer(texts.ADMIN_BAD_DATE_FORMAT)
            return
        await _send_report_by_type(bot, message.chat.id, "kitchen_pdf", date_str)
        return
    await _ask_report_date(message, "kitchen_pdf")


@router.message(Command("payments"))
async def cmd_payments(message: Message, bot: Bot, command: CommandObject):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    if command.args:
        date_str = _parse_date_arg(command.args)
        if not date_str:
            await message.answer(texts.ADMIN_BAD_DATE_FORMAT)
            return
        await _send_payments_for_date(bot, message.chat.id, date_str)
        return
    await _ask_report_date(message, "payments")


async def _send_payments_for_date(bot: Bot, chat_id: int, date_str: str):
    """Единый список оплат за дату — и скрины картой, и заказы наличными,
    вперемешку, все статусы (см. sheets.get_payments_for_date): уже
    подтверждённые тоже показываются, с пометкой вместо кнопки — как
    раньше делал /payments для скринов, теперь так же и для наличных.
    Несколько строк одного клиента за день объединены в одну запись."""
    entries = sheets.get_payments_for_date(date_str)
    if not entries:
        await bot.send_message(
            chat_id, texts.ADMIN_NO_PAYMENTS_FOR_DATE.format(date=date_str), reply_markup=kb.admin_back_kb(),
        )
        return

    await bot.send_message(
        chat_id, texts.ADMIN_PAYMENTS_HEADER.format(date=date_str, count=len(entries)),
        reply_markup=kb.admin_back_kb(),
    )
    for entry in entries:
        items_text = ", ".join(
            f"{s['qty']}× {texts.display_set_name(s['set'])}" if s.get("qty") else texts.display_set_name(s["set"])
            for s in entry["sets"]
        )
        caption = texts.ADMIN_PAYMENT_ITEM_CAPTION.format(
            name=entry["name"],
            items=items_text,
            sum=f"{entry['sum']:,}".replace(",", " "),
        )
        rows_str = ",".join(str(r) for r in entry["rows"])
        if entry["confirmed"]:
            caption += texts.ADMIN_PAYMENT_ALREADY_CONFIRMED_SUFFIX
        if entry["method"] == "card":
            try:
                await bot.send_photo(
                    chat_id, entry["screenshot"], caption=caption,
                    reply_markup=None if entry["confirmed"] else kb.card_confirm_admin_kb(rows_str),
                )
            except Exception as e:
                logger.exception("Не удалось отправить скрин оплаты клиента %s (строки %s)", entry.get("client_id"), rows_str)
                await bot.send_message(
                    chat_id,
                    texts.ADMIN_PAYMENT_SEND_FAILED.format(
                        name=entry["name"], row=rows_str, error=e,
                    ),
                )
        else:
            await bot.send_message(
                chat_id, texts.ADMIN_PAYMENT_CASH_PREFIX + caption,
                reply_markup=None if entry["confirmed"] else kb.cash_confirm_admin_kb(rows_str),
            )


# ---------------------------------------------------------------------------
# Pause Club — текст о клубе и розыгрыш (админ)
# ---------------------------------------------------------------------------

@router.callback_query(F.data == "admin_club_panel")
async def admin_club_panel(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    await callback.message.answer("Pause Club:", reply_markup=kb.admin_club_panel_kb())
    await callback.answer()


@router.callback_query(F.data == "admin_club_info")
async def admin_club_info_start(callback: CallbackQuery, state: FSMContext):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    await callback.message.answer(texts.ADMIN_CLUB_INFO_PROMPT)
    await state.set_state(AdminClub.waiting_info)
    await callback.answer()


@router.message(AdminClub.waiting_info)
async def admin_club_info_save(message: Message, state: FSMContext):
    text = (message.text or "").strip()
    if not text:
        await message.answer(texts.ADMIN_CLUB_INFO_PROMPT)
        return
    sheets.set_club_info_text(text)
    await state.clear()
    await message.answer(texts.ADMIN_CLUB_INFO_SAVED)


# ---------------------------------------------------------------------------
# Ежедневный розыгрыш "Пауза в подарок" — просмотр участников в реальном
# времени, отдельно от /giveaway.
# ---------------------------------------------------------------------------

def _tickets_word(n: int) -> str:
    n_abs = abs(n) % 100
    if 11 <= n_abs <= 14:
        return "билетов"
    last = n_abs % 10
    if last == 1:
        return "билет"
    if 2 <= last <= 4:
        return "билета"
    return "билетов"


@router.message(Command("giveaway_today"))
async def cmd_giveaway_today(message: Message):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    date_str = sheets.get_active_menu_date()
    participants = sheets.get_daily_giveaway_participants(date_str)
    if not participants:
        await message.answer(texts.ADMIN_GIVEAWAY_TODAY_EMPTY)
        return

    lines = [texts.ADMIN_GIVEAWAY_TODAY_HEADER.format(date=date_str), ""]
    total = 0
    for p in participants:
        lines.append(f"○ {p['name']} (ID {p['client_id']}) — {p['tickets']} {_tickets_word(p['tickets'])}")
        total += p["tickets"]
    lines.append("")
    lines.append(f"Всего билетов: {total} {_tickets_word(total)}")
    await message.answer("\n".join(lines))


# ---------------------------------------------------------------------------
# Включение/выключение автоматических рассылок клиентам одной командой
# ---------------------------------------------------------------------------

@router.message(Command("broadcasts_off"))
async def cmd_broadcasts_off(message: Message):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    sheets.set_broadcasts_disabled(True)
    await message.answer(texts.ADMIN_BROADCASTS_OFF)


@router.message(Command("broadcasts_on"))
async def cmd_broadcasts_on(message: Message):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    sheets.set_broadcasts_disabled(False)
    await message.answer(texts.ADMIN_BROADCASTS_ON)


@router.message(Command("broadcasts_status"))
async def cmd_broadcasts_status(message: Message):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    if sheets.is_broadcasts_disabled():
        await message.answer(texts.ADMIN_BROADCASTS_STATUS_OFF)
    else:
        await message.answer(texts.ADMIN_BROADCASTS_STATUS_ON)

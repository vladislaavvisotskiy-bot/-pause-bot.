# -*- coding: utf-8 -*-
import asyncio

from aiogram import Router, F, Bot
from aiogram.filters import Command
from aiogram.types import Message, CallbackQuery, BufferedInputFile
from aiogram.fsm.context import FSMContext

import sheets
import texts
import keyboards as kb
import config
import pdf_report
from states import AdminClub, AdminMenu

router = Router()

# Буфер для сбора альбома фотографий меню (Telegram присылает каждое фото
# альбома отдельным сообщением с одним и тем же media_group_id).
_pending_albums: dict = {}
_ALBUM_WAIT = 1.5  # секунд ждём остальные фото альбома, прежде чем сохранить меню


def _is_admin(user_id: int) -> bool:
    return config.ADMIN_CHAT_ID and user_id == config.ADMIN_CHAT_ID


@router.message(Command("admin"))
async def admin_panel(message: Message):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    await message.answer(texts.ADMIN_COMMANDS_LIST)
    await message.answer("Панель администратора:", reply_markup=kb.admin_panel_kb())


@router.callback_query(F.data == "admin_menu_howto")
async def admin_menu_howto(callback: CallbackQuery):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    await callback.message.answer(texts.ADMIN_MENU_HOWTO)
    await callback.answer()


# ---------------------------------------------------------------------------
# Меню на сегодня — координатор просто присылает фото(и) с подписью
# ---------------------------------------------------------------------------

@router.message(F.photo, F.from_user.id == config.ADMIN_CHAT_ID)
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
    sheets.set_today_menu_photos(photo_ids, caption)
    await bot.send_message(chat_id, texts.ADMIN_MENU_SAVED)
    await _broadcast_new_menu(bot)
    await bot.send_message(chat_id, texts.ADMIN_ASK_TODAY_GARNISH)
    await state.set_state(AdminMenu.waiting_garnishes)


async def _broadcast_new_menu(bot: Bot):
    """Персональное оповещение всем клиентам о том, что меню на сегодня
    опубликовано — по имени, в тёплом духе, с кнопкой сразу в «Меню»."""
    for c in sheets.get_broadcast_clients():
        try:
            greeting = texts.NEW_MENU_GREETING.format(name=c.get("name") or "")
            await bot.send_message(int(c["tg_id"]), greeting, reply_markup=kb.menu_broadcast_kb())
        except Exception:
            continue


@router.message(AdminMenu.waiting_garnishes)
async def admin_today_garnish_save(message: Message, state: FSMContext):
    garnishes = [g.strip() for g in (message.text or "").split(",") if g.strip()]
    sheets.set_today_garnishes(garnishes)
    await state.clear()
    if garnishes:
        await message.answer(texts.ADMIN_GARNISH_SAVED.format(list=", ".join(garnishes)))
    else:
        await message.answer(texts.ADMIN_GARNISH_CLEARED)


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
        await callback.message.answer(texts.ADMIN_DEBTORS_EMPTY)
        await callback.answer()
        return

    lines = [texts.ADMIN_DEBTORS_HEADER, ""]
    total = 0
    for d in debtors:
        lines.append(f"○ {d['name']} (ID {d['id']}) — {d['sum']:,} сум".replace(",", " "))
        total += d["sum"]
    lines.append("")
    lines.append(f"Итого: {total:,} сум".replace(",", " "))
    await callback.message.answer("\n".join(lines))
    await callback.answer()


@router.message(Command("kitchen"))
async def cmd_kitchen(message: Message):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    date_str = sheets.get_active_menu_date()
    report = sheets.build_kitchen_report(date_str)
    await message.answer(report or "На сегодня заказов нет.")


@router.message(Command("courier"))
async def cmd_courier(message: Message):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    date_str = sheets.get_active_menu_date()
    report = sheets.build_courier_report(date_str)
    await message.answer(report or "На сегодня заказов нет.")


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
    )


@router.message(Command("kitchen_pdf"))
async def cmd_kitchen_pdf(message: Message, bot: Bot):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    date_str = sheets.get_active_menu_date()
    await send_kitchen_pdf(bot, message.chat.id, date_str)


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


@router.callback_query(F.data == "admin_giveaway")
async def admin_giveaway_start(callback: CallbackQuery, state: FSMContext):
    if not _is_admin(callback.from_user.id):
        await callback.answer(texts.ADMIN_ONLY, show_alert=True)
        return
    await callback.message.answer(texts.ADMIN_GIVEAWAY_PROMPT)
    await state.set_state(AdminClub.waiting_giveaway)
    await callback.answer()


@router.message(AdminClub.waiting_giveaway)
async def admin_giveaway_save(message: Message, state: FSMContext):
    text = (message.text or "").strip()
    if not text:
        await message.answer(texts.ADMIN_GIVEAWAY_PROMPT)
        return
    await state.clear()
    if text.lower() in texts.ADMIN_GIVEAWAY_OFF_WORDS:
        sheets.set_giveaway("", False)
        await message.answer(texts.ADMIN_GIVEAWAY_OFF)
    else:
        sheets.set_giveaway(text, True)
        await message.answer(texts.ADMIN_GIVEAWAY_SAVED)


@router.message(Command("giveaway"))
async def cmd_giveaway(message: Message, state: FSMContext):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    await message.answer(texts.ADMIN_GIVEAWAY_PROMPT)
    await state.set_state(AdminClub.waiting_giveaway)


@router.message(Command("giveaway_finish"))
async def cmd_giveaway_finish(message: Message):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    sheets.set_giveaway("", False)
    await message.answer(texts.ADMIN_GIVEAWAY_OFF)

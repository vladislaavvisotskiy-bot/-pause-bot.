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
from states import AdminClub

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
async def admin_menu_photo(message: Message, bot: Bot):
    file_id = message.photo[-1].file_id
    caption = message.caption or ""
    media_group_id = message.media_group_id

    if not media_group_id:
        await _save_menu_and_notify(bot, message.chat.id, [file_id], caption)
        return

    entry = _pending_albums.get(media_group_id)
    if entry is None:
        entry = {"photos": [], "caption": "", "chat_id": message.chat.id}
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
    await _save_menu_and_notify(bot, entry["chat_id"], entry["photos"], entry["caption"])


async def _save_menu_and_notify(bot: Bot, chat_id: int, photo_ids: list, caption: str):
    sheets.set_today_menu_photos(photo_ids, caption)
    await bot.send_message(chat_id, texts.ADMIN_MENU_SAVED)


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
    date_str = sheets.get_order_date_for_now()
    report = sheets.build_kitchen_report(date_str)
    await message.answer(report or "На сегодня заказов нет.")


@router.message(Command("courier"))
async def cmd_courier(message: Message):
    if not _is_admin(message.from_user.id):
        await message.answer(texts.ADMIN_ONLY)
        return
    date_str = sheets.get_order_date_for_now()
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
    date_str = sheets.get_order_date_for_now()
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

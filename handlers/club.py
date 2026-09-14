# -*- coding: utf-8 -*-
from aiogram import Router, F
from aiogram.types import CallbackQuery
from aiogram.fsm.context import FSMContext

import sheets
import texts
import keyboards as kb

router = Router()


@router.callback_query(F.data == "club_section")
async def club_section(callback: CallbackQuery, state: FSMContext):
    await state.clear()
    client = sheets.find_client_by_tg_id(callback.from_user.id)
    if not client:
        await callback.message.answer("Наберите /start, чтобы зарегистрироваться.")
        await callback.answer()
        return

    level = sheets.get_club_level(client.get("order_count", 0))
    text = texts.CLUB_STATUS_TEMPLATE.format(
        emoji=level["emoji"], label=level["label"], order_count=level["order_count"]
    )
    if level["next_label"]:
        text += texts.CLUB_NEXT_LEVEL_LINE.format(
            left=level["left"], next_emoji=level["next_emoji"], next_label=level["next_label"]
        )
    else:
        text += texts.CLUB_MAX_LEVEL_LINE

    text += texts.CLUB_NEWS_HEADER
    text += sheets.get_club_info_text()

    await callback.message.answer(text, reply_markup=kb.club_kb())

    # Ежедневный розыгрыш "Пауза в подарок" — отдельный блок. Победителя
    # бот больше не выбирает сам (выбор — вручную, вне бота); блок остаётся
    # виден и доступен для участия, пока админ вручную не закроет окно
    # (close_giveaway_window) — снова открывается публикацией нового меню.
    if sheets.is_giveaway_window_closed():
        await callback.message.answer(texts.DAILY_GIVEAWAY_CLOSED_TEXT, reply_markup=kb.home_only_kb())
        await callback.answer()
        return

    date_str = sheets.get_active_menu_date()
    tickets = sheets.get_client_ticket_counts(date_str)
    has_order_today = tickets.get(str(client["id"]), 0) > 0
    is_participating = has_order_today and sheets.is_in_daily_giveaway(date_str, client.get("tg_id"))

    dg_text = texts.DAILY_GIVEAWAY_BLOCK
    if is_participating:
        dg_text += f"\n\n{texts.DAILY_GIVEAWAY_JOINED_TEXT}"
    await callback.message.answer(
        dg_text, reply_markup=kb.daily_giveaway_kb(has_order_today, is_participating)
    )
    await callback.answer()


@router.callback_query(F.data == "daily_giveaway_join")
async def daily_giveaway_join(callback: CallbackQuery):
    client = sheets.find_client_by_tg_id(callback.from_user.id)
    if not client:
        await callback.answer()
        return

    if sheets.is_giveaway_window_closed():
        await callback.message.answer(texts.DAILY_GIVEAWAY_CLOSED_TEXT, reply_markup=kb.home_only_kb())
        await callback.answer()
        return

    date_str = sheets.get_active_menu_date()
    sheets.join_daily_giveaway(date_str, client)
    await callback.message.answer(texts.DAILY_GIVEAWAY_JOINED_TEXT, reply_markup=kb.home_only_kb())
    await callback.answer()

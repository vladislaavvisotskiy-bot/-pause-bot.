# -*- coding: utf-8 -*-
from aiogram import Router, F, Bot
from aiogram.types import CallbackQuery
from aiogram.fsm.context import FSMContext

import sheets
import texts
import keyboards as kb
import config

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

    active, giveaway_text = sheets.get_giveaway()
    text += texts.CLUB_NEWS_HEADER
    text += giveaway_text if active and giveaway_text else sheets.get_club_info_text()

    await callback.message.answer(text, reply_markup=kb.club_kb(giveaway_active=active))
    await callback.answer()


@router.callback_query(F.data == "giveaway_join")
async def giveaway_join(callback: CallbackQuery, bot: Bot):
    client = sheets.find_client_by_tg_id(callback.from_user.id)
    if not client:
        await callback.answer()
        return

    await callback.message.answer(texts.GIVEAWAY_JOINED)

    if config.ADMIN_CHAT_ID:
        try:
            await bot.send_message(
                config.ADMIN_CHAT_ID,
                texts.ADMIN_GIVEAWAY_JOIN_ALERT.format(
                    name=client.get("name", ""), client_id=client.get("id", "")
                ),
            )
        except Exception:
            pass
    await callback.answer()

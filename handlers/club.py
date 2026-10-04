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

    # Ежедневный розыгрыш "Пауза в подарок" в самом боте — временно
    # отключён по просьбе (технические причины, скоро вернётся в новом
    # формате). Раньше здесь показывался блок с условиями и кнопкой
    # "Участвовать" — см. git-историю, если понадобится включить обратно.
    await callback.message.answer(texts.DAILY_GIVEAWAY_DISABLED_TEXT, reply_markup=kb.home_only_kb())
    await callback.answer()


@router.callback_query(F.data == "daily_giveaway_join")
async def daily_giveaway_join(callback: CallbackQuery):
    # Кнопка "🎉 Участвовать" из старых сообщений (до отключения розыгрыша)
    # всё ещё может быть на экране у кого-то — тут только безопасный ответ
    # "не работает", без join_daily_giveaway.
    await callback.message.answer(texts.DAILY_GIVEAWAY_DISABLED_TEXT, reply_markup=kb.home_only_kb())
    await callback.answer()

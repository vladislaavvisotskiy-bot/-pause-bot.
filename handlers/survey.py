# -*- coding: utf-8 -*-
"""Разовый опрос про меню — рассылается через /menu_survey (см.
handlers/admin.py), сам диалог с клиентом (три вопроса свободным текстом)
живёт тут."""
from aiogram import Router, F
from aiogram.types import CallbackQuery, Message
from aiogram.fsm.context import FSMContext

import sheets
import texts
from states import MenuSurvey

router = Router()


def _client_name(tg_id: int, fallback: str) -> str:
    client = sheets.find_client_by_tg_id(tg_id)
    return (client.get("name") if client else "") or fallback or ""


@router.callback_query(F.data == "survey_start")
async def survey_start(callback: CallbackQuery, state: FSMContext):
    try:
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass
    await state.update_data(survey_name=_client_name(callback.from_user.id, callback.from_user.full_name))
    await callback.message.answer(texts.MENU_SURVEY_Q1)
    await state.set_state(MenuSurvey.waiting_answer1)
    await callback.answer()


@router.message(MenuSurvey.waiting_answer1)
async def survey_answer1(message: Message, state: FSMContext):
    text = (message.text or "").strip()
    if not text:
        await message.answer(texts.MENU_SURVEY_Q1)
        return
    await state.update_data(survey_a1=text)
    await message.answer(texts.MENU_SURVEY_Q2)
    await state.set_state(MenuSurvey.waiting_answer2)


@router.message(MenuSurvey.waiting_answer2)
async def survey_answer2(message: Message, state: FSMContext):
    text = (message.text or "").strip()
    if not text:
        await message.answer(texts.MENU_SURVEY_Q2)
        return
    await state.update_data(survey_a2=text)
    await message.answer(texts.MENU_SURVEY_Q3)
    await state.set_state(MenuSurvey.waiting_answer3)


@router.message(MenuSurvey.waiting_answer3)
async def survey_answer3(message: Message, state: FSMContext):
    text = (message.text or "").strip()
    if not text:
        await message.answer(texts.MENU_SURVEY_Q3)
        return
    data = await state.get_data()
    await state.clear()
    sheets.save_menu_survey_answer(
        tg_id=message.from_user.id,
        name=data.get("survey_name", ""),
        answer1=data.get("survey_a1", ""),
        answer2=data.get("survey_a2", ""),
        answer3=text,
    )
    await message.answer(texts.MENU_SURVEY_THANKS)

# -*- coding: utf-8 -*-
from aiogram import Router, F
from aiogram.filters import CommandStart
from aiogram.types import Message, CallbackQuery, ReplyKeyboardRemove
from aiogram.fsm.context import FSMContext

import sheets
import texts
import keyboards as kb
from states import Registration

router = Router()


@router.message(CommandStart())
async def cmd_start(message: Message, state: FSMContext):
    await state.clear()
    client = sheets.find_client_by_tg_id(message.from_user.id)
    if client:
        await message.answer(texts.WELCOME_BACK, reply_markup=kb.main_menu_kb())
        return

    await message.answer(texts.WELCOME_NEW, reply_markup=ReplyKeyboardRemove())
    await message.answer(texts.ASK_NAME)
    await state.set_state(Registration.waiting_name)


@router.message(Registration.waiting_name)
async def got_name(message: Message, state: FSMContext):
    name = (message.text or "").strip()
    if not name:
        await message.answer(texts.ASK_NAME)
        return
    await state.update_data(reg_name=name)
    await message.answer(texts.ASK_PHONE.format(name=name))
    await state.set_state(Registration.waiting_phone)


@router.message(Registration.waiting_phone)
async def got_phone(message: Message, state: FSMContext):
    phone = (message.text or "").strip()
    data = await state.get_data()
    name = data.get("reg_name", message.from_user.full_name)
    username = message.from_user.username or ""

    new_id = sheets.create_client(
        tg_id=message.from_user.id,
        name=name,
        phone=phone,
        telegram_username=username,
    )
    await state.clear()
    await message.answer(texts.REGISTERED)
    await message.answer(texts.MAIN_MENU, reply_markup=kb.main_menu_kb())


@router.callback_query(F.data == "requisites")
async def show_requisites(callback: CallbackQuery):
    await callback.message.answer(
        "Реквизиты для оплаты:\n\n5614 6829 1627 0798\nVladislav Visotskiy"
    )
    await callback.answer()


@router.callback_query(F.data == "back_to_menu")
async def back_to_menu(callback: CallbackQuery, state: FSMContext):
    await state.clear()
    await callback.message.answer(texts.MAIN_MENU, reply_markup=kb.main_menu_kb())
    await callback.answer()

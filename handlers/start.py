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
    await message.answer(texts.ASK_PHONE)
    await state.set_state(Registration.waiting_phone)


@router.message(Registration.waiting_phone)
async def got_phone(message: Message, state: FSMContext):
    phone = (message.text or "").strip()
    data = await state.get_data()
    name = data.get("reg_name", message.from_user.full_name)
    username = message.from_user.username or ""

    # Если такой номер уже есть в CRM (клиент добавлен вручную до бота) —
    # не создаём дубликат, а просто привязываем Telegram ID к его карточке.
    # Имя, уже записанное в таблице, не трогаем — оно может быть точнее
    # того, что человек ввёл в боте.
    existing = sheets.find_client_by_phone(phone)
    if existing:
        sheets.link_tg_id_to_client(existing["row"], message.from_user.id)
        greeting_name = existing.get("name") or name
    else:
        sheets.create_client(
            tg_id=message.from_user.id,
            name=name,
            phone=phone,
            telegram_username=username,
        )
        greeting_name = name
    await state.clear()
    await message.answer(texts.REGISTERED.format(name=greeting_name))
    await message.answer(texts.MAIN_MENU, reply_markup=kb.main_menu_kb())


@router.callback_query(F.data == "support")
async def show_support(callback: CallbackQuery, state: FSMContext):
    await state.clear()
    await callback.message.answer(texts.SUPPORT_INFO, reply_markup=kb.home_only_kb())
    await callback.answer()


@router.callback_query(F.data == "back_to_menu")
async def back_to_menu(callback: CallbackQuery, state: FSMContext):
    await state.clear()
    await callback.message.answer(texts.MAIN_MENU, reply_markup=kb.main_menu_kb())
    await callback.answer()

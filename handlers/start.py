# -*- coding: utf-8 -*-
from aiogram import Router, F
from aiogram.filters import CommandStart, Command
from aiogram.types import Message, CallbackQuery, ReplyKeyboardRemove
from aiogram.fsm.context import FSMContext

import config
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
        if config.MINIAPP_ONLY and message.from_user.id not in config.ADMIN_IDS:
            await message.answer(texts.WELCOME_BACK_APP, reply_markup=kb.main_menu_kb(message.from_user.id))
        else:
            await message.answer(texts.WELCOME_BACK, reply_markup=kb.main_menu_kb(message.from_user.id))
        return

    await message.answer(texts.WELCOME_NEW, reply_markup=ReplyKeyboardRemove(), parse_mode="HTML")
    await message.answer(texts.ASK_NAME)
    await state.set_state(Registration.waiting_name)


@router.message(Registration.waiting_name)
async def got_name(message: Message, state: FSMContext):
    name = (message.text or "").strip()
    if not name:
        await message.answer(texts.ASK_NAME)
        return
    await state.update_data(reg_name=name)
    await message.answer(texts.ASK_PHONE.format(name=name), reply_markup=kb.share_contact_kb())
    await state.set_state(Registration.waiting_phone)


@router.message(Registration.waiting_phone)
async def got_phone(message: Message, state: FSMContext):
    contact = message.contact
    if contact:
        # "Поделиться контактом" — принимаем только СВОЙ контакт.
        if contact.user_id and contact.user_id != message.from_user.id:
            await message.answer(texts.ASK_PHONE.format(name=(await state.get_data()).get("reg_name", "")), reply_markup=kb.share_contact_kb())
            return
        raw = contact.phone_number or ""
        phone = sheets.format_uz_phone(raw)
        if not phone:
            # Иностранный номер из Telegram — записываем как есть, с "+"
            digits = "".join(ch for ch in raw if ch.isdigit())
            phone = ("+" + digits) if 7 <= len(digits) <= 15 else None
    else:
        phone = sheets.format_uz_phone(message.text or "")
    if not phone:
        await message.answer(texts.PHONE_INVALID, reply_markup=kb.share_contact_kb())
        return
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
    app_kb = kb.open_pauseapp_kb() if config.WEBAPP_URL else None
    # Убираем клавиатуру "Поделиться контактом": сообщение-пустышка с
    # ReplyKeyboardRemove и сразу удаляем, чтобы не мусорить в чате.
    try:
        tmp = await message.answer("✅", reply_markup=ReplyKeyboardRemove())
        await tmp.delete()
    except Exception:
        pass
    await message.answer(texts.REGISTERED.format(name=greeting_name), reply_markup=app_kb)
    if not config.MINIAPP_ONLY or message.from_user.id in config.ADMIN_IDS:
        await message.answer(texts.MAIN_MENU, reply_markup=kb.main_menu_kb(message.from_user.id))


@router.message(Command("pauseapp"))
async def cmd_pauseapp_test(message: Message):
    """ВРЕМЕННО, по прямой просьбе пользователя: обычная кнопка входа в
    PAUSE App живёт только в /admin (keyboards.admin_panel_kb), а туда
    пускают строго config.ADMIN_IDS. Аккаунтам из config.
    PAUSEAPP_TEST_CLIENT_IDS (временный тестовый доступ как к обычному
    клиенту, см. pauseapp.admin_auth_middleware) физически неоткуда было
    взять кнопку запуска — эта команда просто её присылает, никаких
    дополнительных прав не даёт. Для всех остальных — тихо ничего не
    делаем, не выдавая существование команды."""
    uid = message.from_user.id
    if uid not in config.ADMIN_IDS and uid not in config.PAUSEAPP_TEST_CLIENT_IDS:
        return
    if not config.WEBAPP_URL:
        return
    await message.answer("PAUSE App:", reply_markup=kb.pauseapp_test_kb())


@router.callback_query(F.data == "support")
async def show_support(callback: CallbackQuery, state: FSMContext):
    await state.clear()
    await callback.message.answer(texts.SUPPORT_INFO, reply_markup=kb.home_only_kb())
    await callback.answer()


@router.callback_query(F.data == "back_to_menu")
async def back_to_menu(callback: CallbackQuery, state: FSMContext):
    await state.clear()
    await callback.message.answer(texts.MAIN_MENU, reply_markup=kb.main_menu_kb(callback.from_user.id))
    await callback.answer()

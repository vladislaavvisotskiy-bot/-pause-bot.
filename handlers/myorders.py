# -*- coding: utf-8 -*-
from aiogram import Router, F, Bot
from aiogram.types import CallbackQuery, Message
from aiogram.fsm.context import FSMContext

import sheets
import texts
import keyboards as kb
import config
from states import EditProfile

router = Router()


@router.callback_query(F.data == "my_orders")
async def my_orders(callback: CallbackQuery):
    client = sheets.find_client_by_tg_id(callback.from_user.id)
    if not client:
        await callback.message.answer("Наберите /start, чтобы зарегистрироваться.")
        await callback.answer()
        return

    orders = sheets.get_client_orders(client["id"])
    if not orders:
        await callback.message.answer(texts.MY_ORDERS_EMPTY, reply_markup=kb.my_orders_kb())
        await callback.answer()
        return

    lines = [texts.MY_ORDERS_HEADER, ""]
    for o in orders:
        line = f"{o['date']} — {o['qty']}× {o['set']}"
        if o["payment"] == "В долг":
            line += " (в долг)"
        lines.append(line)

    debt = sheets.get_client_debt(client["id"])
    text = "\n".join(lines)
    if debt > 0:
        text += texts.MY_DEBT_LINE.format(sum=debt)

    await callback.message.answer(text, reply_markup=kb.my_orders_kb())
    await callback.answer()


# ---------------------------------------------------------------------------
# Редактирование своих данных (личный кабинет)
# ---------------------------------------------------------------------------

@router.callback_query(F.data == "edit_profile")
async def edit_profile_menu(callback: CallbackQuery):
    await callback.message.answer(texts.EDIT_PROFILE_HEADER, reply_markup=kb.edit_profile_kb())
    await callback.answer()


@router.callback_query(F.data == "edit_name")
async def edit_name_start(callback: CallbackQuery, state: FSMContext):
    await callback.message.answer(texts.EDIT_NAME_PROMPT)
    await state.set_state(EditProfile.waiting_name)
    await callback.answer()


@router.message(EditProfile.waiting_name)
async def edit_name_save(message: Message, state: FSMContext):
    name = (message.text or "").strip()
    if not name:
        await message.answer(texts.EDIT_NAME_PROMPT)
        return
    client = sheets.find_client_by_tg_id(message.from_user.id)
    if client:
        sheets.update_client_field(client["row"], config.COL_NAME, name)
    await state.clear()
    await message.answer(texts.EDIT_SAVED)
    await message.answer(texts.MAIN_MENU, reply_markup=kb.main_menu_kb())


@router.callback_query(F.data == "edit_phone")
async def edit_phone_start(callback: CallbackQuery, state: FSMContext):
    await callback.message.answer(texts.EDIT_PHONE_PROMPT)
    await state.set_state(EditProfile.waiting_phone)
    await callback.answer()


@router.message(EditProfile.waiting_phone)
async def edit_phone_save(message: Message, state: FSMContext):
    phone = (message.text or "").strip()
    if not phone:
        await message.answer(texts.EDIT_PHONE_PROMPT)
        return
    client = sheets.find_client_by_tg_id(message.from_user.id)
    if client:
        sheets.update_client_field(client["row"], config.COL_CONTACT, phone)
    await state.clear()
    await message.answer(texts.EDIT_SAVED)
    await message.answer(texts.MAIN_MENU, reply_markup=kb.main_menu_kb())


@router.callback_query(F.data == "edit_point")
async def edit_point_start(callback: CallbackQuery, state: FSMContext):
    zones = sheets.get_zones()
    await callback.message.answer(texts.CHOOSE_ZONE, reply_markup=kb.options_kb(zones, "editzone"))
    await state.set_state(EditProfile.choosing_zone)
    await callback.answer()


@router.callback_query(EditProfile.choosing_zone, F.data.startswith("editzone:"))
async def edit_point_zone(callback: CallbackQuery, state: FSMContext):
    zone = callback.data.split(":", 1)[1]
    await state.update_data(edit_zone=zone)
    points = sheets.get_points(zone)
    if points:
        await callback.message.answer(texts.CHOOSE_POINT,
                                       reply_markup=kb.options_kb(points, "editpoint", other=True))
        await state.set_state(EditProfile.choosing_point)
    else:
        await callback.message.answer(texts.ASK_NEW_POINT)
        await state.set_state(EditProfile.entering_new_point)
    await callback.answer()


@router.callback_query(EditProfile.choosing_point, F.data.startswith("editpoint:"))
async def edit_point_point(callback: CallbackQuery, state: FSMContext, bot: Bot):
    point = callback.data.split(":", 1)[1]
    if point == "__other__":
        await callback.message.answer(texts.ASK_NEW_POINT)
        await state.set_state(EditProfile.entering_new_point)
        await callback.answer()
        return
    await _save_point(callback.from_user.id, state, point, bot, is_new=False)
    await callback.answer()


@router.message(EditProfile.entering_new_point)
async def edit_point_new(message: Message, state: FSMContext, bot: Bot):
    point = (message.text or "").strip()
    if not point:
        await message.answer(texts.ASK_NEW_POINT)
        return
    await _save_point(message.from_user.id, state, point, bot, is_new=True)


async def _save_point(tg_id: int, state: FSMContext, point: str, bot: Bot, is_new: bool):
    data = await state.get_data()
    zone = data.get("edit_zone", "")
    client = sheets.find_client_by_tg_id(tg_id)
    if client:
        sheets.update_client_point(client["row"], zone, point)
        if is_new and config.ADMIN_CHAT_ID:
            try:
                await bot.send_message(
                    config.ADMIN_CHAT_ID,
                    texts.ADMIN_NEW_POINT_ALERT.format(
                        name=client.get("name", ""),
                        client_id=client.get("id", ""),
                        zone=zone,
                        point=point,
                    ),
                )
            except Exception:
                pass
    await state.clear()
    await bot.send_message(tg_id, texts.EDIT_SAVED)
    await bot.send_message(tg_id, texts.MAIN_MENU, reply_markup=kb.main_menu_kb())

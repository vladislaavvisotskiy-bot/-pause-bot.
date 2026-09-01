# -*- coding: utf-8 -*-
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton
from aiogram.utils.keyboard import InlineKeyboardBuilder

import texts


def main_menu_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text="🛒 Заказать", callback_data="order_start")
    b.button(text="📋 Мои заказы", callback_data="my_orders")
    b.button(text="💳 Реквизиты", callback_data="requisites")
    b.button(text=texts.SUPPORT_BTN, callback_data="support")
    b.adjust(1)
    return b.as_markup()


def options_kb(options: list, prefix: str, back: bool = False, other: bool = False) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    for opt in options:
        b.button(text=opt, callback_data=f"{prefix}:{opt}")
    if other:
        b.button(text=texts.OTHER_BTN, callback_data=f"{prefix}:__other__")
    if back:
        b.button(text=texts.BACK_BTN, callback_data=f"{prefix}:__back__")
    b.adjust(1)
    return b.as_markup()


def set_kb(sets: list) -> InlineKeyboardMarkup:
    """Кнопки выбора сета — показывают клиенту дружелюбное название
    («Пауза дня»/«Для тебя»), а в callback_data и в таблицу по-прежнему
    уходит исходное название из Справочников."""
    b = InlineKeyboardBuilder()
    for opt in sets:
        b.button(text=texts.display_set_name(opt), callback_data=f"set:{opt}")
    b.adjust(1)
    return b.as_markup()


def garnish_kb(options: list) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    for opt in options:
        b.button(text=opt, callback_data=f"garnish:{opt}")
    b.button(text=texts.MIX_GARNISH_BTN, callback_data="garnish:__mix__")
    b.adjust(1)
    return b.as_markup()


def qty_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    for n in range(1, 6):
        b.button(text=str(n), callback_data=f"qty:{n}")
    b.adjust(5)
    return b.as_markup()


def yes_no_kb(yes_cb: str, no_cb: str, yes_text="Да, ещё один", no_text="Нет, дальше") -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=yes_text, callback_data=yes_cb)
    b.button(text=no_text, callback_data=no_cb)
    b.adjust(1)
    return b.as_markup()


def skip_kb(cb="clarify:skip") -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.SKIP_BTN, callback_data=cb)
    return b.as_markup()


def card_payment_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.CARD_SEND_NOW_BTN, callback_data="card_now")
    b.button(text=texts.CARD_LATER_BTN, callback_data="card_later")
    b.adjust(1)
    return b.as_markup()


def card_confirm_admin_kb(rows_str: str) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text="✅ Подтверждено", callback_data=f"cardok:{rows_str}")
    return b.as_markup()


def confirm_order_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.ORDER_CONFIRM_BTN, callback_data="order_confirm")
    b.button(text=texts.ORDER_CANCEL_BTN, callback_data="order_cancel")
    b.adjust(1)
    return b.as_markup()


def my_orders_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.EDIT_PROFILE_BTN, callback_data="edit_profile")
    b.button(text=texts.CANCEL_ORDER_BTN, callback_data="cancel_order_start")
    b.button(text=texts.FEEDBACK_BTN, callback_data="leave_feedback")
    b.button(text=texts.BACK_BTN, callback_data="back_to_menu")
    b.adjust(1)
    return b.as_markup()


def cancel_confirm_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.CANCEL_CONFIRM_YES, callback_data="cancel_order_yes")
    b.button(text=texts.CANCEL_CONFIRM_NO, callback_data="cancel_order_no")
    b.adjust(1)
    return b.as_markup()


def edit_profile_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.EDIT_NAME_BTN, callback_data="edit_name")
    b.button(text=texts.EDIT_PHONE_BTN, callback_data="edit_phone")
    b.button(text=texts.EDIT_POINT_BTN, callback_data="edit_point")
    b.button(text=texts.BACK_BTN, callback_data="back_to_menu")
    b.adjust(1)
    return b.as_markup()


def admin_panel_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text="📝 Как загрузить меню", callback_data="admin_menu_howto")
    b.button(text="💰 Должники", callback_data="admin_debtors")
    b.adjust(1)
    return b.as_markup()

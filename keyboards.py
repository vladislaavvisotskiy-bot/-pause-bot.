# -*- coding: utf-8 -*-
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton
from aiogram.utils.keyboard import InlineKeyboardBuilder

import texts


def _home(b: InlineKeyboardBuilder):
    b.button(text=texts.HOME_BTN, callback_data="back_to_menu")


def home_only_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    _home(b)
    return b.as_markup()


def main_menu_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.PROFILE_BTN, callback_data="profile_section")
    b.button(text=texts.MENU_BTN, callback_data="menu_section")
    b.button(text=texts.CLUB_BTN, callback_data="club_section")
    b.button(text=texts.SUPPORT_BTN, callback_data="support")
    b.adjust(1)
    return b.as_markup()


def options_kb(options: list, prefix: str, back: bool = False, other: bool = False, home: bool = True, display=None) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    for opt in options:
        label = display(opt) if display else opt
        b.button(text=label, callback_data=f"{prefix}:{opt}")
    if other:
        b.button(text=texts.OTHER_BTN, callback_data=f"{prefix}:__other__")
    if back:
        b.button(text=texts.BACK_BTN, callback_data=f"{prefix}:__back__")
    if home:
        _home(b)
    b.adjust(1)
    return b.as_markup()


def set_kb(sets: list, back: bool = False) -> InlineKeyboardMarkup:
    """Кнопки выбора сета — показывают клиенту дружелюбное название
    («Пауза дня»/«Для тебя»), а в callback_data и в таблицу по-прежнему
    уходит исходное название из Справочников."""
    b = InlineKeyboardBuilder()
    for opt in sets:
        b.button(text=texts.display_set_name(opt), callback_data=f"set:{opt}")
    if back:
        b.button(text=texts.BACK_BTN, callback_data="set:__back__")
    _home(b)
    b.adjust(1)
    return b.as_markup()


def garnish_kb(options: list, back: bool = False) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    for opt in options:
        b.button(text=texts.display_garnish(opt), callback_data=f"garnish:{opt}")
    if len(options) >= 2:
        b.button(text=texts.MIX_GARNISH_BTN, callback_data="garnish:__mix__")
    if back:
        b.button(text=texts.BACK_BTN, callback_data="garnish:__back__")
    b.adjust(1)
    return b.as_markup()


def default_point_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.DEFAULT_POINT_YES_BTN, callback_data="default_point_yes")
    b.button(text=texts.DEFAULT_POINT_CHANGE_BTN, callback_data="default_point_change")
    _home(b)
    b.adjust(1)
    return b.as_markup()


def qty_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    for n in range(1, 6):
        b.button(text=str(n), callback_data=f"qty:{n}")
    b.button(text=texts.BACK_BTN, callback_data="qty:__back__")
    b.adjust(5, 1)
    return b.as_markup()


def yes_no_kb(yes_cb: str, no_cb: str, yes_text="Да", no_text="Нет") -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=yes_text, callback_data=yes_cb)
    b.button(text=no_text, callback_data=no_cb)
    b.adjust(1)
    return b.as_markup()


def card_payment_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.CARD_SEND_NOW_BTN, callback_data="card_now")
    b.button(text=texts.CARD_LATER_BTN, callback_data="card_later")
    b.button(text=texts.BACK_BTN, callback_data="card_decision_back")
    b.adjust(1)
    return b.as_markup()


def card_confirm_admin_kb(rows_str: str) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text="✅ Подтверждено", callback_data=f"cardok:{rows_str}")
    return b.as_markup()


def pending_point_admin_kb(pending_id: str) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.ADMIN_PENDING_APPROVE_BTN, callback_data=f"pendok:{pending_id}")
    b.button(text=texts.ADMIN_PENDING_DENY_BTN, callback_data=f"penddeny:{pending_id}")
    b.adjust(1)
    return b.as_markup()


def confirm_order_kb(has_comment: bool = False) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.ORDER_CONFIRM_BTN, callback_data="order_confirm")
    comment_text = texts.EDIT_COMMENT_BTN if has_comment else texts.ADD_COMMENT_BTN
    b.button(text=comment_text, callback_data="add_comment")
    b.button(text=texts.ORDER_CANCEL_BTN, callback_data="order_cancel")
    _home(b)
    b.adjust(1)
    return b.as_markup()


# ---------------------------------------------------------------------------
# Раздел «Профиль»
# ---------------------------------------------------------------------------

def profile_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.EDIT_PROFILE_BTN, callback_data="edit_profile")
    b.button(text=texts.MY_ORDERS_LINK_BTN, callback_data="my_orders")
    _home(b)
    b.adjust(1)
    return b.as_markup()


def my_orders_kb(order_groups: list, show_cancel: bool) -> InlineKeyboardMarkup:
    """order_groups — список заказов клиента (сгруппированных по дате, самые
    новые первые); под каждым — своя кнопка отзыва. Кнопка отмены — только
    для самого свежего заказа и только если show_cancel=True."""
    b = InlineKeyboardBuilder()
    if show_cancel:
        b.button(text=texts.CANCEL_ORDER_BTN, callback_data="cancel_order_start")
    for g in order_groups:
        first_row = g["rows"][0]
        b.button(text=texts.FEEDBACK_BTN.format(date=g["date"]), callback_data=f"feedback:{first_row}")
    _home(b)
    b.adjust(1)
    return b.as_markup()


def cancel_confirm_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.CANCEL_CONFIRM_YES, callback_data="cancel_order_yes")
    b.button(text=texts.CANCEL_CONFIRM_NO, callback_data="cancel_order_no")
    _home(b)
    b.adjust(1)
    return b.as_markup()


def edit_profile_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.EDIT_NAME_BTN, callback_data="edit_name")
    b.button(text=texts.EDIT_PHONE_BTN, callback_data="edit_phone")
    b.button(text=texts.EDIT_POINT_BTN, callback_data="edit_point")
    _home(b)
    b.adjust(1)
    return b.as_markup()


# ---------------------------------------------------------------------------
# Раздел «Pause Club»
# ---------------------------------------------------------------------------

def club_kb(giveaway_active: bool) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    if giveaway_active:
        b.button(text=texts.GIVEAWAY_PARTICIPATE_BTN, callback_data="giveaway_join")
    _home(b)
    b.adjust(1)
    return b.as_markup()


# ---------------------------------------------------------------------------
# Админ
# ---------------------------------------------------------------------------

def admin_panel_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text="📝 Как загрузить меню", callback_data="admin_menu_howto")
    b.button(text="💰 Должники", callback_data="admin_debtors")
    b.button(text=texts.ADMIN_CLUB_PANEL_BTN, callback_data="admin_club_panel")
    b.adjust(1)
    return b.as_markup()


def admin_club_panel_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.ADMIN_CLUB_INFO_BTN, callback_data="admin_club_info")
    b.button(text=texts.ADMIN_GIVEAWAY_BTN, callback_data="admin_giveaway")
    b.adjust(1)
    return b.as_markup()

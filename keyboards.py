# -*- coding: utf-8 -*-
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from aiogram.utils.keyboard import InlineKeyboardBuilder

import config
import sheets
import texts


def _home(b: InlineKeyboardBuilder):
    b.button(text=texts.HOME_BTN, callback_data="back_to_menu")


def home_only_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    _home(b)
    return b.as_markup()


def main_menu_kb(tg_id: int = None) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.PROFILE_BTN, callback_data="profile_section")
    b.button(text=texts.MENU_BTN, callback_data="menu_section")
    b.button(text=texts.CLUB_BTN, callback_data="club_section")
    b.button(text=texts.SUPPORT_BTN, callback_data="support")

    # Кнопка "Администратор" видна только самому админу — открывает ту же
    # панель /admin, что и текстовая команда (кнопка маршрута для него
    # переехала внутрь этой панели, см. admin_panel_kb).
    if tg_id in config.ADMIN_IDS:
        b.button(text=texts.ADMIN_PANEL_BTN, callback_data="admin_panel_open")

    # Кнопка маршрута для курьера — тот же Mini App, режим (можно ли
    # редактировать) определяется на сервере по роли из initData. Пока
    # WEBAPP_URL не задан (например, публичный домен на Railway ещё не
    # сгенерирован) — кнопку вообще не показываем, чтобы не давать
    # клиентам нерабочую ссылку.
    if config.WEBAPP_URL and tg_id is not None and sheets.is_courier(tg_id):
        b.button(text=texts.COURIER_ROUTE_BTN, web_app=WebAppInfo(url=f"{config.WEBAPP_URL}/miniapp"))

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
    уходит исходное название из Справочников.

    Сет с переменной ценой (см. config.SET_VARIANTS, например "Самса" —
    технически два разных сета с разной ценой) показывается ОДНОЙ кнопкой,
    а не двумя дублирующими друг друга — дальше отдельный шаг выбора
    варианта (см. set_variant_kb) сам решает, какое из двух технических
    имён записать в заказ."""
    b = InlineKeyboardBuilder()
    shown_variant_groups = set()
    for opt in sets:
        group = config.SET_VARIANT_GROUP.get(opt.strip())
        if group:
            if group in shown_variant_groups:
                continue
            shown_variant_groups.add(group)
            b.button(text=texts.display_set_name(group), callback_data=f"set:__variant__:{group}")
        else:
            b.button(text=texts.display_set_name(opt), callback_data=f"set:{opt}")
    if back:
        b.button(text=texts.BACK_BTN, callback_data="set:__back__")
    _home(b)
    b.adjust(1)
    return b.as_markup()


def set_variant_kb(group: str, prices: dict) -> InlineKeyboardMarkup:
    """Шаг выбора варианта переменной цены (см. config.SET_VARIANTS) —
    кнопка с ценой на каждый вариант, цена берётся из Справочники в момент
    показа (не хранится в коде), чтобы админ мог поменять её там же, где
    все остальные цены."""
    b = InlineKeyboardBuilder()
    for technical, label in config.SET_VARIANTS[group]:
        price = prices.get(technical, 0)
        price_text = f"{price:,}".replace(",", " ")
        b.button(text=f"{label} — {price_text} uzs", callback_data=f"setvariant:{technical}")
    b.button(text=texts.BACK_BTN, callback_data="setvariant:__back__")
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
    b.button(text="✅ Подтвердить", callback_data=f"cardok:{rows_str}")
    return b.as_markup()


def cash_confirm_admin_kb(rows_str: str) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text="✅ Подтвердить", callback_data=f"cashok:{rows_str}")
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
    b.button(text=texts.ORDER_RESTART_BTN, callback_data="order_restart")
    comment_text = texts.EDIT_COMMENT_BTN if has_comment else texts.ADD_COMMENT_BTN
    b.button(text=comment_text, callback_data="add_comment")
    b.adjust(1)
    return b.as_markup()


def menu_broadcast_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.MENU_BROADCAST_BTN, callback_data="menu_section")
    b.adjust(1)
    return b.as_markup()


def route_ready_kb(url: str) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.ROUTE_READY_BTN, web_app=WebAppInfo(url=url))
    b.adjust(1)
    return b.as_markup()


def admin_survey_confirm_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.ADMIN_SURVEY_CONFIRM_YES_BTN, callback_data="survey_broadcast_yes")
    b.button(text=texts.ADMIN_SURVEY_CONFIRM_NO_BTN, callback_data="survey_broadcast_no")
    b.adjust(1)
    return b.as_markup()


def menu_survey_start_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.MENU_SURVEY_START_BTN, callback_data="survey_start")
    b.adjust(1)
    return b.as_markup()


# ---------------------------------------------------------------------------
# Раздел «Профиль»
# ---------------------------------------------------------------------------

def profile_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.EDIT_PROFILE_BTN, callback_data="edit_profile")
    b.button(text=texts.MY_ORDERS_LINK_BTN, callback_data="my_orders")
    b.button(text=texts.MY_MESSAGES_BTN, callback_data="my_messages")
    _home(b)
    b.adjust(1)
    return b.as_markup()


def my_orders_kb(order_groups: list, show_cancel: bool) -> InlineKeyboardMarkup:
    """order_groups — список заказов клиента (сгруппированных по дате, самые
    новые первые); под каждым — своя кнопка отзыва, и кнопка "Прикрепить
    скрин" для тех, что ждут скрина оплаты картой (столбец K пуст). Кнопка
    отмены — только для самого свежего заказа и только если show_cancel=True."""
    b = InlineKeyboardBuilder()
    if show_cancel:
        b.button(text=texts.CANCEL_ORDER_BTN, callback_data="cancel_order_start")
    for g in order_groups:
        first_row = g["rows"][0]
        if not g["canceled"] and not (g.get("payment") or "").strip():
            rows_str = ",".join(str(r) for r in g["rows"])
            b.button(text=texts.ATTACH_SCREENSHOT_BTN, callback_data=f"sendscreen:{rows_str}")
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

def club_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    _home(b)
    b.adjust(1)
    return b.as_markup()


def daily_giveaway_kb(has_order_today: bool, is_participating: bool) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    if not has_order_today:
        # Тот же переход, что и по кнопке "💌 Меню" — показ меню и сразу в заказ.
        b.button(text=texts.DAILY_GIVEAWAY_ORDER_BTN, callback_data="menu_section")
    elif not is_participating:
        b.button(text=texts.DAILY_GIVEAWAY_JOIN_BTN, callback_data="daily_giveaway_join")
    _home(b)
    b.adjust(1)
    return b.as_markup()


# ---------------------------------------------------------------------------
# Админ
# ---------------------------------------------------------------------------

def admin_back_kb(target: str = "panel") -> InlineKeyboardMarkup:
    """Одна кнопка «‹ Назад» — используется внутри отдельных разделов
    панели /admin, чтобы вернуться на экран выше (см. admin_back в
    handlers/admin.py)."""
    b = InlineKeyboardBuilder()
    b.button(text=texts.BACK_BTN, callback_data=f"admin_back:{target}")
    return b.as_markup()


def admin_panel_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.ADMIN_KITCHEN_REPORT_BTN, callback_data="admin_kitchen_report")
    b.button(text=texts.ADMIN_COURIER_REPORT_BTN, callback_data="admin_courier_report")
    b.button(text=texts.ADMIN_PAYMENTS_BTN, callback_data="admin_payments_report")
    b.button(text=texts.ADMIN_BROADCAST_BTN, callback_data="admin_broadcast_panel")
    b.button(text="💰 Должники", callback_data="admin_debtors")
    b.button(text=texts.ADMIN_CLUB_PANEL_BTN, callback_data="admin_club_panel")
    if config.WEBAPP_URL:
        b.button(text=texts.ADMIN_ROUTE_BTN, web_app=WebAppInfo(url=f"{config.WEBAPP_URL}/miniapp"))
    # "Главное меню" — предпоследней, "Инструкция" — всегда самой
    # последней, независимо от того, сколько кнопок выше появится в
    # будущем.
    b.button(text=texts.HOME_BTN, callback_data="back_to_menu")
    b.button(text=texts.ADMIN_INSTRUCTIONS_BTN, callback_data="admin_instructions")
    b.adjust(1)
    return b.as_markup()


def admin_kitchen_format_kb(date_str: str) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.ADMIN_KITCHEN_FORMAT_PDF_BTN, callback_data=f"kitchenfmt:pdf:{date_str}")
    b.button(text=texts.ADMIN_KITCHEN_FORMAT_TEXT_BTN, callback_data=f"kitchenfmt:text:{date_str}")
    b.button(text=texts.BACK_BTN, callback_data="admin_back:kitchen_dates")
    b.adjust(1)
    return b.as_markup()


def admin_broadcast_toggle_kb(disabled: bool) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    if disabled:
        b.button(text=texts.ADMIN_BROADCAST_TOGGLE_ON_BTN, callback_data="broadcast_toggle_on")
    else:
        b.button(text=texts.ADMIN_BROADCAST_TOGGLE_OFF_BTN, callback_data="broadcast_toggle_off")
    b.button(text=texts.BACK_BTN, callback_data="admin_back:panel")
    b.adjust(1)
    return b.as_markup()


def admin_club_panel_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.ADMIN_CLUB_INFO_BTN, callback_data="admin_club_info")
    b.button(text=texts.BACK_BTN, callback_data="admin_back:panel")
    b.adjust(1)
    return b.as_markup()


def report_dates_kb(report_type: str, dates: list) -> InlineKeyboardMarkup:
    """Кнопки выбора даты для отчётов /kitchen, /kitchen_pdf, /courier —
    dates в формате DD.MM.YYYY, на кнопке показываем короче — DD.MM."""
    b = InlineKeyboardBuilder()
    for d in dates:
        b.button(text=d[:5], callback_data=f"adminrep:{report_type}:{d}")
    b.adjust(4)
    b.row(InlineKeyboardButton(text=texts.BACK_BTN, callback_data="admin_back:panel"))
    return b.as_markup()


def admin_garnish_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.ADMIN_GARNISH_NONE_BTN, callback_data="garnish_none")
    b.adjust(1)
    return b.as_markup()


def admin_sets_kb() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.ADMIN_SETS_ALL_BTN, callback_data="sets_all")
    b.adjust(1)
    return b.as_markup()


def admin_menu_date_kb(today_str: str, tomorrow_str: str) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.ADMIN_DATE_TODAY_BTN.format(date=today_str), callback_data=f"menudate:{today_str}")
    b.button(text=texts.ADMIN_DATE_TOMORROW_BTN.format(date=tomorrow_str), callback_data=f"menudate:{tomorrow_str}")
    b.adjust(1)
    return b.as_markup()


def reminder_screenshot_kb(rows_str: str) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text=texts.ATTACH_SCREENSHOT_BTN, callback_data=f"sendscreen:{rows_str}")
    b.adjust(1)
    return b.as_markup()

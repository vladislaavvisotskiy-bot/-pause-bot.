# -*- coding: utf-8 -*-
"""
Слой работы с Google Таблицей. Всё общение с гугл-таблицей PAUSE идёт только
через эти функции — если завтра поменяются столбцы, править нужно только тут.
"""
import json
import random
import threading
import uuid
import re
import time
import datetime as dt
from typing import Optional
from zoneinfo import ZoneInfo

import gspread
from google.oauth2.service_account import Credentials

import config
import texts

_SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
]

# Весь бизнес (отсечки заказов, дата активного меню и т.п.) живёт по
# времени Ташкента — сервер (например, Railway) может физически работать
# в другом часовом поясе (обычно UTC), поэтому голое datetime.now() без
# явной таймзоны для сравнений "сейчас" использовать нельзя: результат
# будет зависеть от того, где именно запущен процесс, а не от реального
# времени в Ташкенте.
TASHKENT_TZ = ZoneInfo("Asia/Tashkent")


def _now() -> dt.datetime:
    return dt.datetime.now(TASHKENT_TZ)

_client = None
_sheet = None
_cache = {
    "clients": None, "clients_ts": 0,
    "couriers": None, "couriers_ts": 0,
    "delivery_points": None, "delivery_points_ts": 0,
    "active_menu_date": None, "active_menu_date_ts": 0,
    "order_dates": None, "order_dates_ts": 0,
    "route_visibility": None, "route_visibility_ts": 0,
    "pause_admins": None, "pause_admins_ts": 0,
}
_CACHE_TTL = 60  # секунд — не дёргаем таблицу на каждый чих

# Отдельный, короткий кэш посчитанного маршрута на дату — целиком то, что
# возвращает get_route_for_date(). Обычные ссылки/чтения (_CACHE_TTL=60с
# выше) сюда не подходят: правки в "Маршрут" (перетаскивание, отметка
# "Сдано", удаление точки) должны быть видны СРАЗУ тому, кто их сделал, а
# не через минуту. Но именно ПОВТОРНЫЕ открытия экрана без единой правки
# между ними (ровно то, что происходит, когда человек несколько раз подряд
# открывает Mini App) не должны каждый раз заново вычитывать три листа
# ("Заказы", "Маршрут", "Точки доставки") — воспроизведено вживую: 15
# открытий подряд упирались в лимит Google Sheets API "429 Quota exceeded"
# уже на 7-м, несмотря на то что каждый отдельный запрос стал легче (см.
# sync_daily_route/get_route_for_date выше). Короткий TTL (несколько секунд)
# полностью снимает эту нагрузку от повторных открытий, но не мешает
# реальной работе: любое мутирующее действие (см. _invalidate_route_cache)
# сбрасывает кэш немедленно, так что тот, кто только что нажал
# "Сдано"/перетащил/удалил, при следующей же загрузке видит свежие данные,
# а не устаревшие до истечения TTL.
_route_cache: dict = {}
_ROUTE_CACHE_TTL = 5  # секунд

# Сырые строки "Маршрут" ЦЕЛИКОМ (не за одну дату, как _route_cache выше) —
# только для get_route_kpi, который читает лист за произвольный диапазон
# дат и ничего в нём не меняет. KPI теперь смотрят по нескольку раз подряд
# (день-пилюли "Сегодня"/"Вчера"/даты/"7 дней"/"30 дней" в один прокручиваемый
# ряд — см. app.js: kpiDayPeriods) — без кэша каждый клик по пилюле заново
# читал весь растущий лист "Маршрут", как и было с "Заказы" (см. комментарий
# у _orders_raw_rows). Инвалидируется тем же _invalidate_route_cache, что и
# _route_cache — после любой правки маршрута (которая и меняет данные, от
# которых зависит KPI) оба кэша сбрасываются вместе.
_route_kpi_raw_cache = {"rows": None, "ts": 0}
_ROUTE_KPI_CACHE_TTL = 15  # секунд


def _invalidate_route_cache(date_str: str):
    _route_cache.pop(date_str, None)
    _route_kpi_raw_cache["rows"] = None
    _route_kpi_raw_cache["ts"] = 0


def _route_kpi_raw_rows() -> list:
    now = time.time()
    if _route_kpi_raw_cache["rows"] is not None and now - _route_kpi_raw_cache["ts"] < _ROUTE_KPI_CACHE_TTL:
        return _route_kpi_raw_cache["rows"]
    rows = _ws(config.SHEET_ROUTE).get_all_values()
    _route_kpi_raw_cache["rows"] = rows
    _route_kpi_raw_cache["ts"] = now
    return rows


def _connect():
    global _client, _sheet
    if _sheet is not None:
        return _sheet
    if config.GOOGLE_CREDENTIALS_JSON:
        info = json.loads(config.GOOGLE_CREDENTIALS_JSON)
        creds = Credentials.from_service_account_info(info, scopes=_SCOPES)
    else:
        creds = Credentials.from_service_account_file(config.GOOGLE_CREDENTIALS_FILE, scopes=_SCOPES)
    _client = gspread.authorize(creds)
    _sheet = _client.open_by_key(config.GOOGLE_SHEET_ID)
    return _sheet


# Spreadsheet.worksheet(name) ВСЕГДА делает отдельный поход в Google —
# fetch_sheet_metadata() (список ВСЕХ листов таблицы со свойствами),
# никак не кэшируясь сама по себе (см. gspread/spreadsheet.py). _ws()
# вызывается 100+ раз по всему sheets.py, часто по несколько раз за один
# HTTP-запрос — то есть каждый экран Mini App реально делал в 2+ раза
# больше обращений к Google Sheets API, чем самих операций чтения/записи,
# и именно это (а не сами чтения/записи) упиралось в квоту API и роняло
# запросы в "server_error" под нагрузкой — воспроизведено и подтверждено:
# при активном использовании (несколько курьеров/админов одновременно)
# счётчик вызовов fetch_sheet_metadata рос кратно быстрее счётчика
# реальных операций. Кэшируем САМ ОБЪЕКТ Worksheet по имени листа на
# несколько секунд, по-прежнему через sh.worksheet(name) (не трогаем
# реализацию gspread и не ломаем ничего, что ожидает именно этот вызов,
# включая тестовые фейки _connect) — просто не повторяем его чаще, чем
# раз в TTL на один и тот же лист.
_ws_cache: dict = {}  # name -> (worksheet, ts)
_WS_CACHE_TTL = 20  # секунд


def _ws(name):
    cached = _ws_cache.get(name)
    now = time.time()
    if cached is not None and now - cached[1] < _WS_CACHE_TTL:
        return cached[0]
    ws = _connect().worksheet(name)
    _ws_cache[name] = (ws, now)
    return ws


def _ws_or_create(name: str, header: list) -> gspread.Worksheet:
    """Как _ws, но сама заводит лист с заголовком, если его ещё нет —
    для листов, которые не часть исходной таблицы PAUSE, а появились
    вместе с фичей (см. config.SHEET_DEBT_COMMENTS/SHEET_DEBT_REMINDERS):
    админу не нужно вручную готовить структуру в Google Таблице."""
    cached = _ws_cache.get(name)
    now = time.time()
    if cached is not None and now - cached[1] < _WS_CACHE_TTL:
        return cached[0]
    sh = _connect()
    try:
        ws = sh.worksheet(name)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title=name, rows=200, cols=max(len(header), 1))
        ws.update([header], "A1")
    _ws_cache[name] = (ws, now)
    return ws


# ---------------------------------------------------------------------------
# Клиенты (Sheet1 / CRM)
# ---------------------------------------------------------------------------

def _load_clients(force=False):
    now = time.time()
    if not force and _cache["clients"] is not None and now - _cache["clients_ts"] < _CACHE_TTL:
        return _cache["clients"]

    ws = _ws(config.SHEET_CLIENTS)
    rows = ws.get_all_values()
    clients = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.CLIENTS_DATA_START_ROW:
            continue
        def cell(col):
            idx = col - 1
            return row[idx].strip() if idx < len(row) else ""
        cid = cell(config.COL_ID)
        if not cid:
            continue
        order_count_raw = cell(config.COL_ORDER_COUNT)
        clients.append({
            "row": r,
            "id": int(cid) if cid.isdigit() else cid,
            "name": cell(config.COL_NAME),
            "zone": cell(config.COL_ZONE),
            "point": cell(config.COL_POINT),
            "contact": cell(config.COL_CONTACT),
            "telegram": cell(config.COL_TELEGRAM),
            "tg_id": cell(config.COL_TG_ID),
            "reg_date": cell(config.COL_REG_DATE),
            "order_count": int(order_count_raw) if order_count_raw.isdigit() else 0,
            "notify_morning_off": cell(config.COL_NOTIFY_MORNING_OFF).lower() == "да",
            "notify_menu_off": cell(config.COL_NOTIFY_MENU_OFF).lower() == "да",
        })
    _cache["clients"] = clients
    _cache["clients_ts"] = now
    return clients


def find_client_by_tg_id(tg_id: int, force: bool = False) -> Optional[dict]:
    """force=True — перечитать "Клиенты" прямо сейчас, в обход
    _CACHE_TTL (60с). Нужен сразу после своего же заказа: order_count
    считается формулой в самой таблице (см. config.COL_ORDER_COUNT), и
    без принудительного обновления проверка статуса для розыгрыша
    "Пауза в подарок" (см. pauseapp.api_order_submit) почти всегда
    видела бы ЕЩЁ СТАРОЕ количество заказов."""
    tg_id = str(tg_id)
    for c in _load_clients(force=force):
        if c["tg_id"] == tg_id:
            return c
    return None


def get_client_by_id(client_id) -> Optional[dict]:
    for c in _load_clients():
        if str(c["id"]) == str(client_id):
            return c
    return None


def get_broadcast_clients() -> list:
    """Клиенты с привязанным Telegram ID — адресаты авторассылок."""
    return [c for c in _load_clients() if c.get("tg_id")]


def _clients_index() -> dict:
    return {str(c["id"]): c for c in _load_clients()}


def _digits_only(s: str) -> str:
    return "".join(ch for ch in (s or "") if ch.isdigit())


def _phone_key(s: str) -> str:
    """Последние 9 цифр номера (длина узбекского номера без кода страны) —
    так "90 123 45 67", "901234567" и "+998901234567" совпадают между собой,
    независимо от пробелов/дефисов/скобок и наличия кода страны."""
    digits = _digits_only(s)
    return digits[-9:] if len(digits) >= 9 else digits


def format_uz_phone(raw: str) -> Optional[str]:
    """Приводит номер к единому виду "+998 XX XXX XX XX" — ровно 9 цифр
    абонентского номера после кода страны +998 (сам код страны в тексте
    необязателен: "901234567" и "+998901234567" дают один и тот же
    результат). Если после вычитания необязательного "998" цифр не ровно
    9 — номер считается неверным (None), ничего не угадываем. Используется
    и при регистрации, и при правке телефона в боте (handlers/start.py,
    handlers/profile.py) — чтобы в "Клиенты" у всех хранился один и тот
    же формат, а не как кто написал."""
    digits = _digits_only(raw)
    if digits.startswith("998") and len(digits) == 12:
        digits = digits[3:]
    if len(digits) != 9:
        return None
    return "+998 {} {} {} {}".format(digits[0:2], digits[2:5], digits[5:7], digits[7:9])


def find_client_by_phone(phone: str) -> Optional[dict]:
    """Ищет существующего клиента (например, добавленного вручную в CRM ещё
    до бота) по номеру телефона — сравниваем только цифры, чтобы разное
    написание одного и того же номера считалось совпадением."""
    target = _phone_key(phone)
    if not target:
        return None
    for c in _load_clients():
        if _phone_key(c["contact"]) == target:
            return c
    return None


def link_tg_id_to_client(client_row: int, tg_id: int):
    """Привязывает Telegram ID к уже существующей строке клиента в Sheet1 —
    используется, когда клиент, ранее добавленный вручную, впервые пишет
    боту и находится по совпадению телефона (дубликат не создаём)."""
    ws = _ws(config.SHEET_CLIENTS)
    ws.update_cell(client_row, config.COL_TG_ID, str(tg_id))
    _cache["clients"] = None


def _id_value(client_id):
    """ID клиента для записи в ячейку — числом, если это возможно.

    В Sheet1 (CRM) ID всегда хранится как число (Google Таблицы сами
    приводят его к числу при регистрации). Если писать его в «Заказы»
    как текст ("119"), формула ИНДЕКС/ПОИСКПОЗ в столбце «Имя» перестаёт
    находить совпадение с числом в Sheet1 — типы разные, хотя значения
    выглядят одинаково. Поэтому здесь тоже приводим к числу."""
    s = str(client_id).strip()
    return int(s) if s.isdigit() else s


def _row_pay_method(row: list) -> str:
    return row[config.O_PAY_METHOD - 1].strip() if len(row) >= config.O_PAY_METHOD else ""


def _row_screenshot(row: list) -> str:
    return row[config.O_SCREENSHOT - 1].strip() if len(row) >= config.O_SCREENSHOT else ""


def _is_review_row(row: list) -> bool:
    """Клиент выбрал карту, прислал скрин, админ ещё не подтвердил:
    в K "В долг", но клиенту это "Оплата на проверке", не долг."""
    if not (row[config.O_PAYMENT - 1].strip() == "В долг" if len(row) >= config.O_PAYMENT else False):
        return False
    method = _row_pay_method(row)
    # Наличные из приложения клиенту тоже "на проверке", не долг (в таблице — "В долг").
    return method == "Наличные" or (method == "Карта" and bool(_row_screenshot(row)))


def _row_delivery_fee(row: list) -> int:
    """Стоимость доставки, записанная на строку заказа (O_DELIVERY_FEE), 0 —
    если её нет. Доставка живёт на ОДНОЙ строке заказа ("строка-носитель",
    см. append_orders_batch) и делит состояние оплаты (столбец K) с ней."""
    if len(row) < config.O_DELIVERY_FEE:
        return 0
    try:
        return int(str(row[config.O_DELIVERY_FEE - 1]).replace(" ", "").strip() or 0)
    except ValueError:
        return 0


def _row_amount(row: list, prices: dict) -> int:
    """Сумма по строке заказа — считаем сами по цене сета, а не полагаемся на
    формулу в таблице (она может быть не протянута на новые строки). Плюс
    стоимость доставки (O_DELIVERY_FEE), если она записана на эту строку —
    на обычных заказах через бота столбец всегда пуст (0), так что для
    них поведение не меняется; видимо только там, где PAUSE App реально
    её пишет (см. append_orders_batch/api_order_submit)."""
    set_name = row[config.O_SET - 1].strip() if len(row) >= config.O_SET else ""
    try:
        qty = int(row[config.O_QTY - 1].strip() or 0) if len(row) >= config.O_QTY else 0
    except ValueError:
        qty = 0
    amount = qty * prices.get(set_name, 0)
    if not amount and len(row) >= config.O_SUM:
        try:
            amount = int(row[config.O_SUM - 1].replace(" ", "").replace(",", "") or 0)
        except (ValueError, IndexError):
            amount = 0
    if len(row) >= config.O_DELIVERY_FEE:
        try:
            amount += int(row[config.O_DELIVERY_FEE - 1].strip() or 0)
        except ValueError:
            pass
    return amount


def create_client(tg_id: int, name: str, phone: str, telegram_username: str = "") -> int:
    """Создаёт нового клиента, возвращает его новый ID."""
    ws = _ws(config.SHEET_CLIENTS)
    clients = _load_clients(force=True)
    max_id = max([int(c["id"]) for c in clients if str(c["id"]).isdigit()], default=0)
    new_id = max_id + 1
    new_row_num = max([c["row"] for c in clients], default=config.CLIENTS_DATA_START_ROW - 1) + 1

    updates = [
        (config.COL_ID, new_id),
        (config.COL_NAME, name),
        (config.COL_CONTACT, phone),
        (config.COL_TELEGRAM, telegram_username),
        (config.COL_STATUS, "Новичок"),
        (config.COL_TG_ID, str(tg_id)),
        (config.COL_REG_DATE, today_date_str()),
    ]
    # update_cells(..., value_input_option="RAW") одним вызовом на все
    # поля — НЕ update_cell() в цикле, как было раньше: у update_cell() в
    # gspread параметра value_input_option вообще нет, он всегда жёстко
    # шлёт USER_ENTERED. Номер телефона в новом едином виде
    # "+998 91 776 34 09" начинается с "+" — Google Таблицы в режиме
    # USER_ENTERED пытаются понять такую строку как формулу, не могут её
    # разобрать, и вместо номера в ячейке новой карточки остаётся ошибка
    # (#ERROR!) прямо при регистрации. Воспроизведено и подтверждено на
    # реальном аккаунте (см. sheets.update_client_field — тот же баг там).
    #
    # У RAW есть обратная сторона именно для ID: раньше (через update_cell,
    # USER_ENTERED) "212" само превращалось в ЧИСЛО 212, как если бы его
    # вписал человек. RAW строку не трогает — она осталась бы ТЕКСТОМ
    # "212". Формула в "Заказы" (MATCH по Sheet1!E:E — см. config.COL_ID)
    # ищет точное совпадение, а текст "212" для неё не равен числу 212 —
    # имя у таких клиентов просто не находится. Поэтому ID передаём сюда
    # Python-числом (new_id), а не str(new_id): gspread кладёт число в
    # JSON как число, и Таблицы сохраняют его числом независимо от
    # value_input_option — RAW защищает только телефон (строка), на число
    # вообще не влияет. Воспроизведено и подтверждено: клиенты,
    # зарегистрированные до этого исправления строкой, перестали находиться
    # формулой "Имя" в "Заказы".
    ws.update_cells(
        [gspread.Cell(new_row_num, col, value) for col, value in updates],
        value_input_option="RAW",
    )

    _cache["clients"] = None  # сбрасываем кэш
    return new_id


def fix_client_id_types() -> dict:
    """Разовая миграция (см. /fix_client_ids в handlers/admin.py): у всех
    клиентов, кого create_client зарегистрировал ДО фикса выше (писал
    str(new_id) под value_input_option="RAW"), ID в Sheet1 хранится
    ТЕКСТОМ — формула "Имя" в "Заказы" (MATCH по числу) таких клиентов не
    находит. Перезаписывает ID каждого клиента тем же значением, но уже
    Python-числом — идемпотентна: у кого ID уже число, запись ничего не
    меняет."""
    ws = _ws(config.SHEET_CLIENTS)
    clients = _load_clients(force=True)
    cells = [
        gspread.Cell(c["row"], config.COL_ID, int(c["id"]))
        for c in clients if str(c["id"]).isdigit()
    ]
    if cells:
        ws.update_cells(cells, value_input_option="RAW")
    _cache["clients"] = None
    return {"total": len(clients), "fixed": len(cells)}


def get_zones() -> list:
    seen, out = set(), []
    for c in _load_clients():
        if c["zone"] and c["zone"] not in seen:
            seen.add(c["zone"])
            out.append(c["zone"])
    return sorted(out)


def get_points(zone: str) -> list:
    seen, out = set(), []
    for c in _load_clients():
        if c["zone"] == zone and c["point"] and c["point"] not in seen:
            seen.add(c["point"])
            out.append(c["point"])
    return sorted(out)


def update_client_point(client_row: int, zone: str, point: str):
    """Если клиент указал новую точку — сохраняем её ему в карточку.

    update_cells([...], value_input_option="RAW"), а НЕ update_cell() —
    у update_cell() в gspread нет параметра value_input_option вообще, он
    всегда шлёт USER_ENTERED "зашитым" (как если бы это вводил человек в
    интерфейсе Таблиц). Та же ловушка, что уже один раз поймали на ID
    курьеров (см. set_route_courier_tg_id): текст вроде адреса легко
    может начинаться с символа, который Таблицы попытаются понять как
    формулу/число, и в ячейке останется не то, что реально записывали."""
    ws = _ws(config.SHEET_CLIENTS)
    ws.update_cells([
        gspread.Cell(client_row, config.COL_ZONE, zone),
        gspread.Cell(client_row, config.COL_POINT, point),
    ], value_input_option="RAW")
    _cache["clients"] = None


def update_client_field(client_row: int, col: int, value: str):
    """Правка одного поля клиента (имя/телефон) из личного кабинета.

    update_cells(..., value_input_option="RAW") — НЕ update_cell(), у
    которого параметра value_input_option вообще нет, он всегда жёстко
    шлёт USER_ENTERED. Номер телефона в новом едином виде
    "+998 91 776 34 09" начинается с "+" — ровно то, что Google Таблицы в
    режиме USER_ENTERED пытаются понять как формулу; разобрать такую
    строку как формулу не получается, и вместо номера в ячейке остаётся
    ошибка (#ERROR! — ровно то, что пользователь увидел вместо телефона
    в профиле после сохранения). Воспроизведено и подтверждено на
    реальном аккаунте."""
    ws = _ws(config.SHEET_CLIENTS)
    ws.update_cells([gspread.Cell(client_row, col, value)], value_input_option="RAW")
    _cache["clients"] = None


def is_canceled(comment: str) -> bool:
    return config.CANCEL_MARKER in (comment or "")


def is_debt_paid_marked(comment: str) -> bool:
    """Строка когда-то была долгом, погашенным через карточку должника
    (PAUSE App, см. config.DEBT_PAID_MARKER и mark_debt_line_paid ниже) —
    ТОЛЬКО для истории долга (get_debtor_lines): сам подсчёт долга
    (get_all_debtors/get_client_debt*) в этом маркере не нуждается —
    mark_debt_line_paid меняет способ оплаты (столбец K) на "Наличными"
    точно так же, как обычное подтверждение оплаты, и строка перестаёт
    быть "В долг" сама по себе, формула столбца L тоже сама покажет
    "ОПЛАЧЕНО". Маркер нужен только чтобы такую строку по-прежнему можно
    было найти и показать в истории ОДНОГО клиента, хотя в подсчёт долга
    она уже не идёт."""
    return config.DEBT_PAID_MARKER in (comment or "")


def get_client_debt(client_id) -> int:
    rows = _orders_raw_rows()
    prices = get_set_prices()
    total = 0
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        eid = row[config.O_CLIENT_ID - 1].strip() if len(row) >= config.O_CLIENT_ID else ""
        payment = row[config.O_PAYMENT - 1].strip() if len(row) >= config.O_PAYMENT else ""
        comment = row[config.O_COMMENT - 1].strip() if len(row) >= config.O_COMMENT else ""
        if eid == str(client_id) and payment == "В долг" and not is_canceled(comment):
            total += _row_amount(row, prices)
    return total


def _order_amount(o: dict, prices: dict) -> int:
    try:
        qty = int(str(o["qty"]).strip() or 0)
    except ValueError:
        qty = 0
    amount = qty * prices.get(o["set"], 0)
    if not amount and o.get("sum"):
        try:
            amount = int(str(o["sum"]).replace(" ", "").replace(",", "") or 0)
        except ValueError:
            amount = 0
    return amount + int(o.get("delivery_fee") or 0)


def get_client_debt_by_day(orders: list) -> list:
    """Долг клиента по дням [{"date", "amount"}] (новые сверху) — без заказов
    "на проверке" и отменённых; для выбора, за какой день платить."""
    prices = get_set_prices()
    by_day, order = {}, []
    for o in orders:
        if o["payment"].strip() != "В долг" or o["canceled"] or o.get("review"):
            continue
        if o["date"] not in by_day:
            by_day[o["date"]] = 0
            order.append(o["date"])
        by_day[o["date"]] += _order_amount(o, prices)
    return [{"date": d, "amount": by_day[d]} for d in order if by_day[d] > 0]


def get_client_debt_from_orders(orders: list) -> int:
    """То же самое, что get_client_debt, но без повторного чтения ВСЕГО
    листа "Заказы" с нуля — переиспользует уже полученные строки клиента."""
    return sum(d["amount"] for d in get_client_debt_by_day(orders))


def get_all_debtors() -> list:
    """Возвращает список [(имя, id, сумма_долга)] — агрегированный по всем
    заказам. Сырые строки — из общего кэша (см. _orders_raw_rows).

    Помимо АКТИВНЫХ должников (сумма > 0) сюда же попадают клиенты, у
    которых все дни долга уже отмечены оплаченными, но админ ещё не
    нажал "Удалить историю долгов" на их карточке — с суммой 0, по
    прямой просьбе: "просто падает вниз списка с долгом 0, но не
    удаляется, пока явно не нажали кнопку". Сортировка по убыванию
    суммы и так кладёт их в самый конец, отдельной логики не нужно.
    Пропадают из этого списка насовсем только через delete_debtor_history
    (она же снимает маркер "долг погашен" из "Заказы" — без этого клиент
    остался бы в списке с суммой 0 навсегда, даже после явного удаления)."""
    rows = _orders_raw_rows()
    clients = _clients_index()
    prices = get_set_prices()
    debts = {}
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_PAYMENT:
            continue
        payment = row[config.O_PAYMENT - 1].strip()
        comment = row[config.O_COMMENT - 1].strip() if len(row) >= config.O_COMMENT else ""
        if is_canceled(comment):
            continue
        is_debt = payment == "В долг"
        is_resolved = is_debt_paid_marked(comment)
        if not is_debt and not is_resolved:
            continue
        eid = row[config.O_CLIENT_ID - 1].strip()
        name = (clients.get(eid) or {}).get("name") or (row[config.O_NAME - 1].strip() if len(row) >= config.O_NAME else "") or eid
        key = eid or name
        if key not in debts:
            debts[key] = {"name": name, "id": eid, "sum": 0}
        if is_debt:
            debts[key]["sum"] += _row_amount(row, prices)
    return sorted(debts.values(), key=lambda d: -d["sum"])


def get_debtor_lines(client_id) -> list:
    """Строки-позиции долга ОДНОГО клиента — "за какое число, какой сет,
    какая сумма" для карточки должника в Операционном центре. Берём
    строки, которые СЕЙЧАС "В долг", плюс те, что были долгом и погашены
    через карточку должника (resolved=True, узнаём по маркеру в
    комментарии — см. config.DEBT_PAID_MARKER и mark_debt_line_paid: у
    них payment уже "Наличными", не "В долг", но из истории клиента они
    по прямой просьбе не пропадают, просто помечаются иначе).

    Сырые строки — из того же короткого кэша, что и get_orders_in_range
    (см. _orders_raw_rows), а не отдельным чтением: эта функция вызывается
    сразу ПОСЛЕ каждой отметки оплаты (обновить карточку должника), так
    что без общего кэша один клик по "Оплатил"/"Закрыть весь долг" —
    это ещё одно чтение всего растущего листа "Заказы" поверх записи."""
    rows = _orders_raw_rows()
    prices = get_set_prices()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_PAYMENT:
            continue
        if row[config.O_CLIENT_ID - 1].strip() != str(client_id):
            continue
        comment = row[config.O_COMMENT - 1].strip() if len(row) >= config.O_COMMENT else ""
        resolved = is_debt_paid_marked(comment)
        # Пока в долге — payment == "В долг"; погашенные через карточку
        # должника строки узнаём по маркеру (их payment mark_debt_line_paid
        # уже сменил на "Наличными", "В долг" там больше нет).
        if row[config.O_PAYMENT - 1].strip() != "В долг" and not resolved:
            continue
        if is_canceled(comment):
            continue
        out.append({
            "row": r,
            "date": row[config.O_DATE - 1].strip(),
            "set": row[config.O_SET - 1].strip(),
            "qty": row[config.O_QTY - 1].strip() if len(row) >= config.O_QTY else "",
            "sum": _row_amount(row, prices),
            "delivery": _row_delivery_fee(row),
            "resolved": resolved,
        })
    out.sort(key=lambda o: dt.datetime.strptime(o["date"], "%d.%m.%Y") if _is_valid_date(o["date"]) else dt.datetime.min, reverse=True)
    return out


def mark_debt_line_paid(row: int):
    """Админ отметил конкретный день долга оплаченным прямо на карточке
    должника. Способ оплаты (столбец K) меняем на "Наличными" — ТОЙ ЖЕ
    механикой, что и обычное подтверждение оплаты наличными
    (confirm_cash_payment): строка по-настоящему перестаёт быть "В
    долг", формула столбца L сама покажет "ОПЛАЧЕНО", отчёты и "Мои
    заказы" клиента это тоже увидят правильно — раньше здесь только
    добавлялся маркер в комментарий, а K не менялся, из-за чего в самой
    таблице ничего не менялось (поймано пользователем). Маркер в
    комментарии всё равно добавляем — он нужен get_debtor_lines, чтобы
    найти и показать эту строку в истории клиента и после того, как она
    перестала быть "В долг"."""
    ws = _ws(config.SHEET_ORDERS)
    cur = ws.cell(row, config.O_COMMENT).value or ""
    ws.update_cell(row, config.O_PAYMENT, "Наличными")
    if not is_debt_paid_marked(cur):
        new = f"{cur} | {config.DEBT_PAID_MARKER}" if cur else config.DEBT_PAID_MARKER
        ws.update_cell(row, config.O_COMMENT, new)
    _invalidate_orders_raw_cache()


def mark_debt_lines_paid(rows: list):
    """Пакетная версия mark_debt_line_paid — ОДИН поход в Sheets на чтение
    комментариев всех строк разом (batch_get) и ОДИН на запись
    (update_cells), а не 2-3 отдельных синхронных HTTP-запроса НА КАЖДУЮ
    строку. Раньше тут был цикл, вызывающий mark_debt_line_paid на каждую
    строку по очереди — при реальном долге в 15-20+ дней это десятки
    последовательных запросов к Google Sheets API подряд в одном
    обработчике, что на практике упиралось в таймаут/лимит запросов и
    роняло весь Mini App с server_error ("Закрыть весь долг" — поймано и
    подтверждено пользователем)."""
    if not rows:
        return
    ws = _ws(config.SHEET_ORDERS)
    comment_ranges = [gspread.utils.rowcol_to_a1(r, config.O_COMMENT) for r in rows]
    comment_values = ws.batch_get(comment_ranges)
    cells = []
    for row, vals in zip(rows, comment_values):
        cur = vals[0][0] if vals and vals[0] else ""
        cells.append(gspread.Cell(row, config.O_PAYMENT, "Наличными"))
        if not is_debt_paid_marked(cur):
            new = f"{cur} | {config.DEBT_PAID_MARKER}" if cur else config.DEBT_PAID_MARKER
            cells.append(gspread.Cell(row, config.O_COMMENT, new))
    ws.update_cells(cells, value_input_option="RAW")
    _invalidate_orders_raw_cache()


def unmark_debt_line_paid(row: int):
    """Отмена mark_debt_line_paid — возвращает payment (столбец K) в "В
    долг" и убирает маркер из комментария (остальной текст, если он там
    был, не трогает)."""
    ws = _ws(config.SHEET_ORDERS)
    ws.update_cell(row, config.O_PAYMENT, "В долг")
    cur = ws.cell(row, config.O_COMMENT).value or ""
    parts = [p.strip() for p in cur.split("|")]
    parts = [p for p in parts if p and config.DEBT_PAID_MARKER not in p]
    ws.update_cell(row, config.O_COMMENT, " | ".join(parts))
    _invalidate_orders_raw_cache()


def delete_debtor_history(client_id):
    """"Удалить историю долгов" на карточке должника — ЕДИНСТВЕННЫЙ способ
    убрать клиента из списка должников, когда его долг уже полностью
    погашен (см. get_all_debtors — до этой кнопки он так и остаётся там
    виден, с суммой 0, в самом низу списка, по прямой просьбе). Только
    когда у клиента не осталось НЕпогашенных долгов (проверяем тут же, а
    не полагаемся на фронт).

    Снимает маркер "долг погашен" (config.DEBT_PAID_MARKER) с его строк в
    "Заказы" — без этого get_all_debtors продолжал бы находить эти
    строки и клиент остался бы в списке с суммой 0 навсегда, даже после
    удаления. Сами строки не удаляются и остальной текст комментария (если
    был) не трогаем — снимаем только сам маркер, той же механикой, что и
    unmark_debt_line_paid. Плюс комментарии/напоминания с карточки."""
    if get_client_debt(client_id) > 0:
        return False

    ws = _ws(config.SHEET_ORDERS)
    cells = []
    for i, row in enumerate(_orders_raw_rows()):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_COMMENT:
            continue
        if row[config.O_CLIENT_ID - 1].strip() != str(client_id):
            continue
        comment = row[config.O_COMMENT - 1].strip()
        if not is_debt_paid_marked(comment):
            continue
        parts = [p.strip() for p in comment.split("|")]
        parts = [p for p in parts if p and config.DEBT_PAID_MARKER not in p]
        cells.append(gspread.Cell(r, config.O_COMMENT, " | ".join(parts)))
    if cells:
        ws.update_cells(cells, value_input_option="RAW")
        _invalidate_orders_raw_cache()

    for sheet_name, header, client_col in (
        (config.SHEET_DEBT_COMMENTS, ["client_id", "date", "text"], config.DC_CLIENT_ID),
        (config.SHEET_DEBT_REMINDERS, ["client_id", "created", "date", "note", "sent"], config.DR_CLIENT_ID),
    ):
        ws2 = _ws_or_create(sheet_name, header)
        rows2 = ws2.get_all_values()
        stale_rows = [
            i + 1 for i, row in enumerate(rows2)
            if i + 1 != 1 and len(row) >= client_col and row[client_col - 1].strip() == str(client_id)
        ]
        for r in sorted(stale_rows, reverse=True):
            ws2.delete_rows(r)
    return True


def _is_valid_date(s: str) -> bool:
    try:
        dt.datetime.strptime(s, "%d.%m.%Y")
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# Должники — комментарии и напоминания (см. config.SHEET_DEBT_COMMENTS/
# SHEET_DEBT_REMINDERS). Оба листа бот заводит сам при первом обращении
# (см. _ws_or_create) и хранит там только то, чего нет в "Заказы" —
# сам долг по-прежнему считается оттуда (get_all_debtors/get_debtor_lines).
# ---------------------------------------------------------------------------

def get_debt_comments(client_id) -> list:
    ws = _ws_or_create(config.SHEET_DEBT_COMMENTS, ["client_id", "date", "text"])
    rows = ws.get_all_values()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r == 1:  # заголовок
            continue
        if len(row) < config.DC_TEXT or row[config.DC_CLIENT_ID - 1].strip() != str(client_id):
            continue
        out.append({"row": r, "date": row[config.DC_DATE - 1].strip(), "text": row[config.DC_TEXT - 1].strip()})
    out.sort(key=lambda c: c["row"], reverse=True)  # новые сверху
    return out


def add_debt_comment(client_id, text: str):
    ws = _ws_or_create(config.SHEET_DEBT_COMMENTS, ["client_id", "date", "text"])
    ws.append_row([str(client_id), today_date_str(), text], value_input_option="RAW")


def get_debt_reminders(client_id, only_pending: bool = True) -> list:
    ws = _ws_or_create(config.SHEET_DEBT_REMINDERS, ["client_id", "created", "date", "note", "sent"])
    rows = ws.get_all_values()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r == 1:
            continue
        if len(row) < config.DR_SENT or row[config.DR_CLIENT_ID - 1].strip() != str(client_id):
            continue
        sent = row[config.DR_SENT - 1].strip().lower() == "да"
        if only_pending and sent:
            continue
        out.append({
            "row": r,
            "created": row[config.DR_CREATED - 1].strip(),
            "date": row[config.DR_DATE - 1].strip(),
            "note": row[config.DR_NOTE - 1].strip(),
            "sent": sent,
        })
    out.sort(key=lambda r: r["row"])
    return out


def set_debt_reminder(client_id, reminder_date: str, note: str = ""):
    ws = _ws_or_create(config.SHEET_DEBT_REMINDERS, ["client_id", "created", "date", "note", "sent"])
    ws.append_row([str(client_id), today_date_str(), reminder_date, note or "", ""], value_input_option="RAW")


def delete_debt_reminder(row: int):
    ws = _ws_or_create(config.SHEET_DEBT_REMINDERS, ["client_id", "created", "date", "note", "sent"])
    ws.delete_rows(row)


def get_due_debt_reminders(date_str: str) -> list:
    """Напоминания, которые должны сработать СЕГОДНЯ (date_str) и ещё не
    отправлены — источник для утренней рассылки (см. bot.py:
    send_debt_reminders). Имя клиента резолвим тут же, чтобы вызывающему
    коду не нужно было отдельно ходить в Sheet1."""
    ws = _ws_or_create(config.SHEET_DEBT_REMINDERS, ["client_id", "created", "date", "note", "sent"])
    rows = ws.get_all_values()
    clients = _clients_index()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r == 1:
            continue
        if len(row) < config.DR_SENT:
            continue
        if row[config.DR_DATE - 1].strip() != date_str:
            continue
        if row[config.DR_SENT - 1].strip().lower() == "да":
            continue
        client_id = row[config.DR_CLIENT_ID - 1].strip()
        name = (clients.get(client_id) or {}).get("name") or client_id
        out.append({"row": r, "client_id": client_id, "name": name, "note": row[config.DR_NOTE - 1].strip()})
    return out


def mark_debt_reminder_sent(row: int):
    ws = _ws_or_create(config.SHEET_DEBT_REMINDERS, ["client_id", "created", "date", "note", "sent"])
    ws.update_cell(row, config.DR_SENT, "Да")


# ---------------------------------------------------------------------------
# CRM (PAUSE App, Операционный центр → CRM, только is_main_admin) — та же
# форма, что и "Должники" выше: отдельные листы для комментариев и
# напоминаний по client_id (см. config.SHEET_CRM_*), плюс отдельный лист
# для стадии лида (warm/dozhim/sale). "cold" — виртуальная стадия: нет
# строки в SHEET_CRM_LEADS вообще, вычисляется, не хранится.
# ---------------------------------------------------------------------------

_CRM_LEADS_HEADER = ["client_id", "stage", "stage_updated"]
_CRM_COMMENTS_HEADER = ["client_id", "date", "text"]
_CRM_REMINDERS_HEADER = ["client_id", "created", "date", "note", "done"]


def get_crm_stage(client_id) -> str:
    ws = _ws_or_create(config.SHEET_CRM_LEADS, _CRM_LEADS_HEADER)
    rows = ws.get_all_values()
    target = str(client_id)
    for i, row in enumerate(rows):
        if i == 0:
            continue
        if len(row) >= config.CRM_STAGE and row[config.CRM_CLIENT_ID - 1].strip() == target:
            return row[config.CRM_STAGE - 1].strip() or config.CRM_STAGE_COLD
    return config.CRM_STAGE_COLD


def set_crm_stage(client_id, stage: str):
    """Ставит стадию лида явно (ручная кнопка "Продажа"/"Дожим" в карточке,
    либо внутренний вызов _promote_crm_to_warm при первом комментарии/
    напоминании) — находит существующую строку клиента и обновляет, иначе
    дописывает новую."""
    ws = _ws_or_create(config.SHEET_CRM_LEADS, _CRM_LEADS_HEADER)
    rows = ws.get_all_values()
    target = str(client_id)
    for i, row in enumerate(rows):
        if i == 0:
            continue
        r = i + 1
        if len(row) >= config.CRM_CLIENT_ID and row[config.CRM_CLIENT_ID - 1].strip() == target:
            ws.update_cells([
                gspread.Cell(r, config.CRM_STAGE, stage),
                gspread.Cell(r, config.CRM_STAGE_UPDATED, today_date_str()),
            ], value_input_option="RAW")
            return
    ws.append_row([target, stage, today_date_str()], value_input_option="RAW")


def _promote_crm_to_warm_if_cold(client_id):
    """Первый комментарий или напоминание по лиду автоматически переводит
    его из "холодных" в "тёплые" — по прямой просьбе (если уже
    теплый/дожим/продажа, не трогаем)."""
    if get_crm_stage(client_id) == config.CRM_STAGE_COLD:
        set_crm_stage(client_id, config.CRM_STAGE_WARM)


def get_crm_comments(client_id) -> list:
    ws = _ws_or_create(config.SHEET_CRM_COMMENTS, _CRM_COMMENTS_HEADER)
    rows = ws.get_all_values()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r == 1:
            continue
        if len(row) < config.CC_TEXT or row[config.CC_CLIENT_ID - 1].strip() != str(client_id):
            continue
        out.append({"row": r, "date": row[config.CC_DATE - 1].strip(), "text": row[config.CC_TEXT - 1].strip()})
    out.sort(key=lambda c: c["row"], reverse=True)  # новые сверху
    return out


def add_crm_comment(client_id, text: str):
    ws = _ws_or_create(config.SHEET_CRM_COMMENTS, _CRM_COMMENTS_HEADER)
    ws.append_row([str(client_id), today_date_str(), text], value_input_option="RAW")
    _promote_crm_to_warm_if_cold(client_id)


def get_crm_reminders(client_id, only_pending: bool = True) -> list:
    ws = _ws_or_create(config.SHEET_CRM_REMINDERS, _CRM_REMINDERS_HEADER)
    rows = ws.get_all_values()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r == 1:
            continue
        if len(row) < config.CR_DONE or row[config.CR_CLIENT_ID - 1].strip() != str(client_id):
            continue
        done = row[config.CR_DONE - 1].strip().lower() == "да"
        if only_pending and done:
            continue
        out.append({
            "row": r,
            "created": row[config.CR_CREATED - 1].strip(),
            "date": row[config.CR_DATE - 1].strip(),
            "note": row[config.CR_NOTE - 1].strip(),
            "done": done,
        })
    out.sort(key=lambda r: r["row"])
    return out


def set_crm_reminder(client_id, reminder_date: str, note: str = ""):
    ws = _ws_or_create(config.SHEET_CRM_REMINDERS, _CRM_REMINDERS_HEADER)
    ws.append_row([str(client_id), today_date_str(), reminder_date, note or "", ""], value_input_option="RAW")
    _promote_crm_to_warm_if_cold(client_id)


def mark_crm_reminder_done(row: int):
    ws = _ws_or_create(config.SHEET_CRM_REMINDERS, _CRM_REMINDERS_HEADER)
    ws.update_cell(row, config.CR_DONE, "Да")


def _crm_stage_index() -> dict:
    ws = _ws_or_create(config.SHEET_CRM_LEADS, _CRM_LEADS_HEADER)
    rows = ws.get_all_values()
    out = {}
    for i, row in enumerate(rows):
        if i == 0:
            continue
        if len(row) >= config.CRM_STAGE and row[config.CRM_CLIENT_ID - 1].strip():
            out[row[config.CRM_CLIENT_ID - 1].strip()] = row[config.CRM_STAGE - 1].strip() or config.CRM_STAGE_COLD
    return out


def get_crm_clients_list() -> list:
    """Полный список клиентов для экрана "Клиенты" — имя/район/точка/
    заказы/дата регистрации/стадия CRM, одним проходом (без отдельного
    запроса стадии на каждого клиента). Фильтры (имя/район/
    заказывал-не заказывал) и сортировка — на фронте, список и так
    небольшой (тот же объём, что уже читает get_club_leaderboard)."""
    stages = _crm_stage_index()
    out = []
    for c in _load_clients():
        out.append({
            "id": c["id"], "name": c["name"], "zone": c["zone"], "point": c["point"],
            "contact": c["contact"], "order_count": c["order_count"], "reg_date": c["reg_date"],
            "stage": stages.get(str(c["id"]), config.CRM_STAGE_COLD),
        })
    return out


def get_crm_leads_overview() -> dict:
    """{"today_count", "cold": [...], "warm": [...], "dozhim": [...]} —
    экран "Лиды". "Продажа" сюда не попадает вовсе — по прямой просьбе
    лид, отмеченный продажей, считается закрытым и больше не "лид"
    (остаётся виден в обычном списке "Клиенты"). Последний комментарий и
    ближайшее незакрытое напоминание — читаются ОДНИМ проходом по каждому
    листу (не по запросу на лида), чтобы открытие "Лиды" не било по
    Sheets API N+1 запросами на N клиентов."""
    stages = _crm_stage_index()

    last_comment = {}
    for row in _ws_or_create(config.SHEET_CRM_COMMENTS, _CRM_COMMENTS_HEADER).get_all_values()[1:]:
        if len(row) >= config.CC_TEXT and row[config.CC_CLIENT_ID - 1].strip():
            last_comment[row[config.CC_CLIENT_ID - 1].strip()] = {
                "date": row[config.CC_DATE - 1].strip(), "text": row[config.CC_TEXT - 1].strip(),
            }

    pending_reminder = {}
    for row in _ws_or_create(config.SHEET_CRM_REMINDERS, _CRM_REMINDERS_HEADER).get_all_values()[1:]:
        if len(row) < config.CR_DONE or not row[config.CR_CLIENT_ID - 1].strip():
            continue
        if row[config.CR_DONE - 1].strip().lower() == "да":
            continue
        pending_reminder[row[config.CR_CLIENT_ID - 1].strip()] = {
            "date": row[config.CR_DATE - 1].strip(), "note": row[config.CR_NOTE - 1].strip(),
        }

    today = today_date_str()
    today_count = 0
    buckets = {"cold": [], "warm": [], "dozhim": []}
    for c in _load_clients():
        cid = str(c["id"])
        if c["reg_date"] == today:
            today_count += 1
        stage = stages.get(cid, config.CRM_STAGE_COLD)
        if stage == config.CRM_STAGE_SALE or stage not in buckets:
            continue
        buckets[stage].append({
            "id": c["id"], "name": c["name"], "zone": c["zone"], "contact": c["contact"],
            "reg_date": c["reg_date"], "order_count": c["order_count"],
            "last_comment": last_comment.get(cid),
            "reminder": pending_reminder.get(cid),
        })
    return {
        "today": today, "today_count": today_count,
        "cold": buckets["cold"], "warm": buckets["warm"], "dozhim": buckets["dozhim"],
    }


def get_client_full_profile(client_id) -> dict:
    """Полный отчёт по клиенту для карточки в "Клиенты"/"Лиды" — профиль +
    статус Pause Club + долг + стадия/комментарии/напоминания CRM +
    последние заказы, одним вызовом (вместо нескольких отдельных запросов
    с фронта на каждый блок карточки)."""
    client = next((c for c in _load_clients() if str(c["id"]) == str(client_id)), None)
    if not client:
        return {}
    cid = str(client["id"])
    level = get_club_level(client["order_count"])
    return {
        "id": client["id"], "name": client["name"], "zone": client["zone"], "point": client["point"],
        "contact": client["contact"], "telegram": client["telegram"], "tg_id": client["tg_id"],
        "reg_date": client["reg_date"], "order_count": client["order_count"],
        "club": {"key": level["key"], "emoji": level["emoji"], "label": level["label"]},
        "debt": get_client_debt(cid),
        "stage": get_crm_stage(cid),
        "comments": get_crm_comments(cid),
        "reminders": get_crm_reminders(cid, only_pending=True),
        "orders": [
            {
                "date": g["date"],
                "summary": ", ".join(
                    f"{i['qty']}× {display_set_name(i['set'])}" for i in g["items"]
                ),
                "canceled": g["canceled"],
                "paid": g["paid"],
            }
            for g in get_client_order_groups(cid, limit=5)
        ],
    }


def get_client_orders(client_id, limit=10) -> list:
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_CLIENT_ID:
            continue
        if row[config.O_CLIENT_ID - 1].strip() == str(client_id):
            comment = row[config.O_COMMENT - 1] if len(row) >= config.O_COMMENT else ""
            out.append({
                "row": r,
                "date": row[config.O_DATE - 1] if len(row) >= config.O_DATE else "",
                "zone": row[config.O_ZONE - 1] if len(row) >= config.O_ZONE else "",
                "set": row[config.O_SET - 1] if len(row) >= config.O_SET else "",
                "qty": row[config.O_QTY - 1] if len(row) >= config.O_QTY else "",
                "payment": row[config.O_PAYMENT - 1] if len(row) >= config.O_PAYMENT else "",
                "status": row[config.O_STATUS - 1].strip() if len(row) >= config.O_STATUS else "",
                "comment": comment,
                "canceled": is_canceled(comment),
                "batch": row[config.O_ORDER_BATCH - 1].strip() if len(row) >= config.O_ORDER_BATCH else "",
                "sum": row[config.O_SUM - 1] if len(row) >= config.O_SUM else "",
                "delivery_fee": _row_delivery_fee(row),
                "review": _is_review_row(row),
                "pay_method": _row_pay_method(row),
            })
    return out[-limit:][::-1]


def get_client_order_groups(client_id, limit=10, rows=None) -> list:
    """Заказы клиента, сгруппированные по ОДНОМУ оформлению — один
    оформленный заказ мог занять несколько строк (несколько сетов), но это
    по-прежнему один заказ для отмены/отзыва/истории/скрина оплаты.

    Группировка — по (дата, batch) — см. config.O_ORDER_BATCH, а не просто
    по дате: раньше группировка была только по дате, и ДВА РАЗНЫХ заказа
    одного клиента за один день (например, утром — картой со скрином
    сразу, вечером — отдельный заказ "оплачу позже") схлопывались в одну
    группу. Из-за этого: (1) кнопка "Прикрепить скрин" могла не
    показаться вовсе — она зависела от payment ПЕРВОЙ по счёту строки в
    группе, а не от реально нужной; (2) если бы клиент всё же прикрепил
    скрин через такую смешанную группу, он ушёл бы на ВСЕ строки группы
    разом, затерев/переприкрепив скрин к чужому (уже оформленному отдельно)
    заказу. Строки без batch (старые, до этого фикса) группируются по
    дате как раньше — обратная совместимость, ничего не расщепляет задним
    числом. Возвращает от новых к старым.

    rows — уже полученные get_client_orders(client_id, limit=10**9), если
    они у вызывающего кода и так уже есть (например, чтобы заодно
    посчитать долг без повторного чтения всего листа "Заказы" — см.
    get_client_debt_from_orders). По умолчанию читает сама, как раньше."""
    if rows is None:
        rows = get_client_orders(client_id, limit=10**9)  # уже от новых к старым
    prices = get_set_prices()
    groups, order = {}, []
    for r in rows:
        key = (r["date"], r["batch"])
        if key not in groups:
            groups[key] = {
                "sets_sum": 0,
                "card_review": False,
                "methods": [],
                "date": r["date"],
                "zone": r["zone"],
                "items": [],
                "rows": [],
                "payment": r["payment"],
                "comment": r["comment"],
                "canceled": r["canceled"],
                "paid": True,
                "delivery_fee": 0,
                "delivery_payment": "",
                "review": False,
            }
            order.append(key)
        g = groups[key]
        if r.get("review") and r["status"].strip().upper() != "ОПЛАЧЕНО":
            g["review"] = True
            if r.get("pay_method") == "Карта":
                g["card_review"] = True
        pay = r["payment"].strip()
        m = {"Картой": "card", "Наличными": "cash", "Билетом": "ticket"}.get(pay) or \
            {"Карта": "card", "Наличные": "cash"}.get(r.get("pay_method") or "", "")
        if m and m not in g["methods"] and str(r["qty"]).strip() != "0":
            g["methods"].append(m)
        if r.get("delivery_fee"):
            g["delivery_fee"] += r["delivery_fee"]
            g["delivery_payment"] = r["payment"].strip()
        if str(r["qty"]).strip() == "0":
            # строка-носитель доставки без позиций — в составе не показываем
            g["rows"].append(r["row"])
            if r["status"].strip().upper() != "ОПЛАЧЕНО":
                g["paid"] = False
            continue
        g["items"].append({"set": r["set"], "qty": r["qty"]})
        g["rows"].append(r["row"])
        if r["payment"].strip() != config.PAYMENT_TICKET:
            try:
                q = int(str(r["qty"]).strip() or 0)
            except ValueError:
                q = 0
            amt = q * prices.get(r["set"], 0)
            if not amt and r.get("sum"):
                try:
                    amt = int(str(r["sum"]).replace(" ", "").replace(",", "") or 0)
                except ValueError:
                    amt = 0
            g["sets_sum"] += amt
        # "Оплачено" на весь заказ — только если ОПЛАЧЕНО во всех его
        # строках (столбец L "Заказы", формула по столбцу K — см.
        # confirm_card_payment/confirm_cash_payment). Обычно все строки
        # одного оформления делят один и тот же способ оплаты, но так
        # безопаснее и на случай расхождения — не покажем "оплачено",
        # если хоть одна позиция ещё нет.
        if r["status"].strip().upper() != "ОПЛАЧЕНО":
            g["paid"] = False
    return [groups[k] for k in order][:limit]


def get_last_order_rows(client_id) -> list:
    """Все строки последнего (по дате) заказа клиента — для отмены."""
    groups = get_client_order_groups(client_id, limit=1)
    if not groups:
        return []
    g = groups[0]
    return [
        {"row": row, "date": g["date"], "set": item["set"], "qty": item["qty"],
         "payment": g["payment"], "comment": g["comment"], "canceled": g["canceled"]}
        for row, item in zip(g["rows"], g["items"])
    ]


def get_favorite_sets(client_id) -> list:
    """Ключи сетов в избранном у клиента (см. s.key на карточке — для
    обычного сета его имя, для группы переменной цены —
    "__variant__:{группа}", см. pauseapp.py:_serialize_sets/_serialize_favorite_sets).
    Строки со статусом FAV_STATUS_REMOVED (см. toggle_favorite_set) в
    выдачу не попадают. Порядок — как добавлял клиент, от старых к новым."""
    ws = _ws(config.SHEET_FAVORITES)
    rows = ws.get_all_values()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.FAV_DATA_START_ROW:
            continue
        if len(row) < config.FAV_SET_KEY:
            continue
        if row[config.FAV_CLIENT_ID - 1].strip() != str(client_id):
            continue
        status = row[config.FAV_STATUS - 1].strip() if len(row) >= config.FAV_STATUS else ""
        if status == config.FAV_STATUS_REMOVED:
            continue
        key = row[config.FAV_SET_KEY - 1].strip()
        if key:
            out.append(key)
    return out


def toggle_favorite_set(client_id, set_key: str) -> bool:
    """Добавляет/убирает сет из избранного клиента — мягко (см. комментарий
    у config.SHEET_FAVORITES), находит существующую строку по (client_id,
    set_key) и переключает статус, а не плодит дубликаты при повторном
    добавлении того же сета. Возвращает новое состояние: True — теперь в
    избранном, False — убран."""
    ws = _ws(config.SHEET_FAVORITES)
    rows = ws.get_all_values()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.FAV_DATA_START_ROW:
            continue
        if len(row) < config.FAV_SET_KEY:
            continue
        if row[config.FAV_CLIENT_ID - 1].strip() != str(client_id) or row[config.FAV_SET_KEY - 1].strip() != set_key:
            continue
        status = row[config.FAV_STATUS - 1].strip() if len(row) >= config.FAV_STATUS else ""
        new_status = "" if status == config.FAV_STATUS_REMOVED else config.FAV_STATUS_REMOVED
        ws.update_cell(r, config.FAV_STATUS, new_status)
        return new_status == ""
    ws.append_row(
        [str(client_id), set_key, _now().strftime("%d.%m.%Y %H:%M"), ""],
        value_input_option="RAW",
    )
    return True


def cancel_order_rows(row_nums: list):
    """Помечает строки заказа как отменённые клиентом — не удаляет их из таблицы."""
    ws = _ws(config.SHEET_ORDERS)
    for r in row_nums:
        cur = ws.cell(r, config.O_COMMENT).value or ""
        if is_canceled(cur):
            continue
        new = f"{cur} | {config.CANCEL_MARKER} КЛИЕНТОМ" if cur else f"{config.CANCEL_MARKER} КЛИЕНТОМ"
        ws.update_cell(r, config.O_COMMENT, new)


# ---------------------------------------------------------------------------
# Заказы
# ---------------------------------------------------------------------------

def _next_empty_order_row() -> int:
    ws = _ws(config.SHEET_ORDERS)
    col_a = ws.col_values(config.O_DATE)
    r = config.ORDERS_DATA_START_ROW
    for i in range(config.ORDERS_DATA_START_ROW - 1, len(col_a)):
        if not col_a[i].strip():
            return i + 1
    return len(col_a) + 1


def append_order(date_str: str, zone: str, point: str, client_id, set_name: str,
                  qty: int, garnish: str, payment: str, comment: str = "",
                  screenshot: str = "", batch_id: str = "", pay_method: str = "") -> int:
    """Добавляет строку заказа, возвращает номер строки (нужен для подтверждения оплаты картой).

    batch_id — метка одного оформления (см. config.O_ORDER_BATCH): все
    строки одной корзины, отправленные одним нажатием "Всё верно,
    отправить" (или одним подтверждением новой точки координатором),
    должны прийти с ОДНИМ И ТЕМ ЖЕ batch_id — вызывающий код генерирует
    его один раз на весь цикл append_order по корзине, не по одному на
    строку."""
    ws = _ws(config.SHEET_ORDERS)
    row_num = _next_empty_order_row()
    updates = [
        (config.O_DATE, date_str),
        (config.O_ZONE, zone),
        (config.O_POINT, point),
        (config.O_CLIENT_ID, _id_value(client_id)),
        (config.O_SET, set_name),
        (config.O_QTY, int(qty)),  # числом — см. append_orders_batch выше
        (config.O_GARNISH, garnish or ""),
        (config.O_PAYMENT, payment),
        (config.O_COMMENT, comment or ""),
    ]
    if screenshot:
        updates.append((config.O_SCREENSHOT, screenshot))
    if batch_id:
        updates.append((config.O_ORDER_BATCH, batch_id))
    if pay_method:
        _ensure_sheet_columns(ws, config.O_PAY_METHOD)
        updates.append((config.O_PAY_METHOD, pay_method))
    cells = [gspread.Cell(row_num, col, value) for col, value in updates]
    ws.update_cells(cells)
    return row_num


def append_orders_batch(date_str: str, zone: str, point: str, client_id, items: list,
                         payment, comment: str = "", screenshot: str = "", batch_id: str = "",
                         delivery_fee: int = 0, fee_payment: str = "", pay_method: str = "") -> list:
    """Как append_order, но для ВСЕЙ корзины ОДНИМ запросом к Sheets, а не
    по одному на каждую позицию. items — [{"set","qty","garnish"}, ...].

    Раньше оформление заказа из нескольких позиций вызывало append_order в
    цикле — КАЖДЫЙ вызов сам заново считал "первую свободную строку"
    (_next_empty_order_row — читает ВЕСЬ растущий столбец A "Заказы") И
    делал свой отдельный update_cells. На корзине из, скажем, 4 позиций
    это было 4 полных чтения всего листа "Заказы" плюс 4 отдельных записи
    НА ОДНО нажатие "Отправить" — самое частое и самое заметное клиенту
    действие (оформление заказа), воспроизведено и подтверждено как одна
    из причин медленного/падающего с server_error оформления. Теперь
    "первая свободная строка" считается ОДИН раз на всю корзину (следующие
    позиции в той же корзине просто занимают следующие строки подряд — в
    пределах одного оформления это безопасно, строки ещё никем не заняты,
    т.к. только что найдены этим же вызовом), и все ячейки всех позиций
    пишутся одним update_cells. Возвращает список номеров строк, по одному
    на каждый item, в том же порядке.

    payment — либо одна строка на весь батч (как раньше), либо список той
    же длины, что items, — по одному значению на строку (см. pauseapp.py:
    api_order_submit — заказ с билетом "Пауза в подарок" на ОДИН сет из
    нескольких: эта позиция пишется с payment=PAYMENT_TICKET, остальные —
    с обычным способом оплаты остатка)."""
    payments = payment if isinstance(payment, list) else [payment] * len(items)
    ws = _ws(config.SHEET_ORDERS)
    if delivery_fee:
        _ensure_sheet_columns(ws, config.O_DELIVERY_FEE)
    if pay_method:
        _ensure_sheet_columns(ws, config.O_PAY_METHOD)
    # Строка-носитель доставки — первая позиция, НЕ оплаченная билетом:
    # доставка делит статус оплаты (К) со своей строкой, а у билетной строки
    # статус "Билетом" — доставка осталась бы вне долга/подтверждений. Если
    # билетом закрыта вся корзина, а доставка платная, пишем отдельную
    # строку-носитель с количеством 0 (на кухню/счётчики заказов не влияет).
    fee_index = None
    if delivery_fee:
        for i in range(len(items)):
            if payments[i] != config.PAYMENT_TICKET:
                fee_index = i
                break
        if fee_index is None:
            items = list(items) + [{"set": items[0]["set"], "qty": 0, "garnish": items[0].get("garnish", "")}]
            fee_pay = fee_payment
            payments = list(payments) + [fee_pay]
            fee_index = len(items) - 1
    start_row = _next_empty_order_row()
    cells = []
    row_nums = []
    for i, item in enumerate(items):
        row_num = start_row + i
        row_nums.append(row_num)
        updates = [
            (config.O_DATE, date_str),
            (config.O_ZONE, zone),
            (config.O_POINT, point),
            (config.O_CLIENT_ID, _id_value(client_id)),
            (config.O_SET, item["set"]),
            # ЧИСЛОМ, не строкой — "Кол-во Заказов" в Sheet1 (столбец O)
            # считается формулой SUMIF по этому столбцу (см.
            # config.COL_ORDER_COUNT), а SUMIF игнорирует текстовые ячейки
            # при суммировании, даже если они выглядят как число. Текстовое
            # "2" там просто не попадает в сумму — отсюда "заказы есть, а
            # счётчик 0", воспроизведено и подтверждено на реальном
            # клиенте. Итоговая сумма (O_SUM, столбец J) при этом считалась
            # верно — та формула умножает, а умножение в Таблицах текстовое
            # "2" само приводит к числу, в отличие от SUMIF.
            (config.O_QTY, int(item["qty"])),
            (config.O_GARNISH, item.get("garnish", "") or ""),
            (config.O_PAYMENT, payments[i]),
            (config.O_COMMENT, comment or ""),
        ]
        if screenshot:
            updates.append((config.O_SCREENSHOT, screenshot))
        if batch_id:
            updates.append((config.O_ORDER_BATCH, batch_id))
        # Доставка — одной суммой на строку-носитель, не размазана по
        # позициям (один заказ = одна доставка, см. api_order_submit).
        if delivery_fee and i == fee_index:
            updates.append((config.O_DELIVERY_FEE, str(delivery_fee)))
        if pay_method and payments[i] != config.PAYMENT_TICKET:
            updates.append((config.O_PAY_METHOD, pay_method))
        cells.extend(gspread.Cell(row_num, col, value) for col, value in updates)
    if cells:
        ws.update_cells(cells)
    return row_nums


def migrate_order_qty_to_numbers() -> dict:
    """Одноразовая миграция существующих строк «Заказы»: перезаписывает
    столбец O_QTY ("Кол-во") настоящим числом везде, где это возможно.

    До фикса в append_order/append_orders_batch количество писалось
    str()'ом — Google Таблицы хранили его как ТЕКСТ. "Кол-во Заказов" в
    Sheet1 (config.COL_ORDER_COUNT) — формула SUMIF по этому же столбцу,
    а SUMIF текстовые ячейки при суммировании молча пропускает, даже если
    они выглядят как число. Поэтому у клиентов с реальными заказами счётчик
    оставался 0 (воспроизведено и подтверждено). get_all_values() отдаёт
    ЛЮБУЮ ячейку строкой независимо от её настоящего типа в Таблице, так
    что отличить "уже число" от "текст, похожий на число" на чтении
    нельзя — поэтому просто перезаписываем все похожие на число ячейки
    настоящим int: если ячейка уже была числом, ничего не меняется, если
    текстом — чинится. Идемпотентна, безопасно запускать повторно.

    НЕ запускать в этой песочнице — здесь нет реальных Google Sheets
    credentials (см. CLAUDE.md). Запустить один раз там, где у бота есть
    реальный доступ к таблице (см. scripts/fix_order_qty.py)."""
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    cells = []
    fixed = 0
    skipped_blank = 0
    skipped_not_numeric = 0
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        raw = (row[config.O_QTY - 1] if len(row) >= config.O_QTY else "").strip()
        if not raw:
            skipped_blank += 1
            continue
        if not raw.lstrip("-").isdigit():
            skipped_not_numeric += 1
            continue
        cells.append(gspread.Cell(r, config.O_QTY, int(raw)))
        fixed += 1
    if cells:
        ws.update_cells(cells)
    return {
        "fixed": fixed,
        "skipped_blank": skipped_blank,
        "skipped_not_numeric": skipped_not_numeric,
        "rows_scanned": len(rows) - (config.ORDERS_DATA_START_ROW - 1),
    }


def set_order_screenshot(row_nums: list, file_id: str):
    """Сохраняет file_id скрина оплаты в скрытый столбец «Заказы» задним
    числом — для уже существующих строк заказа (например, когда клиент
    присылает скрин повторно по напоминанию, а не в момент оформления)."""
    ws = _ws(config.SHEET_ORDERS)
    cells = [gspread.Cell(r, config.O_SCREENSHOT, file_id) for r in row_nums]
    if cells:
        ws.update_cells(cells)


def confirm_card_payment(row_nums: list):
    """Админ подтвердил присланный скрин оплаты картой — статус оплаты
    (столбец K) становится "Картой", формула столбца L автоматически
    показывает "ОПЛАЧЕНО"."""
    ws = _ws(config.SHEET_ORDERS)
    for r in row_nums:
        ws.update_cell(r, config.O_PAYMENT, "Картой")


def confirm_cash_payment(row_nums: list):
    """Админ лично подтвердил, что наличные получены — статус оплаты
    (столбец K) становится "Наличными", формула столбца L показывает
    "ОПЛАЧЕНО". До этого вызова заказ наличными держится в столбце K как
    "На проверке" (та же строка, что и для карты) — L поэтому показывает
    "НЕ ОПЛАЧЕНО", ровно как для неподтверждённой оплаты картой."""
    ws = _ws(config.SHEET_ORDERS)
    for r in row_nums:
        ws.update_cell(r, config.O_PAYMENT, "Наличными")


def mark_screenshot_sent(row_nums: list):
    """Клиент прислал скрин оплаты картой (сразу при заказе или позже) —
    статус оплаты (столбец K) становится "На проверке", формула столбца L
    показывает "НЕ ОПЛАЧЕНО" до подтверждения администратором
    (confirm_card_payment)."""
    ws = _ws(config.SHEET_ORDERS)
    for r in row_nums:
        # Заказ из PAUSE App (способ "Карта" в AE) держится в "В долг" до
        # подтверждения, остальные — "На проверке", как и раньше.
        method = ws.cell(r, config.O_PAY_METHOD).value or ""
        ws.update_cell(r, config.O_PAYMENT, "В долг" if method.strip() == "Карта" else "На проверке")


def submit_debt_payment(client_id, file_id: str, dates=None) -> list:
    """Клиент оплачивает долг из PAUSE App скрином: все его строки "В долг"
    (не отменённые и ещё не на проверке) получают скрин и способ "Карта" —
    в K остаётся "В долг" до подтверждения админом, клиенту это "Оплата на
    проверке" (см. _is_review_row). Возвращает номера строк."""
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    cells, nums = [], []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW or len(row) < config.O_PAYMENT:
            continue
        if row[config.O_CLIENT_ID - 1].strip() != str(client_id):
            continue
        if row[config.O_PAYMENT - 1].strip() != "В долг" or _is_review_row(row):
            continue
        if dates is not None and row[config.O_DATE - 1].strip() not in dates:
            continue
        if len(row) >= config.O_COMMENT and is_canceled(row[config.O_COMMENT - 1]):
            continue
        nums.append(r)
        cells.append(gspread.Cell(r, config.O_SCREENSHOT, file_id))
        cells.append(gspread.Cell(r, config.O_PAY_METHOD, "Карта"))
    if cells:
        ws.update_cells(cells)
        _invalidate_orders_raw_cache()
    return nums


def get_order_rows(row_nums: list) -> list:
    """Состав заказа (сет/кол-во/гарнир) по номерам строк — нужно, когда
    строки уже существуют в таблице, а не собираются из FSM (например,
    когда клиент присылает скрин оплаты повторно, по напоминанию)."""
    ws = _ws(config.SHEET_ORDERS)
    out = []
    for r in row_nums:
        row = ws.row_values(r)

        def cell(col, row=row):
            idx = col - 1
            return row[idx] if idx < len(row) else ""

        out.append({
            "set": cell(config.O_SET),
            "qty": cell(config.O_QTY),
            "garnish": cell(config.O_GARNISH),
        })
    return out


def get_unconfirmed_card_orders(date_str: str) -> list:
    """Клиенты с заказом на дату, выбравшие оплату картой "пришлю скрин
    позже" и ещё не приславшие его — столбец K (Оплата) пуст, см. новую
    модель статусов оплаты ("🕊 Ожидает скрин" в "Мои заказы"). Источник
    для мягкого напоминания в PAYMENT_REMINDER_TIME. Группируем по
    клиенту (несколько строк одного заказа — одно напоминание).
    Возвращает [{"client_id", "tg_id", "rows": [...]}]."""
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    clients = _clients_index()
    by_client = {}
    order = []

    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_COMMENT:
            continue
        if row[config.O_DATE - 1].strip() != date_str:
            continue
        payment = row[config.O_PAYMENT - 1].strip() if len(row) >= config.O_PAYMENT else ""
        # Бот: K пуст. PAUSE App: "В долг" + способ "Карта" и ещё без скрина.
        if not (payment == "" or (payment == "В долг" and _row_pay_method(row) == "Карта" and not _row_screenshot(row))):
            continue
        comment = row[config.O_COMMENT - 1].strip()
        if is_canceled(comment):
            continue
        client_id = row[config.O_CLIENT_ID - 1].strip() if len(row) >= config.O_CLIENT_ID else ""
        if not client_id:
            continue
        client = clients.get(client_id)
        tg_id = (client or {}).get("tg_id")
        if not tg_id:
            continue
        if client_id not in by_client:
            by_client[client_id] = {"client_id": client_id, "tg_id": tg_id, "name": (client or {}).get("name", ""), "rows": []}
            order.append(client_id)
        by_client[client_id]["rows"].append(r)

    return [by_client[cid] for cid in order]


def get_client_pending_screenshot(client_id, date_str: str) -> dict:
    """Сегодняшний заказ клиента, по которому выбрано "скрин позже" и скрин
    ещё не прислан (и админ не поставил оплату руками): состав, сумма, строки."""
    orders = get_client_orders(client_id, limit=10**9)
    prices = get_set_prices()
    items, rows, total = [], [], 0
    for o in orders:
        if o["date"].strip() != date_str or o["canceled"]:
            continue
        pay = o["payment"].strip()
        if not (pay == "" or (pay == "В долг" and o.get("pay_method") == "Карта" and not o.get("review"))):
            continue
        rows.append(o["row"])
        total += _order_amount(o, prices)
        if str(o["qty"]).strip() != "0":
            items.append({"set": o["set"], "qty": o["qty"]})
    return {"items": items, "rows": rows, "total": total}


def get_payments_for_date(date_str: str) -> list:
    """Все заказы за дату с оплатой картой (есть скрин) или наличными —
    источник единого флоу "Подтверждение оплаты" (см. handlers/admin.py:
    _send_payments_for_date). Объединяет то, что раньше показывал
    /payments (скрины картой, ЛЮБОГО статуса), с оплатой наличными — она
    тоже не считается оплаченной автоматически (см. confirm_cash_payment)
    и тоже показывается независимо от статуса. Заказы без скрина и без
    отметки об оплате (K пусто — "пришлю скрин позже", ещё не прислал)
    сюда не попадают — подтверждать пока нечего; "В долг" тоже не сюда.

    Группировка — по клиенту, той же идеей, что и build_kitchen_report/
    get_kitchen_line_items: несколько строк одного клиента за день
    (например, заказал "Пауза дня" и "Для тебя" отдельно) объединяются в
    одну запись с общей суммой и одной кнопкой "Подтвердить" на все
    строки разом. Карточные строки дополнительно группируются по самому
    значению скрина — один скрин, прикреплённый разом ко всей корзине
    при оформлении заказа, даёт одну запись; если у клиента за день
    оказалось два РАЗНЫХ скрина (две отдельные оплаты картой) — это две
    отдельные записи, их физически нельзя показать одним сообщением с
    одним фото. Наличные группируются просто по клиенту — фото нет,
    конфликтовать нечему.

    Каждая запись — {"client_id", "name", "method" ("card"/"cash"),
    "screenshot", "rows" (все номера строк, обновляются при подтверждении
    разом), "sets" ([{"set", "qty"}, ...] — сырые названия, отображение
    display_set_name — на стороне handlers/admin.py), "sum", "confirmed"}."""
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    prices = get_set_prices()
    clients = _clients_index()

    groups = {}
    order = []

    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_DATE or row[config.O_DATE - 1].strip() != date_str:
            continue
        payment = row[config.O_PAYMENT - 1].strip() if len(row) >= config.O_PAYMENT else ""
        comment = row[config.O_COMMENT - 1].strip() if len(row) >= config.O_COMMENT else ""
        if is_canceled(comment):
            continue
        screenshot = row[config.O_SCREENSHOT - 1].strip() if len(row) >= config.O_SCREENSHOT else ""
        client_id = row[config.O_CLIENT_ID - 1].strip() if len(row) >= config.O_CLIENT_ID else ""

        app_pending = payment == "В долг" and _row_pay_method(row)
        if screenshot:
            if payment not in ("На проверке", "Картой") and app_pending != "Карта":
                continue
            method = "card"
            confirmed = payment == "Картой"
            key = (client_id, "card", screenshot)
        else:
            if payment not in ("На проверке", "Наличными") and app_pending != "Наличные":
                continue
            method = "cash"
            confirmed = payment == "Наличными"
            key = (client_id, "cash")

        if key not in groups:
            client = clients.get(client_id) or {}
            name = client.get("name") or (row[config.O_NAME - 1].strip() if len(row) >= config.O_NAME else "") or client_id or "—"
            groups[key] = {
                "client_id": client_id,
                "name": name,
                "method": method,
                "screenshot": screenshot,
                "rows": [],
                "sum": 0,
                "sets": [],
                "confirmed_flags": [],
            }
            order.append(key)

        g = groups[key]
        g["rows"].append(r)
        g["sum"] += _row_amount(row, prices)
        g["confirmed_flags"].append(confirmed)
        set_name = row[config.O_SET - 1].strip() if len(row) >= config.O_SET else ""
        qty = row[config.O_QTY - 1].strip() if len(row) >= config.O_QTY else ""
        if set_name:
            g["sets"].append({"set": set_name, "qty": qty})

    out = []
    for key in order:
        g = groups[key]
        out.append({
            "client_id": g["client_id"],
            "name": g["name"],
            "method": g["method"],
            "screenshot": g["screenshot"],
            "rows": g["rows"],
            "sets": g["sets"],
            "sum": g["sum"],
            "confirmed": all(g["confirmed_flags"]),
        })
    return out


def _active_menu_day() -> dt.date:
    active_date = get_active_menu_date()
    try:
        return dt.datetime.strptime(active_date, "%d.%m.%Y").date()
    except ValueError:
        return _now().date()


def is_after_cutoff() -> bool:
    """Приём заказов закрывается не по времени суток "сегодня", а строго в
    ORDER_CUTOFF_TIME того дня, на который указана дата активного меню.
    Если меню опубликовано вечером на завтра — приём открыт весь вечер,
    всю ночь и всё утро, до ORDER_CUTOFF_TIME именно завтрашнего дня, а
    не "сегодняшних" 10:00 по часам. Сравнение — по времени Ташкента,
    независимо от того, в каком часовом поясе физически работает сервер."""
    cutoff_h, cutoff_m = map(int, config.ORDER_CUTOFF_TIME.split(":"))
    cutoff_moment = dt.datetime.combine(
        _active_menu_day(), dt.time(cutoff_h, cutoff_m), tzinfo=TASHKENT_TZ
    )
    return _now() >= cutoff_moment


def is_after_cancel_cutoff(order_date_str: str = None) -> bool:
    """Отмена заказа клиентом разрешена до CANCEL_CUTOFF_TIME дня, на который
    оформлен заказ (обычно совпадает с датой активного меню), а не до 09:00
    текущих календарных суток — та же логика, что и is_after_cutoff() для
    приёма заказов (см. её комментарий). Если конкретная дата заказа
    известна (обычный случай — передаётся дата из group["date"]), сравниваем
    именно с ней; иначе — с датой активного меню."""
    cutoff_h, cutoff_m = map(int, config.CANCEL_CUTOFF_TIME.split(":"))
    day = None
    if order_date_str:
        try:
            day = dt.datetime.strptime(order_date_str, "%d.%m.%Y").date()
        except ValueError:
            day = None
    if day is None:
        day = _active_menu_day()
    cutoff_moment = dt.datetime.combine(day, dt.time(cutoff_h, cutoff_m), tzinfo=TASHKENT_TZ)
    return _now() >= cutoff_moment


def is_order_complete(order_date_str: str) -> bool:
    """Заказ считается "Завершён" после ORDER_COMPLETE_TIME дня, на который
    он оформлен (по времени Ташкента) — до этого момента статус "Принят"."""
    complete_h, complete_m = map(int, config.ORDER_COMPLETE_TIME.split(":"))
    try:
        day = dt.datetime.strptime(order_date_str, "%d.%m.%Y").date()
    except ValueError:
        return False
    complete_moment = dt.datetime.combine(day, dt.time(complete_h, complete_m), tzinfo=TASHKENT_TZ)
    return _now() >= complete_moment


def today_date_str() -> str:
    return _now().strftime("%d.%m.%Y")


def get_tomorrow_date_str() -> str:
    return (_now() + dt.timedelta(days=1)).strftime("%d.%m.%Y")


def get_recent_order_dates() -> list:
    """Уникальные даты, реально встречающиеся в «Заказы», в окне последних
    7 дней (включая сегодня) и завтра — источник для кнопок выбора даты в
    отчётах администратора. Хронологический порядок, формат DD.MM.YYYY."""
    ws = _ws(config.SHEET_ORDERS)
    col = ws.col_values(config.O_DATE)
    today = _now().date()
    window_start = today - dt.timedelta(days=6)
    window_end = today + dt.timedelta(days=1)

    seen = set()
    out = []
    for i, raw in enumerate(col):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        raw = raw.strip()
        if not raw or raw in seen:
            continue
        try:
            d = dt.datetime.strptime(raw, "%d.%m.%Y").date()
        except ValueError:
            continue
        if window_start <= d <= window_end:
            seen.add(raw)
            out.append((d, raw))

    out.sort(key=lambda t: t[0])
    return [raw for _, raw in out]


# ---------------------------------------------------------------------------
# Справочники (цены, меню на сегодня)
# ---------------------------------------------------------------------------

# REF_SET_PRICE_RANGE ("F2:G20"), REF_SET_GARNISH_RANGE ("F2:H20") и
# REF_SET_TABLE_RANGE ("F2:O20") — ВСЕ один и тот же участок таблицы
# "Справочники" (столбцы F-O, одни и те же строки), просто разной
# ширины. get_set_prices/get_sets_with_garnish/get_set_extra/
# get_today_garnishes_for_set(_all_sets) раньше читали его каждая СВОИМ
# отдельным запросом — а все вместе вызываются на КАЖДУЮ загрузку
# /api/menu (см. pauseapp.api_menu), то есть каждое открытие приложения
# любым клиентом делало 4+ запросов на один и тот же диапазон, плюс ещё
# по 2 запроса НА КАЖДЫЙ сет с гарниром (см. старый
# get_today_garnishes_for_set, звавшийся в цикле по сетам из
# pauseapp._serialize_sets) — воспроизведено и подтверждено как прямая
# причина "server_error" при одновременном открытии приложения
# несколькими клиентами (например, сразу после рассылки о публикации
# меню). Теперь один общий короткий кэш на самый широкий диапазон
# (F2:O20) — туда помещаются все нужные столбцы разом, читается не чаще
# раза в TTL, и все функции ниже берут данные из него, не делая
# собственных походов в Sheets.
_ref_set_table_cache = {"rows": None, "ts": 0}
_REF_SET_TABLE_TTL = 10  # секунд — каталог почти никогда не меняется чаще


def _invalidate_ref_set_table_cache():
    _ref_set_table_cache["rows"] = None
    _ref_set_table_cache["ts"] = 0


def _ref_set_table_rows() -> list:
    now = time.time()
    if _ref_set_table_cache["rows"] is not None and now - _ref_set_table_cache["ts"] < _REF_SET_TABLE_TTL:
        return _ref_set_table_cache["rows"]
    rows = _ws(config.SHEET_REFERENCE).get(config.REF_SET_TABLE_RANGE)
    _ref_set_table_cache["rows"] = rows
    _ref_set_table_cache["ts"] = now
    return rows


def get_set_prices() -> dict:
    values = _ref_set_table_rows()
    out = {}
    for row in values:
        if len(row) >= 2 and row[0]:
            try:
                out[row[0]] = int(str(row[1]).replace(" ", "").replace(",", ""))
            except ValueError:
                pass
    return out


def get_set_margins() -> dict:
    """Валовая прибыль с одного сета (столбец P, см. config.
    REF_SET_MARGIN_COL) — сколько зарабатываем с проданной штуки до
    вычета доставки/курьера и прочих расходов. Для Операционного центра
    (PAUSE App) — больше нигде не используется. Админ меняет прямо в
    таблице, как и цену; пустая ячейка — 0 (сет ещё не внесён в
    расчёт прибыли, не ошибка)."""
    ws = _ws(config.SHEET_REFERENCE)
    values = ws.get(config.REF_SET_MARGIN_RANGE)
    out = {}
    for row in values:
        if not row or not row[0]:
            continue
        cell = row[config.REF_SET_MARGIN_COL_IDX] if len(row) > config.REF_SET_MARGIN_COL_IDX else ""
        try:
            out[row[0]] = int(str(cell).replace(" ", "").replace(",", "")) if str(cell).strip() else 0
        except ValueError:
            out[row[0]] = 0
    return out


# Разовое первое заполнение столбца P — см. /seed_set_margins в
# handlers/admin.py. Цифры прямо от пользователя (сверены построчно в
# чате); дальше админ меняет их сам в таблице, бот сюда больше не пишет.
DEFAULT_SET_MARGINS = {
    "Блюдо дня": 15000,
    "Сет Prime": 15000,
    "Сет стандарт": 15000,
    "Боул": 15000,
    "Самса": 20000,
    "Самса без компота": 15000,
    "Chicken bowl": 15000,
    "Beef bowl": 15000,
    "Чизкейк": 6000,
}


def seed_set_margins() -> dict:
    """Пишет DEFAULT_SET_MARGINS в столбец P для каждого сета из
    REF_SET_PRICE_RANGE (столбец F), который есть в этом словаре — сет,
    которого там нет (новый, добавленный позже), не трогает, его
    прибыль нужно будет вписать в таблицу вручную. Возвращает
    {"seeded": [...], "skipped": [...]} — какие сеты заполнены, какие
    пропущены (их в DEFAULT_SET_MARGINS нет)."""
    ws = _ws(config.SHEET_REFERENCE)
    values = ws.get(config.REF_SET_PRICE_RANGE)
    cells = []
    seeded, skipped = [], []
    for i, row in enumerate(values):
        r = i + 2  # REF_SET_PRICE_RANGE = "F2:G20" — данные с строки 2
        if not row or not row[0]:
            continue
        name = row[0]
        if name in DEFAULT_SET_MARGINS:
            cells.append(gspread.Cell(r, config.REF_SET_MARGIN_COL, DEFAULT_SET_MARGINS[name]))
            seeded.append(name)
        else:
            skipped.append(name)
    if cells:
        ws.update_cells(cells, value_input_option="RAW")
    return {"seeded": seeded, "skipped": skipped}


def get_sets() -> list:
    """Список названий сетов для кнопок "какие сеты сегодня" (шаг 1
    публикации меню) — те же самые технические имена, что и в таблице
    цена/гарнир (REF_SET_PRICE_RANGE, столбец F). Раньше это был ОТДЕЛЬНЫЙ
    список в столбце B (REF_SETS_RANGE) — та же самая информация,
    продублированная вручную в двух местах таблицы, и ничто не следило,
    чтобы оба списка совпадали. Именно так в столбце B задержалось
    устаревшее «Чизкейк "Классический" » уже после того, как столбец F
    обновили на чистое «Чизкейк»: кнопка на шаге "сеты сегодня"
    продолжала предлагать старое имя, которое не совпадало ни с ценой, ни
    с гарниром (оба смотрят в F) — отсюда гарнир не спрашивался, а цена
    в предпросмотре показывала 0. Теперь один источник вместо двух,
    дублировать и рассинхронизировать нечего."""
    return [row[0] for row in _ref_set_table_rows() if row and row[0]]


def get_sets_with_garnish() -> set:
    """Имена сетов (в нижнем регистре, без пробелов по краям), для которых
    в "Справочники" столбец "Гарнир (да/нет)" (H, рядом с Сет/Цена) стоит
    "Да" — только у них клиент видит шаг выбора гарнира (см.
    handlers/order.py: chosen_set). Раньше это было жёстко привязано к
    имени "Сет стандарт" — теперь для нового сета с гарниром достаточно
    отметить "Да" в этой таблице, без правки кода."""
    values = _ref_set_table_rows()
    return {
        row[0].strip().lower()
        for row in values
        if len(row) >= 3 and row[0] and row[2].strip().lower() == "да"
    }


def get_set_extra() -> dict:
    """Категория, фото-ссылка и описание (список ингредиентов) каждого
    сета, по точному (регистрозависимому) имени сета — колонки M/N/O той
    же строки, что цена/гарнир (см. config.REF_SET_TABLE_RANGE). Один
    запрос на весь каталог сразу, а не поячейково — тот же принцип, что и
    в остальных get_* здесь, чтобы не плодить лишние обращения к Sheets
    API на каждую загрузку /api/menu. "description" — сырой текст с
    переводами строк как записал set_set_description; на буллеты его
    режет уже pauseapp.py:_serialize_sets."""
    rows = _ref_set_table_rows()
    out = {}
    for row in rows:
        if not row or not row[0]:
            continue
        cat_i, photo_i, desc_i = (
            config.REF_SET_CATEGORY_COL_IDX, config.REF_SET_PHOTO_COL_IDX, config.REF_SET_DESCRIPTION_COL_IDX,
        )
        out[row[0]] = {
            "category": row[cat_i].strip() if len(row) > cat_i and row[cat_i] else "",
            "photo_url": row[photo_i].strip() if len(row) > photo_i and row[photo_i] else "",
            "description": row[desc_i].strip() if len(row) > desc_i and row[desc_i] else "",
        }
    return out


_SS_HEADER = ["Сет", "История"]
_set_stories_lock = threading.Lock()


def get_set_stories() -> dict:
    """{имя сета или группы: текст истории} — для карточек на Главной."""
    now = time.time()
    if _cache.get("set_stories") is not None and now - _cache.get("set_stories_ts", 0) < _CACHE_TTL:
        return _cache["set_stories"]
    ws = _ws_or_create(config.SHEET_SET_STORIES, _SS_HEADER)
    out = {}
    for r in ws.get_all_values()[1:]:
        if r and r[0].strip():
            out[r[0].strip()] = (r[1] if len(r) > 1 else "").strip()
    _cache["set_stories"] = out
    _cache["set_stories_ts"] = now
    return out


def set_set_story(key: str, text: str):
    key = key.strip()
    with _set_stories_lock:
        ws = _ws_or_create(config.SHEET_SET_STORIES, _SS_HEADER)
        rows = ws.get_all_values()
        for i, r in enumerate(rows):
            if i and r and r[0].strip() == key:
                ws.update_cells([gspread.Cell(i + 1, 2, text)], value_input_option="RAW")
                break
        else:
            ws.append_row([key, text], value_input_option="RAW")
        _cache["set_stories"] = None


def get_garnishes() -> list:
    """Полный список всех возможных гарниров — справочник на будущее."""
    ws = _ws(config.SHEET_REFERENCE)
    return [v[0] for v in ws.get(config.REF_GARNISH_RANGE) if v]


def get_today_garnishes_for_set(set_name: str) -> list:
    """Гарниры, которые реально есть СЕГОДНЯ для КОНКРЕТНОГО сета — раньше
    был один общий список на все сеты сразу (одна ячейка), теперь отдельный
    список на каждый сет (столбец I той же строки, что цена/признак гарнира
    этого сета — см. config.REF_SET_TODAY_GARNISH_COL/REF_SET_GARNISH_RANGE):
    у "Сет стандарт" и, например, "Chiken bowl" могут быть РАЗНЫЕ гарниры на
    один и тот же день. Задаёт админ в ЧЕРНОВИКЕ, отдельным вопросом на
    каждый сет с Гарнир=Да, ещё до публикации (см. handlers/admin.py:
    _start_garnish_queue/admin_today_garnish_save — пишут в столбец
    черновика, публикация переносит его в этот столбец разом для ВСЕХ
    строк, включая пустые, — см. sheets.publish_draft_menu). Пустой
    список — это не "используй общий справочник", а "гарнира на выбор
    сегодня для ЭТОГО сета нет вообще" (см. handlers/order.py:
    _proceed_after_set_choice)."""
    rows = _ref_set_table_rows()
    name = set_name.strip().lower()
    for row in rows:
        if row and row[0].strip().lower() == name:
            val = row[3] if len(row) > 3 else ""
            return [g.strip() for g in val.split(",") if g.strip()]
    return []


def get_today_garnishes_for_all_sets() -> dict:
    """{имя сета в нижнем регистре: [гарнир, ...]} для ВСЕХ сетов разом —
    см. get_today_garnishes_for_set. Для "Меню" в PAUSE App (см.
    pauseapp.py: api_menu/_serialize_sets), которая раньше звала
    get_today_garnishes_for_set ПООЧЕРЁДНО на каждый сет с гарниром —
    на каталоге из нескольких таких сетов это было несколько лишних
    чтений Sheets на КАЖДОЕ открытие приложения любым клиентом."""
    out = {}
    for row in _ref_set_table_rows():
        if not row or not row[0]:
            continue
        val = row[3] if len(row) > 3 else ""
        out[row[0].strip().lower()] = [g.strip() for g in val.split(",") if g.strip()]
    return out


def set_today_garnishes_for_set(set_name: str, garnishes: list):
    """Записывает гарниры на сегодня для одного сета. Если set_name — имя
    группы переменной цены (config.SET_VARIANTS, например "Самса"), пишет
    ОДИНАКОВЫЙ список во ВСЕ технические варианты группы разом — гарнир
    общий для всех вариантов группы, в отличие от цены."""
    names = [t for t, _ in config.SET_VARIANTS[set_name]] if set_name in config.SET_VARIANTS else [set_name]
    ws = _ws(config.SHEET_REFERENCE)
    rows = ws.get(config.REF_SET_GARNISH_RANGE)
    value = ", ".join(garnishes)
    cells = [
        gspread.Cell(2 + i, config.REF_SET_TODAY_GARNISH_COL, value)
        for i, row in enumerate(rows)
        if row and row[0].strip() in names
    ]
    if cells:
        ws.update_cells(cells)
    _invalidate_ref_set_table_cache()


def set_set_photo(set_name: str, file_id: str):
    """Записывает Telegram file_id фото блюда в столбец N (Фото-ссылка,
    см. config.REF_SET_PHOTO_COL) — та же логика группировки, что и в
    set_today_garnishes_for_set: если set_name — имя группы переменной
    цены (config.SET_VARIANTS, например "Самса"), пишет ОДИНАКОВЫЙ
    file_id во ВСЕ технические варианты группы разом, т.к. клиент видит
    группу одной карточкой с одним фото (см. pauseapp.py:_serialize_sets)."""
    names = [t for t, _ in config.SET_VARIANTS[set_name]] if set_name in config.SET_VARIANTS else [set_name]
    ws = _ws(config.SHEET_REFERENCE)
    rows = ws.get(config.REF_SET_TABLE_RANGE)
    cells = [
        gspread.Cell(2 + i, config.REF_SET_PHOTO_COL, file_id)
        for i, row in enumerate(rows)
        if row and row[0].strip() in names
    ]
    if cells:
        ws.update_cells(cells)
    _invalidate_ref_set_table_cache()


def set_set_description(set_name: str, description: str):
    """Записывает список ингредиентов блюда в столбец O (Описание, см.
    config.REF_SET_DESCRIPTION_COL) — та же группировка вариантов
    переменной цены, что и в set_set_photo/set_today_garnishes_for_set.
    description хранится как есть, с переводами строк — каждая строка
    станет отдельным буллетом на карточке (см. pauseapp.py:_serialize_sets)."""
    names = [t for t, _ in config.SET_VARIANTS[set_name]] if set_name in config.SET_VARIANTS else [set_name]
    ws = _ws(config.SHEET_REFERENCE)
    rows = ws.get(config.REF_SET_TABLE_RANGE)
    cells = [
        gspread.Cell(2 + i, config.REF_SET_DESCRIPTION_COL, description)
        for i, row in enumerate(rows)
        if row and row[0].strip() in names
    ]
    if cells:
        ws.update_cells(cells)
    _invalidate_ref_set_table_cache()


def set_set_garnish_flag(set_name: str, enabled: bool):
    """Переключает catalog-признак "есть ли у сета гарнир вообще"
    (столбец H, см. config.REF_SET_GARNISH_RANGE/get_sets_with_garnish) —
    раньше его можно было поменять только вручную прямо в таблице, теперь
    и через PAUSE App ("Операционный центр" → "Меню" → "Карточки сетов").
    ВАЖНО: это НЕ то же самое, что гарниры "на сегодня" (столбцы I/L) —
    здесь только да/нет "в принципе предлагать выбор гарнира"; сам список
    гарниров на сегодня для этого сета по-прежнему задаётся отдельно (см.
    set_today_garnishes_for_set/set_draft_garnishes_for_set). Та же
    группировка вариантов переменной цены, что у set_set_photo и соседей."""
    names = [t for t, _ in config.SET_VARIANTS[set_name]] if set_name in config.SET_VARIANTS else [set_name]
    ws = _ws(config.SHEET_REFERENCE)
    rows = ws.get(config.REF_SET_GARNISH_RANGE)
    cells = [
        gspread.Cell(2 + i, 8, "Да" if enabled else "Нет")  # H = абсолютный столбец 8
        for i, row in enumerate(rows)
        if row and row[0].strip() in names
    ]
    if cells:
        ws.update_cells(cells)
    _invalidate_ref_set_table_cache()


def get_set_display_name_overrides() -> dict:
    """{техническое_имя: кастомное_клиентское_имя}, только непустые
    переопределения — столбец Q (см. config.REF_SET_DISPLAY_NAME_COL),
    тот же общий короткий кэш _ref_set_table_rows(), что и у категории/
    фото/описания рядом. Используется display_set_name() ниже."""
    idx = config.REF_SET_DISPLAY_NAME_COL_IDX
    out = {}
    for row in _ref_set_table_rows():
        if row and row[0] and len(row) > idx and row[idx].strip():
            out[row[0]] = row[idx].strip()
    return out


def display_set_name(name: str) -> str:
    """Клиентское имя сета — ЕДИНСТВЕННАЯ точка входа везде (бот и PAUSE
    App), заменяет собой прямые вызовы texts.display_set_name. Порядок:
    1) переопределение из таблицы (админ переименовал через PAUSE App →
    "Меню" → "Названия для покупателей", см. set_set_display_name), 2)
    дефолт из texts.SET_DISPLAY_NAMES (тот словарь остаётся только как
    набор стартовых значений, сам по себе больше нигде не вызывается
    напрямую), 3) само техническое имя как есть, если нигде не задано."""
    overrides = get_set_display_name_overrides()
    if name in overrides:
        return overrides[name]
    return texts.SET_DISPLAY_NAMES.get(name, name)


def set_set_display_name(set_name: str, display_name: str):
    """Пишет кастомное клиентское имя в столбец Q — пустая строка стирает
    переопределение (откат к дефолту из texts.SET_DISPLAY_NAMES/самому
    техническому имени, см. display_set_name). Та же группировка
    вариантов переменной цены, что у set_set_photo/set_set_description:
    группа (например "Самса") пишется в ОБА технических варианта разом —
    иначе заказ именно "без компота" варианта (см. display_set_name,
    вызывается с ТЕХНИЧЕСКИМ именем строки заказа, не именем группы) всё
    ещё показывал бы старое имя."""
    names = [t for t, _ in config.SET_VARIANTS[set_name]] if set_name in config.SET_VARIANTS else [set_name]
    ws = _ws(config.SHEET_REFERENCE)
    rows = ws.get(config.REF_SET_TABLE_RANGE)
    value = (display_name or "").strip()
    cells = [
        gspread.Cell(2 + i, config.REF_SET_DISPLAY_NAME_COL, value)
        for i, row in enumerate(rows)
        if row and row[0].strip() in names
    ]
    if cells:
        ws.update_cells(cells)
    _invalidate_ref_set_table_cache()


def get_today_sets() -> list:
    """Сеты, реально доступные сегодня для заказа — задаёт админ после
    публикации меню, кнопками-чекбоксами (см. handlers/admin.py:
    admin_sets_toggle/admin_sets_done), похожим способом на
    get_today_garnishes_for_set(). Раньше этого шага не было вовсе — клиент
    всегда видел ВЕСЬ каталог (get_sets(), "Справочники"!B2:B20) целиком,
    независимо от того, что реально было в опубликованном меню; из-за этого,
    например, "Боул" показывался клиенту как вариант заказа даже в те дни,
    когда его не было в меню вообще — воспроизведено и подтверждено на
    реальных данных.

    В отличие от гарниров пустое значение здесь означает НЕ "сетов
    сегодня нет" (это увело бы клиента в меню вовсе без единой кнопки
    заказа — несравнимо хуже, чем лишняя кнопка), а "явного сужения нет,
    показываем весь каталог целиком" — ровно то поведение, что и было
    единственно возможным до появления этой функции. Черновик (см.
    start_new_menu_draft) сбрасывает свою копию этого значения в пустой
    список при каждом новом черновике, а публикация (см. publish_draft_menu)
    переносит её сюда как есть — если админ так и не отметил ни одного сета
    в черновике, это безопасный откат к "показываем всё", а не отказ в
    обслуживании.

    Сет с переменной ценой (см. config.SET_VARIANTS) технически заведён
    как НЕСКОЛЬКО имён — если админ впишет сюда только одно из них (или
    имя группы), достраиваем остальные автоматически, чтобы не оставить
    один из вариантов молча недоступным для заказа."""
    ws = _ws(config.SHEET_REFERENCE)
    raw = ws.acell(config.REF_TODAY_SETS_CELL).value or ""
    sets = [s.strip() for s in raw.split(",") if s.strip()]
    if not sets:
        return get_sets()
    out = []
    for s in sets:
        group = config.SET_VARIANT_GROUP.get(s)
        if group:
            for technical, _ in config.SET_VARIANTS[group]:
                if technical not in out:
                    out.append(technical)
        elif s not in out:
            out.append(s)
    return out


def set_today_sets(sets: list):
    ws = _ws(config.SHEET_REFERENCE)
    ws.update_acell(config.REF_TODAY_SETS_CELL, ", ".join(sets))


# ---------------------------------------------------------------------------
# Черновик меню — готовится ДО публикации (см. handlers/admin.py: шаги 1-5
# нового флоу публикации), полностью отдельно от активных ячеек выше — см.
# config.py комментарий у REF_DRAFT_MENU_CELL. Пока админ не нажал "✅
# Опубликовать" (см. publish_draft_menu), ни одна из этих функций не
# трогает то, что видят клиенты.
# ---------------------------------------------------------------------------

def get_draft_menu() -> tuple:
    """Возвращает (список file_id фотографий, подпись поста) черновика —
    как get_today_menu_photos(), но для ещё не опубликованного меню."""
    ws = _ws(config.SHEET_REFERENCE)
    ids_raw = ws.acell(config.REF_DRAFT_MENU_CELL).value or ""
    caption = ws.acell(config.REF_DRAFT_MENU2_CELL).value or ""
    photo_ids = [p.strip() for p in ids_raw.split(",") if p.strip()]
    return photo_ids, caption


def set_draft_menu(photo_ids: list, caption: str):
    ws = _ws(config.SHEET_REFERENCE)
    ws.update_acell(config.REF_DRAFT_MENU_CELL, ",".join(photo_ids))
    ws.update_acell(config.REF_DRAFT_MENU2_CELL, caption or "")


def get_draft_sets_raw() -> list:
    """Сырой список черновика "сегодняшних сетов" — БЕЗ отката к полному
    каталогу при пустом значении и БЕЗ разворачивания группы переменной
    цены в оба технических варианта (см. get_draft_sets() — та версия для
    клиентского показа/сбора очереди гарниров). Эта версия — для того,
    чтобы повторно открыть клавиатуру-чекбокс с уже отмеченными сетами
    (см. handlers/admin.py: admin_preview_edit_sets), и для самой
    публикации (см. publish_draft_menu) — там нужен именно тот список,
    что реально отмечал админ, один в один как раньше писался в
    set_today_sets."""
    ws = _ws(config.SHEET_REFERENCE)
    raw = ws.acell(config.REF_DRAFT_SETS_CELL).value or ""
    return [s.strip() for s in raw.split(",") if s.strip()]


def get_draft_sets() -> list:
    """Как get_today_sets(), но для черновика — та же семантика "пусто =
    не сужено, весь каталог" и то же разворачивание группы переменной
    цены (config.SET_VARIANTS) в оба технических варианта."""
    sets = get_draft_sets_raw()
    if not sets:
        return get_sets()
    out = []
    for s in sets:
        group = config.SET_VARIANT_GROUP.get(s)
        if group:
            for technical, _ in config.SET_VARIANTS[group]:
                if technical not in out:
                    out.append(technical)
        elif s not in out:
            out.append(s)
    return out


def set_draft_sets(sets: list):
    ws = _ws(config.SHEET_REFERENCE)
    ws.update_acell(config.REF_DRAFT_SETS_CELL, ", ".join(sets))


def get_draft_garnishes_for_set(set_name: str) -> list:
    """Как get_today_garnishes_for_set(), но читает столбец черновика
    (REF_SET_DRAFT_GARNISH_COL) вместо активного."""
    ws = _ws(config.SHEET_REFERENCE)
    rows = ws.get(config.REF_SET_GARNISH_RANGE)
    name = set_name.strip().lower()
    for i, row in enumerate(rows):
        if row and row[0].strip().lower() == name:
            r = 2 + i
            val = ws.cell(r, config.REF_SET_DRAFT_GARNISH_COL).value or ""
            return [g.strip() for g in val.split(",") if g.strip()]
    return []


def set_draft_garnishes_for_set(set_name: str, garnishes: list):
    """Как set_today_garnishes_for_set(), но пишет в столбец черновика —
    группа переменной цены (config.SET_VARIANTS) тем же приёмом пишется во
    ВСЕ технические варианты группы разом."""
    names = [t for t, _ in config.SET_VARIANTS[set_name]] if set_name in config.SET_VARIANTS else [set_name]
    ws = _ws(config.SHEET_REFERENCE)
    rows = ws.get(config.REF_SET_GARNISH_RANGE)
    value = ", ".join(garnishes)
    cells = [
        gspread.Cell(2 + i, config.REF_SET_DRAFT_GARNISH_COL, value)
        for i, row in enumerate(rows)
        if row and row[0].strip() in names
    ]
    if cells:
        ws.update_cells(cells)


def reset_draft_set_garnishes():
    """Сбрасывает гарниры черновика для ВСЕХ сетов каталога разом —
    вызывается при начале КАЖДОГО нового черновика (см. start_new_menu_draft),
    чтобы брошенный на середине предыдущий черновик не протёк гарнирами в
    новый."""
    ws = _ws(config.SHEET_REFERENCE)
    rows = ws.get(config.REF_SET_GARNISH_RANGE)
    cells = [gspread.Cell(2 + i, config.REF_SET_DRAFT_GARNISH_COL, "") for i in range(len(rows))]
    if cells:
        ws.update_cells(cells)


def start_new_menu_draft(photo_ids: list, caption: str):
    """Начинает НОВЫЙ черновик меню (координатор прислал фото/текст) —
    сохраняет фото/подпись и сбрасывает сеты/гарниры черновика на "не
    заданы" СРАЗУ, ещё до вопросов (тот же приём безопасного дефолта, что
    и раньше был у активных ячеек при публикации) — на случай, если
    предыдущий черновик был брошен на середине с какими-то отметками.
    Активное меню (то, что видят клиенты) не трогает вообще — см.
    publish_draft_menu, единственное место, которое переносит черновик в
    активные ячейки."""
    set_draft_menu(photo_ids, caption)
    set_draft_sets([])
    reset_draft_set_garnishes()


def clear_menu_draft():
    ws = _ws(config.SHEET_REFERENCE)
    ws.update_acell(config.REF_DRAFT_MENU_CELL, "")
    ws.update_acell(config.REF_DRAFT_MENU2_CELL, "")
    ws.update_acell(config.REF_DRAFT_SETS_CELL, "")
    reset_draft_set_garnishes()


def publish_draft_menu(date_str: str):
    """Публикует черновик — ОДНА операция, переносящая фото/подпись/сеты/
    гарниры черновика в активные ячейки (см. set_today_menu_photos/
    set_active_menu_date/set_today_sets), затем сразу же чистит черновик.
    До этого вызова клиенты продолжают видеть предыдущее активное меню как
    ни в чём не бывало, сколько бы шагов подготовки черновика ни прошло и
    сколько раз админ ни возвращался бы что-то поправить."""
    photo_ids, caption = get_draft_menu()
    set_today_menu_photos(photo_ids, caption)
    set_active_menu_date(date_str)
    set_today_sets(get_draft_sets_raw())

    ws = _ws(config.SHEET_REFERENCE)
    rows = ws.get(config.REF_SET_GARNISH_RANGE)
    cells = []
    for i, row in enumerate(rows):
        r = 2 + i
        draft_val = ws.cell(r, config.REF_SET_DRAFT_GARNISH_COL).value or ""
        cells.append(gspread.Cell(r, config.REF_SET_TODAY_GARNISH_COL, draft_val))
    if cells:
        ws.update_cells(cells)
    _invalidate_ref_set_table_cache()

    clear_menu_draft()


def get_payment_options() -> list:
    ws = _ws(config.SHEET_REFERENCE)
    return [v[0] for v in ws.get(config.REF_PAYMENT_RANGE) if v]


def get_today_menu_photos() -> tuple:
    """Возвращает (список file_id фотографий, подпись поста) — как прислал координатор."""
    ws = _ws(config.SHEET_REFERENCE)
    ids_raw = ws.acell(config.REF_TODAY_MENU_CELL).value or ""
    caption = ws.acell(config.REF_TODAY_MENU2_CELL).value or ""
    photo_ids = [p.strip() for p in ids_raw.split(",") if p.strip()]
    return photo_ids, caption


def set_today_menu_photos(photo_ids: list, caption: str):
    """Сохраняет фото/подпись меню. Дату доставки, на которую действует
    меню, бот больше не угадывает сам — её явно задаёт админ отдельным
    шагом сразу после публикации (см. set_active_menu_date)."""
    ws = _ws(config.SHEET_REFERENCE)
    ws.update_acell(config.REF_TODAY_MENU_CELL, ",".join(photo_ids))
    ws.update_acell(config.REF_TODAY_MENU2_CELL, caption or "")


def set_active_menu_date(date_str: str):
    """Явно задаёт дату доставки, на которую действует опубликованное
    меню — админ выбирает её сам при публикации ("Сегодня"/"Завтра" или
    вписывает вручную). Одна ячейка, значение просто перезаписывается —
    старая дата после этого нигде больше не используется, полностью
    заменяется новой.

    Публикация нового меню также заново открывает окно участия в
    "Паузе в подарок" (см. is_giveaway_window_closed) — оно закрывается
    только вызовом close_giveaway_window (сейчас ничто не вызывает его
    автоматически: выбор победителя происходит вручную, вне бота), а
    публикация меню снимает это закрытие."""
    ws = _ws(config.SHEET_REFERENCE)
    ws.update_acell(config.REF_TODAY_MENU_DATE_CELL, date_str)
    ws.update_acell(config.REF_GIVEAWAY_CLOSED_CELL, "")
    _cache["active_menu_date"] = None


def is_giveaway_window_closed() -> bool:
    """Окно участия в "Паузе в подарок" закрыто, если сегодняшний
    розыгрыш уже подведён (см. close_giveaway_window) и с тех пор ещё не
    публиковалось новое меню (публикация снимает закрытие)."""
    ws = _ws(config.SHEET_REFERENCE)
    return (ws.acell(config.REF_GIVEAWAY_CLOSED_CELL).value or "").strip().lower() == "да"


def close_giveaway_window():
    """Отмечает, что сегодняшний розыгрыш подведён — окно участия закрыто
    до публикации следующего меню."""
    ws = _ws(config.SHEET_REFERENCE)
    ws.update_acell(config.REF_GIVEAWAY_CLOSED_CELL, "Да")


def is_broadcasts_disabled() -> bool:
    """Все автоматические push-рассылки клиентам (тёплая утренняя в 8:00,
    напоминание об оплате в 14:30, ежедневный розыгрыш "Пауза в подарок")
    временно отключены админом через /broadcasts_off — до /broadcasts_on.
    Хранится в ячейке "Справочники", переживает перезапуск/деплой бота.
    Утренний отчёт для кухни клиентам не идёт и этим флагом не управляется."""
    ws = _ws(config.SHEET_REFERENCE)
    return (ws.acell(config.REF_BROADCASTS_OFF_CELL).value or "").strip().lower() == "да"


def set_broadcasts_disabled(disabled: bool):
    ws = _ws(config.SHEET_REFERENCE)
    ws.update_acell(config.REF_BROADCASTS_OFF_CELL, "Да" if disabled else "")


# ---------------------------------------------------------------------------
# Цифровые "послания дня" — замена бумажным карточкам с номерами
# ---------------------------------------------------------------------------

def get_next_message_number() -> int:
    """Следующий номер послания — строго последовательно, без пропусков и
    повторов, начиная с CARE_MESSAGE_START_NUMBER. Последний выданный номер
    хранится в ячейке "Справочники" — переживает перезапуск/деплой бота."""
    ws = _ws(config.SHEET_REFERENCE)
    raw = (ws.acell(config.REF_LAST_MESSAGE_NUMBER_CELL).value or "").strip()
    try:
        last = int(raw)
    except ValueError:
        last = config.CARE_MESSAGE_START_NUMBER - 1
    next_number = last + 1
    ws.update_acell(config.REF_LAST_MESSAGE_NUMBER_CELL, str(next_number))
    return next_number


def save_care_message(number: int, tg_id, name: str, date_str: str, phrase: str, popup: bool = False):
    """popup=True — послание ещё НЕ показано клиенту (первый заказ на новую
    точку: карточка выдаётся только после подтверждения адреса админом) —
    приложение покажет его окном при следующем открытии."""
    ws = _ws(config.SHEET_MESSAGES)
    row = [number, str(tg_id), name, date_str, phrase]
    if popup:
        row.append("нет")
    ws.append_row(row, value_input_option="RAW")


def get_unseen_care_message(tg_id):
    """Первое ещё не показанное послание клиента (см. save_care_message(popup=True))
    или None."""
    ws = _ws(config.SHEET_MESSAGES)
    rows = ws.get_all_values()
    target = str(tg_id)
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.MSG_DATA_START_ROW or len(row) < config.MSG_SHOWN:
            continue
        if row[config.MSG_TG_ID - 1].strip() == target and row[config.MSG_SHOWN - 1].strip() == "нет":
            return {"row": r, "number": row[config.MSG_NUMBER - 1].strip(), "text": row[config.MSG_TEXT - 1].strip()}
    return None


def mark_care_message_seen(tg_id, number) -> bool:
    ws = _ws(config.SHEET_MESSAGES)
    rows = ws.get_all_values()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.MSG_DATA_START_ROW or len(row) < config.MSG_SHOWN:
            continue
        if (row[config.MSG_TG_ID - 1].strip() == str(tg_id) and row[config.MSG_NUMBER - 1].strip() == str(number)
                and row[config.MSG_SHOWN - 1].strip() == "нет"):
            ws.update_cell(r, config.MSG_SHOWN, "да")
            return True
    return False


def get_client_messages(tg_id) -> list:
    """Все послания клиента — [{"number", "date", "text"}], в порядке
    записи в таблице (старые сначала); сортировку "последние сначала"
    делает вызывающий код."""
    ws = _ws(config.SHEET_MESSAGES)
    rows = ws.get_all_values()
    target = str(tg_id)
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.MSG_DATA_START_ROW:
            continue
        if len(row) < config.MSG_TEXT:
            continue
        if row[config.MSG_TG_ID - 1].strip() != target:
            continue
        out.append({
            "number": row[config.MSG_NUMBER - 1].strip(),
            "date": row[config.MSG_DATE - 1].strip(),
            "text": row[config.MSG_TEXT - 1].strip(),
        })
    return out


def get_active_menu_date() -> str:
    """Дата доставки, на которую действует СЕЙЧАС опубликованное меню.

    Заказ должен получать дату не по текущему времени (иначе два человека,
    заказавшие в рамках одного и того же опубликованного меню — один
    вечером сразу после публикации, другой на следующее утро перед
    отсечкой, — получили бы разные даты), а именно эту: дату, которую
    админ явно выбрал при публикации текущего меню (см.
    set_active_menu_date) — публикация новой даты сама заменяет
    предыдущую, тем самым "закрывая" её.

    Кэшируется на несколько секунд — эта функция дёргается на КАЖДОЕ
    открытие экрана "Маршрут" в Mini App (и не только), значение при этом
    почти никогда не меняется чаще, чем раз в день (публикация меню) —
    короткий кэш заметно снижает число обращений к Sheets API при
    повторных открытиях подряд, не внося ощутимой задержки в редкий момент
    самой публикации (см. set_active_menu_date — сбрасывает кэш сразу)."""
    now = time.time()
    if _cache["active_menu_date"] is not None and now - _cache["active_menu_date_ts"] < 5:
        return _cache["active_menu_date"]
    ws = _ws(config.SHEET_REFERENCE)
    date_str = (ws.acell(config.REF_TODAY_MENU_DATE_CELL).value or "").strip()
    result = date_str or today_date_str()
    _cache["active_menu_date"] = result
    _cache["active_menu_date_ts"] = now
    return result


# ---------------------------------------------------------------------------
# Pause Club
# ---------------------------------------------------------------------------

def get_client_delivery_fee(order_count: int) -> int:
    """Стоимость доставки по статусу клиента (config.CLUB_DELIVERY_FEES) —
    чистая функция, таблицу не трогает. Вызывающий код (pauseapp.
    api_order_submit) сам решает, кому её вообще применять (пока только
    config.PAUSEAPP_TEST_CLIENT_IDS) — здесь просто число по уровню."""
    return config.CLUB_DELIVERY_FEES.get(get_club_level(order_count)["key"], 0)


def get_club_level(order_count: int) -> dict:
    """Уровень клуба по количеству заказов — чистая функция, таблицу не трогает."""
    levels = config.CLUB_LEVELS
    current = levels[0]
    next_level = None
    for i, (key, threshold, emoji, label) in enumerate(levels):
        if order_count >= threshold:
            current = (key, threshold, emoji, label)
            next_level = levels[i + 1] if i + 1 < len(levels) else None
        else:
            break
    key, _, emoji, label = current
    result = {
        "key": key, "emoji": emoji, "label": label, "order_count": order_count,
        "next_key": None, "next_label": None, "left": 0,
    }
    if next_level:
        next_key, next_threshold, next_emoji, next_label = next_level
        result["next_key"] = next_key
        result["next_label"] = next_label
        result["next_emoji"] = next_emoji
        result["left"] = max(0, next_threshold - order_count)
    return result


def get_club_levels_overview(order_count: int) -> list:
    """Все уровни Pause Club разом, каждый со своим диапазоном "сколько
    заказов" и отметками "уже пройден"/"текущий" — для экрана "все
    статусы" в PAUSE App (отличается от get_club_level, которая даёт
    только текущий+следующий уровень для короткой подсказки). "passed" —
    уровни СТРОГО ДО текущего (их клиент уже прошёл и двигается дальше),
    "current" — ровно один, на котором клиент сейчас. delivery/giveaways
    — чисто отображаемый текст из config.CLUB_BENEFITS, ни на какую
    реальную логику доставки/розыгрышей не влияет."""
    levels = config.CLUB_LEVELS
    current_key = get_club_level(order_count)["key"]
    current_index = next(i for i, l in enumerate(levels) if l[0] == current_key)
    out = []
    for i, (key, threshold, emoji, label) in enumerate(levels):
        next_threshold = levels[i + 1][1] if i + 1 < len(levels) else None
        if next_threshold is None:
            range_text = f"{threshold}+"
        elif next_threshold - threshold == 1:
            range_text = str(threshold)
        else:
            range_text = f"{threshold}–{next_threshold - 1}"
        benefits = config.CLUB_BENEFITS.get(key, {})
        out.append({
            "key": key,
            "label": label,
            "range_text": range_text,
            "passed": i < current_index,
            "current": i == current_index,
            "delivery": benefits.get("delivery", ""),
            "giveaways": benefits.get("giveaways", ""),
        })
    return out


def get_club_leaderboard(limit: int = 10) -> list:
    """Топ клиентов по количеству заказов — [{"tg_id", "name", "order_count",
    "club": {"key", "emoji", "label"}}], по убыванию order_count, не больше
    limit записей — для таблицы лидеров в PAUSE App ("Pause Club"). Только
    клиенты с привязанным tg_id (без него нет ни аватарки, ни смысла
    показывать) и хотя бы одним заказом — таблица из одних нулей была бы
    бессмысленной. config.LEADERBOARD_EXCLUDED_TG_IDS — по прямой просьбе,
    личные тестовые аккаунты владельца, в рейтинг не попадают никогда."""
    clients = _load_clients()
    ranked = [
        c for c in clients
        if c["tg_id"] and c["order_count"] > 0 and c["tg_id"] not in config.LEADERBOARD_EXCLUDED_TG_IDS
    ]
    ranked.sort(key=lambda c: -c["order_count"])
    out = []
    for c in ranked[:limit]:
        level = get_club_level(c["order_count"])
        out.append({
            "tg_id": c["tg_id"],
            "name": c["name"],
            "order_count": c["order_count"],
            "club": {"key": level["key"], "emoji": level["emoji"], "label": level["label"]},
        })
    return out


def get_club_leaderboard_me(tg_id) -> tuple:
    """(me, ranked_total) для закреплённой строки "Вы" в рейтинге: me —
    {"tg_id","name","order_count","club","rank"} (rank — место в том же
    порядке, что и get_club_leaderboard) либо None, если у человека нет
    заказов / он не в рейтинге; ranked_total — сколько всего участников
    в рейтинге."""
    clients = _load_clients()
    ranked = [
        c for c in clients
        if c["tg_id"] and c["order_count"] > 0 and c["tg_id"] not in config.LEADERBOARD_EXCLUDED_TG_IDS
    ]
    ranked.sort(key=lambda c: -c["order_count"])
    target = str(tg_id)
    for i, c in enumerate(ranked):
        if c["tg_id"] == target:
            level = get_club_level(c["order_count"])
            return {
                "tg_id": c["tg_id"], "name": c["name"], "order_count": c["order_count"], "rank": i + 1,
                "club": {"key": level["key"], "emoji": level["emoji"], "label": level["label"]},
            }, len(ranked)
    return None, len(ranked)


def get_total_clients_count() -> int:
    """Общее число зарегистрированных клиентов в Sheet1 — для карточки
    "Рейтинг" в PAUSE App ("N человек"), в отличие от get_club_leaderboard
    НЕ ограничено топом и не требует заказов/tg_id — просто все строки."""
    return len(_load_clients())


def get_club_info_text() -> str:
    ws = _ws(config.SHEET_CLUB)
    return ws.acell(config.CLUB_INFO_TEXT_CELL).value or ""


def set_club_info_text(text: str):
    ws = _ws(config.SHEET_CLUB)
    ws.update_acell(config.CLUB_INFO_TEXT_CELL, text or "")


# ---------------------------------------------------------------------------
# Ежедневный розыгрыш "Пауза в подарок" — отдельный от /giveaway механизм,
# работает каждый день сам по себе на дату активного меню.
# ---------------------------------------------------------------------------

# Короткий кэш сырых строк "Пауза в подарок" — тот же приём, что и у
# остальных часто читаемых листов в этом файле (см. _orders_raw_rows/
# _cash_raw_rows): PAUSE App теперь показывает живой пул на экране
# "Pause Club" (см. pauseapp.api_club_giveaway) — каждое открытие
# вкладки любым клиентом читало бы этот лист заново, без кэша.
_dg_raw_cache = {"rows": None, "ts": 0}
_DG_RAW_CACHE_TTL = 10  # секунд — пул почти "живой", короче обычных 15-20с


def _invalidate_dg_raw_cache():
    _dg_raw_cache["rows"] = None
    _dg_raw_cache["ts"] = 0


def _dg_raw_rows() -> list:
    now = time.time()
    if _dg_raw_cache["rows"] is not None and now - _dg_raw_cache["ts"] < _DG_RAW_CACHE_TTL:
        return _dg_raw_cache["rows"]
    rows = _ws(config.SHEET_DAILY_GIVEAWAY).get_all_values()
    _dg_raw_cache["rows"] = rows
    _dg_raw_cache["ts"] = now
    return rows


def is_in_daily_giveaway(date_str: str, tg_id) -> bool:
    rows = _dg_raw_rows()
    target = str(tg_id)
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.DG_DATA_START_ROW:
            continue
        if len(row) < config.DG_TG_ID:
            continue
        if row[config.DG_DATE - 1].strip() == date_str and row[config.DG_TG_ID - 1].strip() == target:
            return True
    return False


def join_daily_giveaway(date_str: str, client: dict):
    """Записывает клиента участником сегодняшнего розыгрыша — без
    дубликатов, повторное нажатие "Участвовать" ничего не ломает.
    Билеты считаются заново на момент нажатия (сумма количества всех
    сетов, заказанных клиентом сегодня). Старая, ручная механика
    бота ("🎉 Участвовать" в 🌿 Pause Club) — не тронута ни строкой;
    для автодобавления из PAUSE App см. auto_join_daily_giveaway ниже."""
    tg_id = client.get("tg_id")
    if not tg_id or is_in_daily_giveaway(date_str, tg_id):
        return
    tickets = get_client_ticket_counts(date_str).get(str(client.get("id")), 0)
    ws = _ws(config.SHEET_DAILY_GIVEAWAY)
    ws.append_row(
        [date_str, _id_value(client.get("id")), str(tg_id), client.get("name", ""), tickets, ""],
        value_input_option="RAW",
    )
    _invalidate_dg_raw_cache()


def is_giveaway_eligible(order_count: int) -> bool:
    """Доступ к пулу "Пауза в подарок" — со статуса GIVEAWAY_REQUIRED_LEVEL
    ("Внутренний круг", 10+ заказов) и выше: более высокий статус в
    CLUB_LEVELS по определению требует больше заказов, то есть порог уже
    пройден, отдельно его проверять не нужно."""
    required_threshold = next(th for key, th, _, _ in config.CLUB_LEVELS if key == config.GIVEAWAY_REQUIRED_LEVEL)
    return order_count >= required_threshold


def auto_join_daily_giveaway(date_str: str, client: dict) -> bool:
    """Автоматически добавляет клиента в сегодняшний пул "Пауза в
    подарок" сразу после оформления заказа в PAUSE App — ТОЛЬКО если
    статус уже позволяет (см. is_giveaway_eligible — client["order_count"]
    должен быть СВЕЖИМ, см. find_client_by_tg_id(force=True)), окно
    участия ещё не закрыто сегодняшним розыгрышем (см.
    is_giveaway_window_closed — публикация следующего меню открывает его
    заново) и клиент ещё не в пуле. Возвращает True, если только что
    добавлен (для "Вы в сегодняшнем пуле 🎉" на фронте), иначе False —
    без исключений в любом из "не положено" случаев, вызывающий код сам
    решает, что показать клиенту."""
    tg_id = client.get("tg_id")
    if not tg_id:
        return False
    if is_giveaway_window_closed():
        return False
    if is_in_daily_giveaway(date_str, tg_id):
        return False
    if not is_giveaway_eligible(client.get("order_count", 0)):
        return False
    ws = _ws(config.SHEET_DAILY_GIVEAWAY)
    ws.append_row(
        [date_str, _id_value(client.get("id")), str(tg_id), client.get("name", ""), 1, ""],
        value_input_option="RAW",
    )
    _invalidate_dg_raw_cache()
    return True


def get_daily_giveaway_participants(date_str: str) -> list:
    """Участники розыгрыша на дату:
    [{"row", "client_id", "tg_id", "name", "tickets", "winner"}]."""
    rows = _dg_raw_rows()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.DG_DATA_START_ROW:
            continue
        if len(row) < config.DG_TICKETS:
            continue
        if row[config.DG_DATE - 1].strip() != date_str:
            continue

        def cell(col, row=row):
            idx = col - 1
            return row[idx] if idx < len(row) else ""

        try:
            tickets = int((cell(config.DG_TICKETS) or "0").strip())
        except ValueError:
            tickets = 0
        out.append({
            "row": r,
            "client_id": cell(config.DG_CLIENT_ID).strip(),
            "tg_id": cell(config.DG_TG_ID).strip(),
            "name": cell(config.DG_NAME).strip(),
            "tickets": tickets,
            "winner": cell(config.DG_WINNER).strip(),
        })
    return out


def mark_daily_giveaway_winner(row_num: int):
    ws = _ws(config.SHEET_DAILY_GIVEAWAY)
    ws.update_cell(row_num, config.DG_WINNER, "Да")
    _invalidate_dg_raw_cache()


def get_daily_giveaway_winner(date_str: str) -> Optional[dict]:
    """Победитель уже подведённого сегодняшнего розыгрыша, если есть —
    для PAUSE App (виден ВСЕМ, не только победителю, пока не
    опубликовано следующее меню, см. is_giveaway_window_closed) и для
    админского экрана истории."""
    for p in get_daily_giveaway_participants(date_str):
        if p["winner"].strip().lower() == "да":
            return p
    return None


def pick_daily_giveaway_winner(date_str: str) -> Optional[dict]:
    """Ежедневный автоматический розыгрыш (см. pauseapp.
    run_daily_giveaway_draw, запускается по расписанию в
    config.GIVEAWAY_DRAW_TIME) — выбирает победителя СЛУЧАЙНО,
    РАВНОВЕРОЯТНО среди участников дня, по людям, а не по билетам
    (каждый участник уже ровно один раз в списке — см.
    auto_join_daily_giveaway, билеты в старом бот-смысле тут не при чём,
    по прямой просьбе "механику сделаем именно по именам"). Закрывает
    окно участия на сегодня в ЛЮБОМ случае (см. close_giveaway_window —
    заново откроется только следующей публикацией меню), даже если
    участников не было — иначе розыгрыш "висел" бы открытым до
    публикации, и случайный заказ посреди дня внезапно стал бы
    единственным участником и автоматическим победителем. Если
    участников нет — возвращает None, без начисления билета.

    ИДЕМПОТЕНТНА: если окно уже закрыто (розыгрыш на эту дату уже
    подводился — хоть этим же вызовом, хоть более ранним), ничего
    заново не выбирает и не начисляет второй билет — просто возвращает
    уже отмеченного победителя (см. get_daily_giveaway_winner), если он
    был. Без этой проверки повторный тик планировщика (например, при
    перезапуске процесса около полудня) выбрал бы ВТОРОГО победителя и
    выдал бы ВТОРОЙ билет за тот же день — поймано и исправлено ещё на
    этапе тестов."""
    if is_giveaway_window_closed():
        return get_daily_giveaway_winner(date_str)
    participants = get_daily_giveaway_participants(date_str)
    close_giveaway_window()
    if not participants:
        return None
    winner = random.choice(participants)
    mark_daily_giveaway_winner(winner["row"])
    grant_ticket(date_str, winner)
    return winner


def get_client_ticket_counts(date_str: str) -> dict:
    """client_id (строкой) -> суммарное количество сетов, заказанных в эту
    дату (без отменённых) — "билеты" в дневном розыгрыше "Пауза в
    подарок": несколько заказанных сетов = несколько билетов."""
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    counts = {}
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_COMMENT:
            continue
        if row[config.O_DATE - 1].strip() != date_str:
            continue
        comment = row[config.O_COMMENT - 1].strip()
        if is_canceled(comment):
            continue
        client_id = row[config.O_CLIENT_ID - 1].strip() if len(row) >= config.O_CLIENT_ID else ""
        if not client_id:
            continue
        qty_raw = row[config.O_QTY - 1].strip() if len(row) >= config.O_QTY else ""
        try:
            qty = int(qty_raw)
        except ValueError:
            qty = 0
        counts[client_id] = counts.get(client_id, 0) + qty
    return counts


# ---------------------------------------------------------------------------
# Билеты "Пауза в подарок" — приз победителя ежедневного розыгрыша (см.
# pick_daily_giveaway_winner выше): "оплатить один сет бесплатно" в
# следующий раз. Отдельный лист от SHEET_DAILY_GIVEAWAY — тот только про
# один день, билет же живёт сколько угодно дней, пока не потрачен (см.
# pauseapp.api_order_submit: config.PAYMENT_TICKET).
# ---------------------------------------------------------------------------

_CT_HEADER = ["date_won", "client_id", "tg_id", "name", "status", "date_used", "order_row"]


def grant_ticket(date_str: str, winner: dict):
    ws = _ws_or_create(config.SHEET_CLIENT_TICKETS, _CT_HEADER)
    ws.append_row([
        date_str, winner["client_id"], winner["tg_id"], winner["name"],
        config.TICKET_STATUS_AVAILABLE, "", "",
    ], value_input_option="RAW")


def get_client_tickets(tg_id) -> list:
    """[{"row","date_won","status","date_used"}, ...] одного клиента,
    новые сверху — для "Бонусы и промокоды" в PAUSE App."""
    ws = _ws_or_create(config.SHEET_CLIENT_TICKETS, _CT_HEADER)
    rows = ws.get_all_values()
    target = str(tg_id)
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.CT_DATA_START_ROW:
            continue
        if len(row) < config.CT_TG_ID:
            continue
        if row[config.CT_TG_ID - 1].strip() != target:
            continue
        out.append({
            "row": r,
            "date_won": row[config.CT_DATE_WON - 1].strip(),
            "status": row[config.CT_STATUS - 1].strip() if len(row) >= config.CT_STATUS else "",
            "date_used": row[config.CT_DATE_USED - 1].strip() if len(row) >= config.CT_DATE_USED else "",
        })
    out.sort(key=lambda t: _parse_ru_date_safe(t["date_won"]), reverse=True)
    return out


def has_available_ticket(tg_id) -> bool:
    return any(t["status"] == config.TICKET_STATUS_AVAILABLE for t in get_client_tickets(tg_id))


def use_ticket(tg_id, order_row=None) -> bool:
    """Списывает САМЫЙ СТАРЫЙ доступный билет клиента (по очереди) —
    True, если билет найден и списан, False — если доступных не было.
    Вызывающий код (pauseapp.api_order_submit) обязан проверить
    has_available_ticket ДО того, как предложить клиенту оплату билетом
    — это последняя подстраховка на гонку (два заказа билетом почти
    одновременно), а не основная проверка."""
    ws = _ws_or_create(config.SHEET_CLIENT_TICKETS, _CT_HEADER)
    rows = ws.get_all_values()
    target = str(tg_id)
    candidates = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.CT_DATA_START_ROW:
            continue
        if len(row) < config.CT_STATUS:
            continue
        if row[config.CT_TG_ID - 1].strip() != target:
            continue
        if row[config.CT_STATUS - 1].strip() != config.TICKET_STATUS_AVAILABLE:
            continue
        candidates.append((r, row[config.CT_DATE_WON - 1].strip()))
    if not candidates:
        return False
    candidates.sort(key=lambda c: _parse_ru_date_safe(c[1]))
    row_num = candidates[0][0]
    ws.update_cell(row_num, config.CT_STATUS, config.TICKET_STATUS_USED)
    ws.update_cell(row_num, config.CT_DATE_USED, today_date_str())
    if order_row:
        ws.update_cell(row_num, config.CT_ORDER_ROW, str(order_row))
    return True


def get_all_tickets() -> list:
    """Полная история билетов всех клиентов, новые сверху — для
    админ-экрана "Розыгрыш" в Операционном центре (кто выиграл, потратил
    билет или нет)."""
    ws = _ws_or_create(config.SHEET_CLIENT_TICKETS, _CT_HEADER)
    rows = ws.get_all_values()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.CT_DATA_START_ROW:
            continue
        if len(row) < config.CT_STATUS:
            continue
        out.append({
            "row": r,
            "date_won": row[config.CT_DATE_WON - 1].strip(),
            "client_id": row[config.CT_CLIENT_ID - 1].strip(),
            "tg_id": row[config.CT_TG_ID - 1].strip(),
            "name": row[config.CT_NAME - 1].strip(),
            "status": row[config.CT_STATUS - 1].strip(),
            "date_used": row[config.CT_DATE_USED - 1].strip() if len(row) >= config.CT_DATE_USED else "",
        })
    out.sort(key=lambda t: _parse_ru_date_safe(t["date_won"]), reverse=True)
    return out


# ---------------------------------------------------------------------------
# Уведомления PAUSE App — колокольчик в шапке Главной (см. config.
# SHEET_APP_NOTIFICATIONS). Первый источник — выигрыш в ежедневном
# розыгрыше "Пауза в подарок" (см. pauseapp.run_daily_giveaway_draw),
# дальше сюда же лягут объявления/обновления — формат уже на это рассчитан
# (поле "kind" для будущей иконки/фильтра, текст уже готовый, без шаблонов
# на фронте).
# ---------------------------------------------------------------------------

_AN_HEADER = ["tg_id", "created", "kind", "text", "read"]


def create_app_notification(tg_id, text: str, kind: str = ""):
    ws = _ws_or_create(config.SHEET_APP_NOTIFICATIONS, _AN_HEADER)
    ws.append_row([str(tg_id), _now().strftime("%d.%m.%Y %H:%M"), kind, text, ""], value_input_option="RAW")


def get_app_notifications(tg_id, limit: int = 30) -> list:
    ws = _ws_or_create(config.SHEET_APP_NOTIFICATIONS, _AN_HEADER)
    rows = ws.get_all_values()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.AN_DATA_START_ROW:
            continue
        if len(row) < config.AN_READ or row[config.AN_TG_ID - 1].strip() != str(tg_id):
            continue
        out.append({
            "row": r,
            "created": row[config.AN_CREATED - 1].strip(),
            "kind": row[config.AN_KIND - 1].strip(),
            "text": row[config.AN_TEXT - 1].strip(),
            "read": row[config.AN_READ - 1].strip().lower() == "да",
        })
    out.sort(key=lambda n: n["row"], reverse=True)  # новые сверху
    return out[:limit]


def count_unread_app_notifications(tg_id) -> int:
    ws = _ws_or_create(config.SHEET_APP_NOTIFICATIONS, _AN_HEADER)
    rows = ws.get_all_values()
    count = 0
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.AN_DATA_START_ROW:
            continue
        if len(row) < config.AN_READ or row[config.AN_TG_ID - 1].strip() != str(tg_id):
            continue
        if row[config.AN_READ - 1].strip().lower() != "да":
            count += 1
    return count


def mark_app_notifications_read(tg_id):
    ws = _ws_or_create(config.SHEET_APP_NOTIFICATIONS, _AN_HEADER)
    rows = ws.get_all_values()
    cells = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.AN_DATA_START_ROW:
            continue
        if len(row) < config.AN_READ or row[config.AN_TG_ID - 1].strip() != str(tg_id):
            continue
        if row[config.AN_READ - 1].strip().lower() != "да":
            cells.append(gspread.Cell(r, config.AN_READ, "Да"))
    if not cells:
        return
    ws.update_cells(cells, value_input_option="RAW")


# ---------------------------------------------------------------------------
# Операционный центр (PAUSE App, админ-раздел) — сводка/разбивки/список
# заказов за произвольный период. Один проход по "Заказы", строки-позиции
# (один сет заказа — одна запись), группировку по заказу делает вызывающий
# код (см. pauseapp.py: api_ops_summary/api_ops_orders) — та же идея, что
# и get_kitchen_line_items для одной даты, здесь то же самое, но на
# диапазон дат и с суммой/статусом оплаты вместо "piece"-строки для кухни.
# ---------------------------------------------------------------------------

_orders_raw_cache = {"rows": None, "ts": 0}
_ORDERS_RAW_CACHE_TTL = 20  # секунд


def _invalidate_orders_raw_cache():
    """Сбрасывает кэш сырых строк "Заказы" — вызывать сразу после ЛЮБОЙ
    записи в этот лист, после которой код в том же запросе ожидает
    немедленно увидеть свежие данные через _orders_raw_rows (сейчас —
    mark_debt_line_paid/mark_debt_lines_paid/unmark_debt_line_paid:
    карточка должника обновляется сразу после отметки оплаты, без этого
    сброса она бы до 20с показывала старое состояние)."""
    _orders_raw_cache["rows"] = None
    _orders_raw_cache["ts"] = 0


def _orders_raw_rows() -> list:
    """Сырые строки "Заказы" (ws.get_all_values()), с коротким (20с)
    кэшем — независимо от того, какой диапазон дат потом запрашивают.

    "Заказы" — лист, который только растёт (вся история заказов с начала
    работы бота), поэтому ЛЮБОЙ вызов get_orders_in_range — хоть за
    сегодня, хоть за 30 дней — читает его ЦЕЛИКОМ: диапазон дат только
    фильтрует уже прочитанные строки в Python, не уменьшает сам запрос к
    Sheets. Экран "Финансы" на один показ дёргает это чтение несколько
    раз (api_ops_summary и api_ops_orders параллельно, плюс админ часто
    переключает период Сегодня/7д/30д туда-обратно за несколько секунд) —
    без кэша это каждый раз новое чтение всего растущего листа, что на
    практике приближает к лимиту запросов Google Sheets API и ощущается
    как медленная, постоянно "подгружающаяся" Mini App, вплоть до
    server_error (воспроизведено и подтверждено). Кэш — по содержимому
    листа, а не по диапазону дат, поэтому переключение периода внутри
    TTL больше не означает новый поход в Sheets вообще."""
    now = time.time()
    if _orders_raw_cache["rows"] is not None and now - _orders_raw_cache["ts"] < _ORDERS_RAW_CACHE_TTL:
        return _orders_raw_cache["rows"]
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    _orders_raw_cache["rows"] = rows
    _orders_raw_cache["ts"] = now
    return rows


def get_orders_in_range(date_from: str, date_to: str) -> list:
    """Заказы (без отменённых) за период [date_from, date_to] включительно,
    обе границы — ДД.ММ.ГГГГ. Имя и сумма — тем же способом, что и
    get_kitchen_line_items/_row_amount, чтобы не считать дважды по-разному.

    Статус оплаты — по сырому значению столбца K (а не по формуле
    "ОПЛАЧЕНО"/"НЕ ОПЛАЧЕНО" столбца L, которая не различает "на
    проверке" от "ещё не прислал"): "Картой"/"Наличными" — админ уже
    подтвердил (оплачено); "На проверке" — ждёт подтверждения; всё
    остальное (пусто, "В долг") — не оплачено. Та же трёхходовая логика,
    что и в get_payments_for_date/pauseapp._payment_value.

    См. _orders_raw_rows() — сам лист читается не чаще раза в TTL,
    независимо от того, какой диапазон дат запрашивают."""
    try:
        d_from = dt.datetime.strptime(date_from, "%d.%m.%Y")
        d_to = dt.datetime.strptime(date_to, "%d.%m.%Y")
    except ValueError:
        return []

    rows = _orders_raw_rows()
    clients = _clients_index()
    prices = get_set_prices()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_PAY_METHOD:
            row = row + [""] * (config.O_PAY_METHOD - len(row))
        date_cell = row[config.O_DATE - 1].strip()
        try:
            d = dt.datetime.strptime(date_cell, "%d.%m.%Y")
        except ValueError:
            continue
        if not (d_from <= d <= d_to):
            continue
        comment = row[config.O_COMMENT - 1].strip()
        if is_canceled(comment):
            continue

        client_id = row[config.O_CLIENT_ID - 1].strip()
        name = (clients.get(client_id) or {}).get("name") or row[config.O_NAME - 1].strip() or client_id or "—"
        qty_raw = row[config.O_QTY - 1].strip()
        try:
            qty = int(qty_raw)
        except ValueError:
            qty = 0
        payment_raw = row[config.O_PAYMENT - 1].strip()
        if payment_raw in ("Картой", "Наличными"):
            pay_status = "paid"
        elif payment_raw == "На проверке" or _is_review_row(row):
            pay_status = "review"
        else:
            pay_status = "unpaid"

        out.append({
            "row": r,
            "date": date_cell,
            "zone": row[config.O_ZONE - 1].strip(),
            "point": row[config.O_POINT - 1].strip(),
            "client_id": client_id,
            "name": name,
            "set": row[config.O_SET - 1].strip(),
            "qty": qty,
            "garnish": row[config.O_GARNISH - 1].strip(),
            "payment_raw": payment_raw,
            "pay_status": pay_status,
            "sum": _row_amount(row, prices),
            "batch": row[config.O_ORDER_BATCH - 1].strip(),
        })
    return out


def get_delivery_overview(date_from: str, date_to: str) -> dict:
    """Доставки за период для экрана "Доставки" в Операционном центре:
    список заказов, у которых есть платная доставка (O_DELIVERY_FEE), и
    сводка — начислено / оплачено / ждёт подтверждения / в долге / не
    оплачено. Состояние доставки = состояние оплаты её строки-носителя
    (столбец K, см. append_orders_batch): "Картой"/"Наличными" — оплачена,
    "На проверке" — ждёт подтверждения, "В долг" — в долге, остальное —
    не оплачена. Отменённые заказы не считаются."""
    try:
        d_from = dt.datetime.strptime(date_from, "%d.%m.%Y")
        d_to = dt.datetime.strptime(date_to, "%d.%m.%Y")
    except ValueError:
        return {"items": [], "summary": {}}
    rows = _orders_raw_rows()
    clients = _clients_index()
    items = []
    summary = {"accrued": 0, "paid": 0, "review": 0, "debt": 0, "unpaid": 0, "count": 0}
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        fee = _row_delivery_fee(row)
        if not fee:
            continue
        date_cell = row[config.O_DATE - 1].strip() if len(row) >= config.O_DATE else ""
        try:
            d = dt.datetime.strptime(date_cell, "%d.%m.%Y")
        except ValueError:
            continue
        if not (d_from <= d <= d_to):
            continue
        comment = row[config.O_COMMENT - 1].strip() if len(row) >= config.O_COMMENT else ""
        if is_canceled(comment):
            continue
        pay = row[config.O_PAYMENT - 1].strip() if len(row) >= config.O_PAYMENT else ""
        if pay in ("Картой", "Наличными"):
            state = "paid"
        elif pay == "На проверке" or _is_review_row(row):
            state = "review"
        elif pay == "В долг":
            state = "debt"
        else:
            state = "unpaid"
        cid = row[config.O_CLIENT_ID - 1].strip() if len(row) >= config.O_CLIENT_ID else ""
        name = (clients.get(cid) or {}).get("name") or (row[config.O_NAME - 1].strip() if len(row) >= config.O_NAME else "") or cid or "—"
        summary["accrued"] += fee
        summary[state] += fee
        summary["count"] += 1
        items.append({
            "row": r, "date": date_cell, "client_id": cid, "name": name,
            "zone": row[config.O_ZONE - 1].strip() if len(row) >= config.O_ZONE else "",
            "point": row[config.O_POINT - 1].strip() if len(row) >= config.O_POINT else "",
            "fee": fee, "state": state, "payment": pay,
        })
    items.sort(key=lambda x: (dt.datetime.strptime(x["date"], "%d.%m.%Y"), x["row"]), reverse=True)
    return {"items": items, "summary": summary}


# ---------------------------------------------------------------------------
# Отчёты для кухни / курьера — те же формулы, что и в самой таблице,
# просто пересчитанные тут, чтобы бот мог прислать их сам
# ---------------------------------------------------------------------------

def get_kitchen_line_items(date_str: str) -> list:
    """Сырые строки заказов на дату (без отменённых), с уже посчитанным
    "piece" ("Nшт Сет (Гарнир)") — общий источник и для текстового
    /kitchen (build_kitchen_report), и для PDF-версии
    (pdf_report.build_kitchen_report_pdf), чтобы группировка по клиенту
    (несколько позиций одного клиента — в одну строку под одним именем)
    считалась ровно один раз и одинаково в обоих отчётах.

    Имя резолвим сами по ID клиента — не полагаемся на формулу в таблице
    (она может быть не протянута на новые строки)."""
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    clients = _clients_index()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_TELEGRAM:
            row = row + [""] * (config.O_TELEGRAM - len(row))
        if row[config.O_DATE - 1].strip() != date_str:
            continue
        client_id = row[config.O_CLIENT_ID - 1].strip()
        if not client_id:
            continue
        comment = row[config.O_COMMENT - 1].strip()
        if is_canceled(comment):
            continue
        name = (clients.get(client_id) or {}).get("name") or row[config.O_NAME - 1].strip() or client_id
        set_name = row[config.O_SET - 1].strip()
        qty = row[config.O_QTY - 1].strip() or "0"
        garnish = row[config.O_GARNISH - 1].strip()

        piece = f"{qty}шт {set_name}"
        if garnish and garnish != "без гарнира":
            piece += f" ({garnish})"

        out.append({
            "client_id": client_id,
            "name": name,
            "zone": row[config.O_ZONE - 1].strip(),
            "point": row[config.O_POINT - 1].strip(),
            "set": set_name,
            "qty": qty,
            "garnish": garnish,
            "comment": comment,
            "piece": piece,
        })
    return out


def build_kitchen_report(date_str: str) -> str:
    """Раньше разбивка по видам сетов ("N - Блюдо дня"/"N - Сет стандарт")
    была жёстко на два конкретных имени — третий сет считался бы в общий
    total, но не попадал в разбивку вовсе. Теперь строчки собираются по
    каталогу сетов ("Справочники", см. get_sets) — сет без единого заказа
    сегодня по-прежнему показывается с "0", как и раньше для двух старых
    сетов; сет, которого нет в каталоге (опечатка в "Заказы" или его
    убрали из каталога), но по нему всё же пришёл заказ — добавляется в
    конец, чтобы штуки не терялись молча. Тот же порядок и тот же принцип
    "показывать 0" использует и формула на листе "Кухня" (ячейка A7) —
    сверено построчно на реальных данных."""
    items = get_kitchen_line_items(date_str)
    lines_by_name = {}
    order_by_name = []
    comments = []
    total = 0
    counts_by_set = {}

    for item in items:
        try:
            q = int(item["qty"])
        except ValueError:
            q = 0
        total += q
        counts_by_set[item["set"]] = counts_by_set.get(item["set"], 0) + q

        name = item["name"]
        if name not in lines_by_name:
            lines_by_name[name] = []
            order_by_name.append(name)
        lines_by_name[name].append(item["piece"])

        if item["comment"]:
            comments.append(f"{name} - {item['comment']}")

    known_sets = get_sets()
    set_lines = [f"{counts_by_set.get(s, 0)} - {s}" for s in known_sets]
    for s in counts_by_set:
        if s not in known_sets:
            set_lines.append(f"{counts_by_set[s]} - {s}")

    out = ["ИНФОРМАЦИЯ ДЛЯ КУХНИ", "", f"{total} сетов"] + set_lines + [""]
    for name in order_by_name:
        out.append("○ " + name + " - " + " ".join(lines_by_name[name]))
    if comments:
        out.append("")
        out.append("Комментарии:")
        out.extend(comments)
    return "\n".join(out)


def build_courier_report(date_str: str) -> str:
    """Отчёт для курьера — только куда и к кому ехать (без суммы и способа
    оплаты). Раз в строке больше нет ничего, что различало бы несколько
    заказов одного человека за день, — показываем каждого клиента внутри
    направления не больше одного раза, даже если он заказывал несколько
    сетов за день."""
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    clients = _clients_index()
    by_zone = {}
    zone_order = []
    seen = set()  # (zone, client_id) — один человек в отчёте один раз

    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_TELEGRAM:
            row = row + [""] * (config.O_TELEGRAM - len(row))
        if row[config.O_DATE - 1].strip() != date_str:
            continue
        zone = row[config.O_ZONE - 1].strip()
        client_id = row[config.O_CLIENT_ID - 1].strip()
        if not zone or not client_id:
            continue
        comment = row[config.O_COMMENT - 1].strip() if len(row) >= config.O_COMMENT else ""
        if is_canceled(comment):
            continue

        key = (zone, client_id)
        if key in seen:
            continue
        seen.add(key)

        client = clients.get(client_id) or {}
        name = client.get("name") or row[config.O_NAME - 1].strip() or client_id
        point = row[config.O_POINT - 1].strip()
        contact = client.get("contact") or row[config.O_CONTACT - 1].strip() or "Неизвестно"
        telegram = client.get("telegram") or row[config.O_TELEGRAM - 1].strip()

        tg = f"@{telegram}" if telegram and not telegram.startswith("@") else (telegram or "—")
        line = f"○ {name} - {contact} / {tg} - {point}"

        if zone not in by_zone:
            by_zone[zone] = []
            zone_order.append(zone)
        by_zone[zone].append(line)

    out = []
    for zone in zone_order:
        out.append(zone)
        out.extend(by_zone[zone])
        out.append("")
    return "\n".join(out).strip()


def build_courier_distribution(date_str: str) -> dict:
    """Готовый для личной пересылки курьеру текст — не "куда ехать" (это
    уже есть в самом Mini App "Маршрут"), а "какие сеты кому грузить в
    машину": по каждой точке курьера — имена клиентов, у каждого набор
    сетов с гарниром (см. get_kitchen_line_items:"piece", тот же формат,
    что и в /kitchen, "Nшт Сет (Гарнир)"). Курьера у точки берём из
    get_route_for_date (столбец "Курьер" листа "Маршрут", см.
    ROUTE_COURIER_TG_ID) — если точка ещё назначена НЕСКОЛЬКИМ курьерам
    разом (новая точка по умолчанию ставится на всех, пока кто-то не
    сузит через Mini App), она попадёт в текст КАЖДОГО из них — так же,
    как они сейчас оба видят её в самом Mini App.

    Группировка внутри точки — по client_id (не по имени, в отличие от
    build_kitchen_report: там просто исторически не разводили тёзок, на
    кухне это не критично, а тут результат уходит конкретному человеку "к
    точным именам" — лучше не рисковать).

    Возвращает {courier_tg_id: {"name", "text", "points", "people"}} —
    только курьеры, у которых на эту дату есть хоть одна точка; "text" уже
    полностью готов для отправки как есть, без правки администратором."""
    items = get_kitchen_line_items(date_str)
    route = get_route_for_date(date_str)
    point_couriers = {p["point"]: p["courier_tg_ids"] for p in route}
    courier_names = {c["tg_id"]: c["name"] for c in get_couriers()}
    clients = _clients_index()

    # courier_tg_id -> точка -> client_id -> {"name","tg","pieces":[...]}
    by_courier = {}
    point_order = {}

    for item in items:
        point = item["point"]
        courier_ids = point_couriers.get(point, [])
        if not courier_ids:
            continue
        client_id = item["client_id"]
        client = clients.get(client_id) or {}
        telegram = client.get("telegram") or ""
        tg = (telegram if telegram.startswith("@") else f"@{telegram}") if telegram else ""

        for cid in courier_ids:
            points = by_courier.setdefault(cid, {})
            if point not in points:
                points[point] = {}
                point_order.setdefault(cid, []).append(point)
            person = points[point].setdefault(client_id, {"name": item["name"], "tg": tg, "pieces": []})
            person["pieces"].append(item["piece"])

    out = {}
    for cid, points in by_courier.items():
        lines = [f"📦 Распределение на {date_str}", ""]
        people_total = 0
        for point in point_order[cid]:
            lines.append(f"📍 {point}")
            for person in points[point].values():
                people_total += 1
                tg_part = f" ({person['tg']})" if person["tg"] else ""
                lines.append(f"• {person['name']}{tg_part} — {', '.join(person['pieces'])}")
            lines.append("")
        lines.append(f"Итого: {len(point_order[cid])} точек, {people_total} человек")
        out[cid] = {
            "name": courier_names.get(cid, cid),
            "text": "\n".join(lines).strip(),
            "points": len(point_order[cid]),
            "people": people_total,
        }
    return out


# ---------------------------------------------------------------------------
# Заказы на новую точку доставки — держим до подтверждения координатором,
# в лист «Заказы» (и, соответственно, в отчёты кухни/курьера) не попадают,
# пока админ не нажмёт «Подтвердить».
# ---------------------------------------------------------------------------

def create_pending_order(date_str: str, zone: str, point: str, client_id, client_name: str,
                          client_phone: str, cart: list, payment: str, comment: str,
                          screenshot: str = "") -> str:
    ws = _ws(config.SHEET_PENDING)
    pending_id = f"P{int(time.time() * 1000)}"
    row = [
        pending_id, date_str, zone, point, _id_value(client_id), client_name, client_phone,
        json.dumps(cart, ensure_ascii=False), payment, comment or "", screenshot or "",
        config.PENDING_STATUS_WAITING,
    ]
    ws.append_row(row, value_input_option="RAW")
    return pending_id


def get_pending_order(pending_id: str) -> Optional[dict]:
    ws = _ws(config.SHEET_PENDING)
    rows = ws.get_all_values()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.PENDING_DATA_START_ROW:
            continue
        if len(row) >= config.P_ID and row[config.P_ID - 1] == pending_id:
            def cell(col):
                idx = col - 1
                return row[idx] if idx < len(row) else ""
            cart_raw = cell(config.P_CART_JSON)
            try:
                cart = json.loads(cart_raw) if cart_raw else []
            except ValueError:
                cart = []
            return {
                "row": r,
                "id": cell(config.P_ID),
                "date": cell(config.P_DATE),
                "zone": cell(config.P_ZONE),
                "point": cell(config.P_POINT),
                "client_id": cell(config.P_CLIENT_ID),
                "client_name": cell(config.P_CLIENT_NAME),
                "client_phone": cell(config.P_CLIENT_PHONE),
                "cart": cart,
                "payment": cell(config.P_PAYMENT),
                "comment": cell(config.P_COMMENT),
                "screenshot": cell(config.P_SCREENSHOT),
                "status": cell(config.P_STATUS),
            }
    return None


def set_pending_status(row_num: int, status: str):
    ws = _ws(config.SHEET_PENDING)
    ws.update_cell(row_num, config.P_STATUS, status)


def get_client_pending_orders(client_id) -> list:
    """Заказы клиента на новую точку, ещё ждущие подтверждения координатором
    (в "Заказы" пока не попали) — источник для статуса "На рассмотрении" в
    "Мои заказы". Только со статусом "ожидает"."""
    ws = _ws(config.SHEET_PENDING)
    rows = ws.get_all_values()
    target = str(client_id)
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.PENDING_DATA_START_ROW:
            continue
        if len(row) < config.P_STATUS:
            continue
        if row[config.P_CLIENT_ID - 1].strip() != target:
            continue
        if row[config.P_STATUS - 1].strip() != config.PENDING_STATUS_WAITING:
            continue

        def cell(col, row=row):
            idx = col - 1
            return row[idx] if idx < len(row) else ""

        cart_raw = cell(config.P_CART_JSON)
        try:
            cart = json.loads(cart_raw) if cart_raw else []
        except ValueError:
            cart = []
        out.append({
            "row": r,
            "date": cell(config.P_DATE),
            "items": [{"set": i.get("set", ""), "qty": i.get("qty", "")} for i in cart],
            "payment": cell(config.P_PAYMENT),
            "screenshot": cell(config.P_SCREENSHOT),
        })
    return out[::-1]


# ---------------------------------------------------------------------------
# Курьерский маршрут (Telegram Mini App)
# ---------------------------------------------------------------------------

def get_delivery_points() -> list:
    """Справочник точек доставки — [{"name","address","lat","lon","priority","rate"}].
    Кэшируется на _CACHE_TTL секунд — на каждый показ экрана "Маршрут" этот
    справочник читается несколько раз (сам список точек + расчёт нового
    маршрута), а меняется он редко (админ правит руками raз в какое-то
    время) — незачем ходить в Sheets за одним и тем же на каждый чих. Если
    только что вписали координаты новой точке — появятся в течение минуты,
    не мгновенно."""
    now = time.time()
    if _cache["delivery_points"] is not None and now - _cache["delivery_points_ts"] < _CACHE_TTL:
        return _cache["delivery_points"]

    ws = _ws(config.SHEET_DELIVERY_POINTS)
    rows = ws.get_all_values()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.DP_DATA_START_ROW:
            continue
        if len(row) < config.DP_NAME or not row[config.DP_NAME - 1].strip():
            continue

        def cell(col, row=row):
            idx = col - 1
            return row[idx] if idx < len(row) else ""

        try:
            priority = float(cell(config.DP_PRIORITY) or 0)
        except ValueError:
            priority = 0
        try:
            rate = int(str(cell(config.DP_RATE)).replace(" ", "").replace(",", "") or 0)
        except ValueError:
            rate = 0
        out.append({
            "name": cell(config.DP_NAME).strip(),
            "address": cell(config.DP_ADDRESS).strip(),
            "lat": cell(config.DP_LAT).strip(),
            "lon": cell(config.DP_LON).strip(),
            "priority": priority,
            "rate": rate,
        })
    _cache["delivery_points"] = out
    _cache["delivery_points_ts"] = now
    return out


def _delivery_points_index() -> dict:
    return {p["name"]: p for p in get_delivery_points()}


def get_point_zones() -> dict:
    """Точка (по имени) -> район, с которым она чаще всего сохранена у
    клиентов — источник подсказки района, когда клиент выбирает уже
    существующую точку доставки на карте (см. pauseapp.py:
    api_delivery_points). Один и тот же адрес у разных клиентов почти
    всегда в одном районе, берём первого попавшегося."""
    out = {}
    for c in _load_clients():
        if c["point"] and c["zone"] and c["point"] not in out:
            out[c["point"]] = c["zone"]
    return out


def create_or_update_delivery_point(name: str, address: str, lat, lon):
    """Точка доставки с координатами — записывается автоматически, когда
    клиент выбирает НОВОЕ место на карте (поиск адреса или метка вручную,
    см. pauseapp.py: renderDeliveryMapPicker/api_order_submit/
    api_profile_edit). Раньше "Точки доставки" заполнял только админ
    руками (см. комментарий у config.SHEET_DELIVERY_POINTS) — здесь то
    же самое, просто автоматически в момент выбора. Приоритет/ставку
    курьеру не трогаем (столбцы E/F остаются пустыми) — это админские
    поля, дозаполнит сам при случае. Если точка с таким именем уже есть
    (например, её сохранил другой клиент раньше) — просто обновляем
    адрес/координаты, а не плодим вторую строку."""
    name_clean = (name or "").strip()
    if not name_clean:
        return
    ws = _ws(config.SHEET_DELIVERY_POINTS)
    rows = ws.get_all_values()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.DP_DATA_START_ROW:
            continue
        existing = row[config.DP_NAME - 1].strip() if len(row) >= config.DP_NAME else ""
        if existing == name_clean:
            # value_input_option="RAW" — свободный адрес с карты может
            # начинаться с чего угодно (та же ловушка, что и с "+998..." у
            # телефона, см. update_client_field); update_cell() у gspread
            # такого параметра вообще не принимает, он всегда жёстко шлёт
            # USER_ENTERED, поэтому здесь update_cells() одним вызовом.
            ws.update_cells([
                gspread.Cell(r, config.DP_ADDRESS, address),
                gspread.Cell(r, config.DP_LAT, lat),
                gspread.Cell(r, config.DP_LON, lon),
            ], value_input_option="RAW")
            _cache["delivery_points"] = None
            return
    ws.append_row([name_clean, address, lat, lon, "", ""], value_input_option="RAW")
    _cache["delivery_points"] = None


def get_couriers() -> list:
    """Все записи из "Курьеры" — [{"tg_id","name","status","phone",
    "kpi_hidden","is_route_admin","disabled"}]. "status" — свободная
    текстовая заметка админа (см. config.COURIER_STATUS), ни на что
    технически не влияет. "kpi_hidden" — скрыт ли показатель
    эффективности этого курьера с главного экрана KPI (см.
    set_courier_kpi_hidden/get_route_kpi) — сам курьер при этом
    продолжает учитываться в общем среднем. "is_route_admin" — назначен
    ли этот курьер администратором "Маршрута" (см.
    set_courier_route_admin/is_courier_route_admin, webapp._role_for) —
    назначать/снимать может только config.OWNER_TG_ID. "disabled" —
    полностью ли отключён доступ к Mini App (см. set_courier_disabled,
    is_courier) — включать/выключать может любой администратор
    "Маршрута". Кэшируется на _CACHE_TTL секунд — is_courier() дёргается
    на каждом показе главного меню бота, каждый раз ходить в Sheets
    незачем."""
    now = time.time()
    if _cache["couriers"] is not None and now - _cache["couriers_ts"] < _CACHE_TTL:
        return _cache["couriers"]

    ws = _ws(config.SHEET_COURIERS)
    rows = ws.get_all_values()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.COURIER_DATA_START_ROW:
            continue
        if len(row) < config.COURIER_TG_ID or not row[config.COURIER_TG_ID - 1].strip():
            continue
        out.append({
            "tg_id": row[config.COURIER_TG_ID - 1].strip(),
            "name": row[config.COURIER_NAME - 1].strip() if len(row) >= config.COURIER_NAME else "",
            "status": row[config.COURIER_STATUS - 1].strip() if len(row) >= config.COURIER_STATUS else "",
            "phone": row[config.COURIER_PHONE - 1].strip() if len(row) >= config.COURIER_PHONE else "",
            "kpi_hidden": (row[config.COURIER_KPI_HIDDEN - 1].strip().lower() == "да") if len(row) >= config.COURIER_KPI_HIDDEN else False,
            "is_route_admin": (row[config.COURIER_IS_ROUTE_ADMIN - 1].strip().lower() == "да") if len(row) >= config.COURIER_IS_ROUTE_ADMIN else False,
            "disabled": (row[config.COURIER_DISABLED - 1].strip().lower() == "да") if len(row) >= config.COURIER_DISABLED else False,
            "notify_off": (row[config.COURIER_NOTIFY_OFF - 1].strip().lower() == "да") if len(row) >= config.COURIER_NOTIFY_OFF else False,
        })
    _cache["couriers"] = out
    _cache["couriers_ts"] = now
    return out


def _ensure_sheet_columns(ws, col: int):
    """Расширяет лист до нужного числа столбцов, если нужно. Несколько
    листов этого проекта (например "Курьеры", "Расходы на логистику")
    изначально заводились на меньшее число столбцов, чем сейчас нужно
    коду — новые поля (kpi_hidden/is_route_admin/disabled у "Курьеры",
    from_cash у "Расходы на логистику") добавлялись только в код, не в
    реальную таблицу. Google Sheets API отклоняет запись ЗА пределами
    текущей сетки листа (gspread.exceptions.APIError на values.update,
    "exceeds grid limits") — именно это и ловилось при первом нажатии на
    переключатели "Курьеры" (воспроизведено и подтверждено на реальной
    таблице: тогда столбец D был последним). add_cols — дешёвая
    однократная операция, нужна только пока столбцов меньше требуемого."""
    if ws.col_count < col:
        ws.add_cols(col - ws.col_count)


def _set_courier_flag(tg_id: str, col: int, value: str) -> bool:
    """Общая часть set_courier_kpi_hidden/set_courier_route_admin/
    set_courier_disabled — находит строку курьера по tg_id и пишет
    значение в указанный столбец, расширяя лист при необходимости (см.
    _ensure_sheet_columns). Возвращает False, если такого курьера нет
    (не создаёт строку — курьер должен уже существовать)."""
    ws = _ws(config.SHEET_COURIERS)
    _ensure_sheet_columns(ws, col)
    rows = ws.get_all_values()
    target = str(tg_id).strip()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.COURIER_DATA_START_ROW:
            continue
        if len(row) >= config.COURIER_TG_ID and row[config.COURIER_TG_ID - 1].strip() == target:
            ws.update_cell(r, col, value)
            _cache["couriers"] = None
            return True
    return False


def set_courier_kpi_hidden(tg_id: str, hidden: bool) -> bool:
    """Скрывает/возвращает показатель эффективности курьера на главном
    экране KPI (см. "Центр управления" → "Курьеры" → карточка курьера →
    "Показать"/"Скрыть с главного экрана")."""
    return _set_courier_flag(tg_id, config.COURIER_KPI_HIDDEN, "Да" if hidden else "")


def set_courier_route_admin(tg_id: str, is_admin: bool) -> bool:
    """Назначает/снимает курьера администратором "Маршрута" (см.
    config.COURIER_IS_ROUTE_ADMIN) — вызывающий код (webapp.
    api_courier_route_admin_set) сам проверяет, что это делает
    config.OWNER_TG_ID, эта функция прав не проверяет."""
    return _set_courier_flag(tg_id, config.COURIER_IS_ROUTE_ADMIN, "Да" if is_admin else "")


def is_courier_route_admin(tg_id) -> bool:
    """True, если этот курьер назначен администратором "Маршрута" (см.
    set_courier_route_admin) И не отключён (см. set_courier_disabled) —
    используется в webapp._role_for. Отключённый курьер-администратор
    теряет права администратора вместе с обычным доступом — "доступ исчезает
    вообще", без исключения для админских прав."""
    target = str(tg_id)
    return any(c["tg_id"] == target and c["is_route_admin"] and not c["disabled"] for c in get_couriers())


def set_courier_disabled(tg_id: str, disabled: bool) -> bool:
    """Полностью включает/выключает доступ курьера к Mini App "Маршрут"
    (и кнопке в меню бота, см. is_courier) — строка в "Курьеры" остаётся
    (курьер не удалён, просто временно отключён). Доступно ЛЮБОМУ
    администратору "Маршрута", не только владельцу (в отличие от
    set_courier_route_admin)."""
    return _set_courier_flag(tg_id, config.COURIER_DISABLED, "Да" if disabled else "")


def set_courier_notify_off(tg_id: str, off: bool) -> bool:
    """Включает/выключает пуш о готовности маршрута (см. webapp.
    _notify_couriers_route_ready) для ОДНОГО курьера — сам доступ к
    Mini App при этом не трогается, в отличие от set_courier_disabled.
    Доступно ЛЮБОМУ администратору "Маршрута"."""
    return _set_courier_flag(tg_id, config.COURIER_NOTIFY_OFF, "Да" if off else "")


def add_courier(tg_id: str, name: str, phone: str = ""):
    """Добавляет курьера в "Курьеры" — тот же лист, который раньше
    приходилось заполнять руками (см. "Профиль" → "Центр управления" →
    "Курьеры" в Mini App "Маршрут"). Если строка с этим tg_id уже есть —
    обновляет на месте имя/телефон (не плодит дубликаты, позволяет
    поправить опечатку), иначе дописывает новую строку; "Статус" у новой
    строки остаётся пустым (тот же смысл, что и раньше — свободная
    заметка админа, которую можно вписать потом прямо в таблицу).

    _ensure_sheet_columns — та же защита, что уже стоит в
    _set_courier_flag (переключатели "Курьеры"): реальный лист мог быть
    заведён на меньшее число столбцов, чем сейчас нужно коду, и запись ЗА
    пределами текущей сетки Google Sheets отклоняет ошибкой ("exceeds
    grid limits") — это уже ловилось на переключателях и было
    воспроизведено на реальной таблице; add_courier писал тем же append_row
    без этой защиты, так что сама ДОБАВКА курьера могла падать той же
    ошибкой на более старых таблицах, прежде чем до переключателей вообще
    доходило дело.

    Для ДЕЙСТВИТЕЛЬНО нового курьера (не правка имени/телефона у уже
    существующего) — ещё и _backfill_courier_into_active_route: без неё
    курьер, добавленный уже ПОСЛЕ того, как точки на сегодня создались
    (см. sync_daily_route — новая точка при создании достаётся ВСЕМ, кто
    на тот момент уже в "Курьеры"), не попадал ни в одну из них и видел
    пустой маршрут даже при включённой видимости — воспроизведено и
    подтверждено."""
    ws = _ws(config.SHEET_COURIERS)
    _ensure_sheet_columns(ws, config.COURIER_PHONE)
    rows = ws.get_all_values()
    target = str(tg_id).strip()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.COURIER_DATA_START_ROW:
            continue
        if len(row) >= config.COURIER_TG_ID and row[config.COURIER_TG_ID - 1].strip() == target:
            ws.update_cells([
                gspread.Cell(r, config.COURIER_NAME, name),
                gspread.Cell(r, config.COURIER_PHONE, phone),
            ], value_input_option="RAW")
            _cache["couriers"] = None
            return
    row_values = [""] * config.COURIER_PHONE
    row_values[config.COURIER_TG_ID - 1] = target
    row_values[config.COURIER_NAME - 1] = name
    row_values[config.COURIER_PHONE - 1] = phone
    ws.append_row(row_values, value_input_option="RAW")
    _cache["couriers"] = None
    _backfill_courier_into_active_route(target)


def _backfill_courier_into_active_route(tg_id: str):
    """Добавляет tg_id в столбец "Курьер" (C) каждой ещё НЕ сданной и НЕ
    убранной точки сегодняшнего маршрута, где его ещё нет — see
    add_courier выше за объяснением, зачем. Намеренно не трогает:
    - ROUTE_STATUS_DELIVERED — иначе курьер задним числом получил бы
      чужую доставку в заработок (см. get_courier_earnings — считает по
      courier_tg_ids сданной точки);
    - ROUTE_STATUS_REMOVED — точка явно убрана админом с маршрута.
    Только дата get_active_menu_date() — то, что сейчас видит курьер в
    Mini App по умолчанию; более поздние уже синхронизированные даты (если
    админ успел открыть "завтра" заранее) не трогает — на новый день
    sync_daily_route и так включит всех текущих курьеров автоматически."""
    date_str = get_active_menu_date()
    ws = _ws(config.SHEET_ROUTE)
    rows = ws.get_all_values()
    cells = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_STATUS:
            continue
        if row[config.ROUTE_DATE - 1].strip() != date_str:
            continue
        status = row[config.ROUTE_STATUS - 1].strip()
        if status in (config.ROUTE_STATUS_REMOVED, config.ROUTE_STATUS_DELIVERED):
            continue
        raw_ids = row[config.ROUTE_COURIER_TG_ID - 1] if len(row) >= config.ROUTE_COURIER_TG_ID else ""
        current_ids = _parse_courier_ids(raw_ids)
        if tg_id in current_ids:
            continue
        current_ids.append(tg_id)
        cells.append(gspread.Cell(r, config.ROUTE_COURIER_TG_ID, ",".join(current_ids)))
    if cells:
        ws.update_cells(cells, value_input_option="RAW")
        _invalidate_route_cache(date_str)


def is_courier(tg_id) -> bool:
    """Доступ к Mini App/меню курьера — по факту наличия строки с этим
    Telegram ID в "Курьеры" И отсутствию отметки "отключён" (см.
    config.COURIER_DISABLED/set_courier_disabled) — без проверки текста в
    "Статус" (раньше сверялись с точным текстом "Активен" — ненадёжно:
    опечатка или другой регистр в ячейке молча оставляли курьера без
    доступа без понятной причины). Убрать курьера НАВСЕГДА — значит
    удалить его строку целиком; временно — отключить через
    set_courier_disabled, не трогая строку."""
    target = str(tg_id)
    return any(c["tg_id"] == target and not c["disabled"] for c in get_couriers())


_DLV_COMMENT_HEADER = ["Дата заказа", "Время записи", "ID клиента", "Имя", "Телефон", "Telegram", "Точка", "Комментарий к доставке"]
_dlv_comments_cache = {"data": None, "ts": 0}


def add_delivery_comment(date_str: str, client: dict, point: str, text: str):
    """Комментарий клиента к ДОСТАВКЕ (для водителя) — отдельный лист
    "Комментарии к доставке": дата заказа, когда написал, кто (ID/имя/
    телефон/Telegram), точка, текст. Показывается курьеру в "Маршруте"
    рядом с человеком (см. get_route_people)."""
    text = (text or "").strip()
    if not text:
        return
    ws = _ws_or_create(config.SHEET_DELIVERY_COMMENTS, _DLV_COMMENT_HEADER)
    now = _now()
    tg = (client.get("telegram") or "").strip().lstrip("@")
    ws.append_row([
        date_str, now.strftime("%d.%m.%Y %H:%M"), str(client.get("id", "")), client.get("name", ""),
        client.get("contact", ""), ("@" + tg) if tg else "", point, text,
    ], value_input_option="RAW")
    _dlv_comments_cache["data"] = None
    _invalidate_route_cache(date_str)


def get_delivery_comments_for_date(date_str: str) -> dict:
    """{client_id: "комментарий; комментарий"} за дату заказа (кэш 30 с)."""
    now = time.time()
    if _dlv_comments_cache["data"] is None or now - _dlv_comments_cache["ts"] > 30:
        ws = _ws_or_create(config.SHEET_DELIVERY_COMMENTS, _DLV_COMMENT_HEADER)
        by = {}
        for i, row in enumerate(ws.get_all_values()):
            if i == 0 or len(row) < 8:
                continue
            by.setdefault(row[0].strip(), {}).setdefault(row[2].strip(), []).append(row[7].strip())
        _dlv_comments_cache["data"] = by
        _dlv_comments_cache["ts"] = now
    return {cid: " · ".join(t for t in texts if t) for cid, texts in _dlv_comments_cache["data"].get(date_str, {}).items()}


def get_route_people(date_str: str) -> dict:
    """Люди с реальными (неотменёнными) заказами на дату, сгруппированные по
    точке доставки, затем по клиенту — {точка: [{"client_id","name",
    "contact","telegram","items":[{"set","qty"}],"sum"}]}.
    "sum" — сумма столбца "Сумма" (J, формула цена×количество) по ВСЕМ
    строкам этого клиента за дату, для карточки точки в Mini App "Маршрут"
    (см. app.js: buildCard) и как сумма по умолчанию при отметке
    "Наличные" (см. record_cash_collection).

    Столбец "Комментарии" (O_COMMENT) читаем ТОЛЬКО чтобы отсеять
    отменённые заказы (is_canceled) — в сам словарь больше не кладём: это
    комментарий клиента для кухни (например конкретный адрес/подъезд или
    просьба к блюду), курьерам видеть его не нужно и раньше не было
    задумано — по прямой просьбе убрано после того, как комментарий на
    одну из точек ("Uzcard Office") оказался виден курьеру."""
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    clients = _clients_index()
    by_point = {}

    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_TELEGRAM:
            row = row + [""] * (config.O_TELEGRAM - len(row))
        if row[config.O_DATE - 1].strip() != date_str:
            continue
        point = row[config.O_POINT - 1].strip()
        client_id = row[config.O_CLIENT_ID - 1].strip()
        if not point or not client_id:
            continue
        comment = row[config.O_COMMENT - 1].strip() if len(row) >= config.O_COMMENT else ""
        if is_canceled(comment):
            continue

        client = clients.get(client_id) or {}
        name = client.get("name") or row[config.O_NAME - 1].strip() or client_id
        contact = client.get("contact") or row[config.O_CONTACT - 1].strip() or "Неизвестно"
        telegram = client.get("telegram") or row[config.O_TELEGRAM - 1].strip()

        people = by_point.setdefault(point, {})
        person = people.setdefault(client_id, {
            "client_id": client_id, "name": name, "contact": contact,
            "telegram": telegram, "items": [], "sum": 0,
        })
        person["items"].append({
            "set": row[config.O_SET - 1].strip(),
            "qty": row[config.O_QTY - 1].strip() or "0",
        })
        try:
            person["sum"] += int(float(row[config.O_SUM - 1].strip() or 0))
        except ValueError:
            pass

    try:
        dlv = get_delivery_comments_for_date(date_str)
    except Exception:
        dlv = {}
    for people in by_point.values():
        for cid, person in people.items():
            if dlv.get(cid):
                person["delivery_comment"] = dlv[cid]
    return {point: list(people.values()) for point, people in by_point.items()}


def sync_daily_route(date_str: str, people: dict = None) -> list:
    """Гарантирует, что для каждой точки с реальным заказом на дату есть
    строка в "Маршрут" — не трогает уже существующие строки (порядок,
    статус, курьера, комментарий), только добавляет недостающие.
    Идемпотентно, безопасно вызывать при каждом открытии экрана —
    актуальность не кэшируется. Возвращает актуальные сырые строки листа
    "Маршрут" (с учётом только что дозаписанных, если были) — раньше
    get_route_for_date читал тот же лист ЕЩЁ РАЗ сразу после этого вызова,
    и вдобавок пересчитывал get_route_people(date_str) заново, из-за чего
    один показ экрана "Маршрут" утраивал число обращений к Google Sheets
    API (читали "Заказы"/"Маршрут" по два раза за запрос) — при нескольких
    открытиях подряд (или просто у нескольких людей одновременно) это
    реально упиралось в лимит 429 "Quota exceeded" и выглядело как
    нестабильность экрана (открывается через раз). Поэтому и "Заказы"
    (через параметр people), и "Маршрут" читаются теперь ровно один раз на
    вызов get_route_for_date.

    Новая точка ставится в маршрут с "Порядок" = текущий максимальный
    "Порядок" среди уже существующих на эту дату точек + 10 за каждую
    новую — то есть в КОНЕЦ уже выстроенного на сегодня списка. Раньше
    здесь напрямую использовался "Приоритет" из каталога "Точки
    доставки" — из-за этого новая точка (по факту нового заказа) могла
    воткнуться в середину или начало уже вручную перестроенного
    администратором на сегодня порядка, а не в конец, как ожидалось.
    Если новых точек несколько за один вызов (например, самая первая
    синхронизация за день, когда в "Маршрут" ещё вообще нет строк) —
    относительный порядок МЕЖДУ НИМИ по-прежнему берётся из каталожного
    "Приоритета", чтобы не оказаться в случайном порядке.

    Новая точка сразу назначается ВСЕМ активным курьерам (полный список
    из "Курьеры", через set_route_courier/ROUTE_COURIER_TG_ID) — раньше
    доставалась только первому по списку, и чтобы её увидел кто-то ещё,
    админу приходилось вручную включать видимость через переключатель
    курьера. Отдельного курьера при необходимости по-прежнему можно снять
    той же кнопкой на карточке.

    Точка, которую убрали из маршрута через Mini App (см.
    remove_route_point — помечается статусом ROUTE_STATUS_REMOVED, а не
    удаляется), не попадает в "недостающие": её строка на эту дату уже
    существует, поэтому она не создаётся заново, даже если по ней всё ещё
    есть настоящий заказ. Без этого — старое поведение — любая точка с
    активным заказом "воскресала" на следующей же загрузке, и удаление
    выглядело так, будто оно не работает."""
    if people is None:
        people = get_route_people(date_str)
    points_with_orders = set(people.keys())

    ws = _ws(config.SHEET_ROUTE)
    rows = ws.get_all_values()
    if not points_with_orders:
        return rows

    existing = set()
    max_order = 0.0
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_POINT:
            continue
        if row[config.ROUTE_DATE - 1].strip() != date_str:
            continue
        existing.add(row[config.ROUTE_POINT - 1].strip())
        if len(row) >= config.ROUTE_ORDER:
            try:
                max_order = max(max_order, float(row[config.ROUTE_ORDER - 1] or 0))
            except ValueError:
                pass

    missing = points_with_orders - existing
    if not missing:
        return rows

    dp_index = _delivery_points_index()
    couriers = get_couriers()
    all_courier_ids = ",".join(c["tg_id"] for c in couriers)

    missing_sorted = sorted(missing, key=lambda p: dp_index.get(p, {}).get("priority", 0))
    new_rows = []
    for point in missing_sorted:
        max_order += 10
        new_rows.append([date_str, point, all_courier_ids, max_order, config.ROUTE_STATUS_WAITING, ""])
    ws.append_rows(new_rows, value_input_option="RAW")
    # Строки для дальнейшей обработки в ЭТОМ же вызове нужны в виде текста
    # (как их вернул бы повторный ws.get_all_values()) — иначе код ниже,
    # который делает cell(...).strip() по каждой ячейке, упадёт на числовом
    # "Приоритет". Сама запись в таблицу (new_rows выше) при этом уходит с
    # настоящими типами как и раньше — на хранимые данные это не влияет.
    rows = rows + [[str(v) for v in new_row] for new_row in new_rows]
    return rows


def _parse_courier_ids(raw: str) -> list:
    """Столбец "Курьер" (C, ROUTE_COURIER_TG_ID) может держать сразу
    несколько Telegram ID через запятую — точку можно назначить нескольким
    курьерам одновременно (см. set_route_courier). Пустые элементы (лишние
    пробелы/запятые) отбрасываются."""
    return [x.strip() for x in (raw or "").split(",") if x.strip()]


def get_route_for_date(date_str: str) -> list:
    """Полный маршрут на дату — точки с людьми, координатами, ставкой,
    статусом, отсортирован по "Порядок" (= "Приоритет" из каталога для
    только что подставленных точек, если админ не перетаскивал вручную).
    Сначала синхронизирует новые точки (см. sync_daily_route) — данные
    всегда актуальны на момент вызова. Точки со статусом ROUTE_STATUS_REMOVED
    (см. remove_route_point) в выдачу не попадают — они "убраны" из
    маршрута на этот день, но строка остаётся в таблице, чтобы
    sync_daily_route не восстановил их заново.

    В выдачу попадают ТОЛЬКО точки, у которых на эту дату есть хотя бы один
    реальный (неотменённый) заказ (см. get_route_people) — раньше это не
    проверялось вовсе: строка в "Маршрут" один раз создавалась при первом
    заказе и оставалась видна навсегда, даже если этот заказ потом
    отменили/удалили или тестовые данные поменялись — так на экране
    накапливались "пустые" точки без единого человека. Оборотная сторона:
    точка, добавленная вручную через "+ Добавить точку" (см. add_route_point)
    и ещё не набравшая ни одного заказа, тоже не будет видна, пока
    заказ по ней не появится.

    Результат кэшируется на _ROUTE_CACHE_TTL секунд (см. комментарий у
    _route_cache выше) — несколько повторных открытий экрана подряд без
    единой правки между ними отдаются из кэша, а не тремя новыми чтениями
    Sheets каждое. Любое мутирующее действие (add/remove/reorder/comment/
    mark_delivered) сбрасывает кэш на эту дату немедленно."""
    cached = _route_cache.get(date_str)
    if cached is not None and time.time() - cached[1] < _ROUTE_CACHE_TTL:
        return cached[0]

    people = get_route_people(date_str)
    rows = sync_daily_route(date_str, people=people)
    dp_index = _delivery_points_index()

    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_POINT:
            continue
        if row[config.ROUTE_DATE - 1].strip() != date_str:
            continue

        def cell(col, row=row):
            idx = col - 1
            return row[idx] if idx < len(row) else ""

        status = cell(config.ROUTE_STATUS).strip() or config.ROUTE_STATUS_WAITING
        if status == config.ROUTE_STATUS_REMOVED:
            continue

        point_name = cell(config.ROUTE_POINT).strip()
        if not people.get(point_name):
            continue

        dp = dp_index.get(point_name, {})
        try:
            order_num = float(cell(config.ROUTE_ORDER) or 0)
        except ValueError:
            order_num = 0

        out.append({
            "row": r,
            "point": point_name,
            "address": dp.get("address", ""),
            "lat": dp.get("lat", ""),
            "lon": dp.get("lon", ""),
            "rate": dp.get("rate", 0),
            "courier_tg_ids": _parse_courier_ids(cell(config.ROUTE_COURIER_TG_ID)),
            "order": order_num,
            "status": status,
            "delivered_at": cell(config.ROUTE_DELIVERED_AT).strip(),
            "courier_comment": cell(config.ROUTE_COURIER_COMMENT).strip(),
            "pinned": cell(config.ROUTE_PINNED).strip().lower() == "да",
            "people": people.get(point_name, []),
        })

    out.sort(key=lambda p: p["order"])
    _route_cache[date_str] = (out, time.time())
    return out


def _order_dates_with_data() -> set:
    """Множество дат (текстом, как в столбце A), на которые в "Заказы" есть
    хотя бы одна строка — независимо от статуса/отмены. Кэшируется на
    _ROUTE_CACHE_TTL секунд по той же причине, что и _route_cache выше: это
    ещё одно полное чтение листа "Заказы" на каждое открытие экрана
    "Маршрут" (сверх того, что уже читает get_route_for_date для самой
    даты) — без короткого кэша "Маршрут" и "Заказы" читались бы по два
    раза каждый на один показ экрана, и мы вернулись бы к той же самой
    нестабильности, которую только что убрали."""
    now = time.time()
    if _cache["order_dates"] is not None and now - _cache["order_dates_ts"] < _ROUTE_CACHE_TTL:
        return _cache["order_dates"]
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    dates = set()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_DATE:
            continue
        d = row[config.O_DATE - 1].strip()
        if d:
            dates.add(d)
    _cache["order_dates"] = dates
    _cache["order_dates_ts"] = now
    return dates


# Насколько далеко вперёд от сегодня искать даты с реальными заказами для
# переключателя дат — небольшое разумное окно, а не бесконечный поиск.
ROUTE_DATES_LOOKAHEAD_DAYS = 14


def get_route_available_dates() -> list:
    """Даты, доступные для выбора на экране "Маршрут" в Mini App —
    сегодня и 2 предыдущих календарных дня (хронологически, старые
    первыми в результате) показываются всегда, даже без единого заказа —
    это рабочее окно "последних дней", которое курьер/админ должен видеть
    в любом случае, и именно оно должно быть видно первым, без прокрутки
    (см. webapp_static/app.js: renderDatePicker — докручивает ленту дат
    над картой до начала этого окна при первом открытии).

    Дальше — любая БУДУЩАЯ дата, на которую в "Заказы" реально есть хотя
    бы одна строка (в пределах ROUTE_DATES_LOOKAHEAD_DAYS вперёд) —
    НЕЗАВИСИМО от того, опубликовано ли на неё меню через /admin
    (get_active_menu_date). Раньше "завтра" появлялось в переключателе
    только если оно совпадало с активной опубликованной датой меню — это
    правильно для самого заказа клиентом (там дата решает, на какой день
    идёт приём), но для Mini App курьера это лишняя, ошибочная
    зависимость: если запись в "Заказы" на будущую дату уже есть (неважно,
    через бота или вручную) — точка по ней должна быть видна в маршруте
    сразу, а не только после того, как админ формально опубликует меню на
    эту дату.

    И ещё — вообще ЛЮБАЯ ПРОШЕДШАЯ дата, на которую в "Заказы" есть хотя
    бы одна строка, без ограничения "сколько дней назад" — по прямой
    просьбе открыть доступ ко всей истории маршрутов, не только
    последним трём дням (раньше история глубже этого окна была вообще
    недостижима ни в ленте дат над картой, ни в "Видимости маршрутов")."""
    today = _now().date()
    base = {(today - dt.timedelta(days=n)).strftime("%d.%m.%Y") for n in (2, 1, 0)}

    order_dates = _order_dates_with_data()
    future_cutoff = today + dt.timedelta(days=ROUTE_DATES_LOOKAHEAD_DAYS)

    def _parse(d):
        try:
            return dt.datetime.strptime(d, "%d.%m.%Y").date()
        except ValueError:
            return None

    all_dates = set(base)
    for d in order_dates:
        parsed = _parse(d)
        if parsed is None:
            continue
        # Прошлое — целиком, без ограничения; будущее — только в пределах
        # окна lookahead (иначе один заказ, вручную вписанный на дальнюю
        # будущую дату, растянул бы список на месяцы вперёд).
        if parsed <= today or parsed <= future_cutoff:
            all_dates.add(d)

    return sorted(all_dates, key=lambda d: dt.datetime.strptime(d, "%d.%m.%Y"))


def _route_visibility_map() -> dict:
    """{дата: видимо ли курьеру} по листу "Видимость маршрута". Дата без
    строки в этом листе считается НЕ видимой (по умолчанию курьер не видит
    маршрут, пока админ явно не включит — см. config.SHEET_ROUTE_VISIBILITY).
    Кэшируется на _ROUTE_CACHE_TTL секунд по той же причине, что и
    остальные лёгкие кэши в этом файле — читается на каждое открытие
    экрана "Заказы"."""
    now = time.time()
    if _cache["route_visibility"] is not None and now - _cache["route_visibility_ts"] < _ROUTE_CACHE_TTL:
        return _cache["route_visibility"]
    ws = _ws(config.SHEET_ROUTE_VISIBILITY)
    rows = ws.get_all_values()
    mapping = {}
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.RV_DATA_START_ROW:
            continue
        if len(row) < config.RV_DATE:
            continue
        d = row[config.RV_DATE - 1].strip()
        if not d:
            continue
        visible_cell = row[config.RV_VISIBLE - 1].strip() if len(row) >= config.RV_VISIBLE else ""
        mapping[d] = visible_cell.lower() == "да"
    _cache["route_visibility"] = mapping
    _cache["route_visibility_ts"] = now
    return mapping


def is_route_visible_to_courier(date_str: str) -> bool:
    return _route_visibility_map().get(date_str, False)


def set_route_visibility(date_str: str, visible: bool):
    """Включает/выключает видимость маршрута на дату для курьера. Строка
    на эту дату заводится при первом переключении, дальше просто
    обновляется — по одной строке на дату."""
    ws = _ws(config.SHEET_ROUTE_VISIBILITY)
    rows = ws.get_all_values()
    value = "Да" if visible else ""
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.RV_DATA_START_ROW:
            continue
        if len(row) < config.RV_DATE:
            continue
        if row[config.RV_DATE - 1].strip() == date_str:
            ws.update_cell(r, config.RV_VISIBLE, value)
            _cache["route_visibility"] = None
            return
    ws.append_row([date_str, value], value_input_option="RAW")
    _cache["route_visibility"] = None


def get_route_visibility_status() -> list:
    """[{"date","visible"}] по всем датам, доступным в переключателе (см.
    get_route_available_dates — включает всю историю, не только последние
    три дня) — для экрана "Профиль" админа → "Центр управления" →
    "Видимость маршрутов", где он включает/выключает видимость по каждой
    дате отдельно. Порядок — НОВЫЕ СВЕРХУ (в отличие от
    get_route_available_dates, которая отдаёт хронологически старые→новые
    для ленты дат над картой): в вертикальном списке с поиском по дате
    удобнее видеть сегодняшний и недавние дни первыми, не прокручивая
    через всю историю."""
    visibility = _route_visibility_map()
    dates = list(reversed(get_route_available_dates()))
    return [{"date": d, "visible": visibility.get(d, False)} for d in dates]


# ---------------------------------------------------------------------------
# KPI доставки — "Старт" (информационная метка) + эффективность относительно
# дедлайна сдачи заказов (см. "Профиль" → "Центр управления" → KPI).
# ---------------------------------------------------------------------------

_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):[0-5]\d$")


def get_delivery_deadline() -> str:
    """"ЧЧ:ММ" — дедлайн сдачи заказов, после которого считается опоздание
    (см. config.ROUTE_KPI_PENALTY_PER_MINUTE). Хранится в "Справочники"
    (см. config.REF_DELIVERY_DEADLINE_CELL); пустая/битая ячейка —
    действует config.ROUTE_DEFAULT_DELIVERY_DEADLINE."""
    ws = _ws(config.SHEET_REFERENCE)
    raw = (ws.acell(config.REF_DELIVERY_DEADLINE_CELL).value or "").strip()
    return raw if _TIME_RE.match(raw) else config.ROUTE_DEFAULT_DELIVERY_DEADLINE


def set_delivery_deadline(time_str: str) -> bool:
    """Возвращает False, если time_str не похож на "ЧЧ:ММ" — ничего не
    пишет в этом случае."""
    time_str = (time_str or "").strip()
    if not _TIME_RE.match(time_str):
        return False
    ws = _ws(config.SHEET_REFERENCE)
    ws.update_acell(config.REF_DELIVERY_DEADLINE_CELL, time_str)
    return True


def record_route_start(date_str: str, courier_tg_id):
    """Время первого за день нажатия "Поехали" у курьера — пишет СТРОГО
    один раз: повторные нажатия (на других точках того же дня) уже
    записанное время не трогают. Чисто информационная метка (видна и
    курьеру, и админу, как и время "Сдал") — в расчёт эффективности (см.
    get_route_kpi) не входит."""
    ws = _ws_or_create(config.SHEET_ROUTE_START, ["date", "courier_tg_id", "time"])
    rows = ws.get_all_values()
    target = str(courier_tg_id)
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.RS_DATA_START_ROW:
            continue
        if len(row) < config.RS_COURIER_TG_ID:
            continue
        if row[config.RS_DATE - 1].strip() == date_str and row[config.RS_COURIER_TG_ID - 1].strip() == target:
            return
    ws.append_row([date_str, target, _now().strftime("%H:%M")], value_input_option="RAW")


def get_route_starts(date_str: str) -> dict:
    """{courier_tg_id: "ЧЧ:ММ"} — время старта каждого курьера на дату
    (см. record_route_start)."""
    ws = _ws_or_create(config.SHEET_ROUTE_START, ["date", "courier_tg_id", "time"])
    rows = ws.get_all_values()
    out = {}
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.RS_DATA_START_ROW:
            continue
        if len(row) < config.RS_TIME:
            continue
        if row[config.RS_DATE - 1].strip() != date_str:
            continue
        out[row[config.RS_COURIER_TG_ID - 1].strip()] = row[config.RS_TIME - 1].strip()
    return out


def compute_kpi_score(delivered_at: str, deadline: str) -> float:
    """Процент эффективности ОДНОЙ сданной точки/дня относительно
    дедлайна (оба — "ЧЧ:ММ", в пределах одного дня) — 100%, если сдано до
    дедлайна включительно; иначе минус config.ROUTE_KPI_PENALTY_PER_MINUTE
    за каждую ПОЛНУЮ минуту опоздания (секунды не учитываются — время
    "Сдано" и так хранится без них, см. mark_route_delivered), не ниже 0.
    Например: дедлайн 12:30, сдано в 12:45 (15 минут опоздания) —
    15 × 0.6 = 9%, то есть 91%."""
    try:
        delivered = dt.datetime.strptime(delivered_at, "%H:%M")
        dl = dt.datetime.strptime(deadline, "%H:%M")
    except ValueError:
        return 100.0
    late_minutes = (delivered - dl).total_seconds() / 60
    if late_minutes <= 0:
        return 100.0
    return max(0.0, 100.0 - late_minutes * config.ROUTE_KPI_PENALTY_PER_MINUTE)


def get_route_kpi(date_from: str, date_to: str) -> dict:
    """KPI доставки за период [date_from, date_to] (оба "ДД.ММ.ГГГГ",
    включительно) — один проход по "Маршрут":

    1. Для каждого (курьер, дата) в диапазоне берём время ПОСЛЕДНЕЙ
       сданной им в этот день точки (точка, назначенная нескольким
       курьерам сразу, засчитывается каждому — та же логика, что у
       get_courier_earnings) и считаем её % через compute_kpi_score.
    2. У каждого курьера — среднее по всем дням периода, где у него была
       хоть одна сдача (дни без сдач не портят и не улучшают среднее).
    3. Общий показатель — среднее ПО КУРЬЕРАМ (не по дням): каждый
       курьер, у которого есть хоть один день с данными, даёт ровно одно
       значение в общее среднее, скрытые из интерфейса (kpi_hidden)
       курьеры в нём тоже участвуют — по прямой просьбе.

    Возвращает {"deadline", "overall", "avg_delivery_time", "couriers":
    [{"tg_id","name","score","hidden","days_count"}, ...]} — couriers
    отсортирован по убыванию score, без данных — в конце.
    avg_delivery_time ("ЧЧ:ММ" или None) — среднее время последней сдачи
    по ТОМУ ЖЕ датасету, что и overall (last_delivered ниже, по всем
    курьерам и дням периода) — для всплывающего окна при нажатии на
    главный кружок KPI в Профиле (см. app.js: renderKpiBody)."""
    deadline = get_delivery_deadline()
    rows = _route_kpi_raw_rows()

    try:
        d1 = dt.datetime.strptime(date_from, "%d.%m.%Y").date()
        d2 = dt.datetime.strptime(date_to, "%d.%m.%Y").date()
    except ValueError:
        d1 = d2 = None

    last_delivered = {}  # (courier_tg_id, date_str) -> "ЧЧ:ММ" последней сдачи
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_DELIVERED_AT:
            continue
        if row[config.ROUTE_STATUS - 1].strip() != config.ROUTE_STATUS_DELIVERED:
            continue
        date_str = row[config.ROUTE_DATE - 1].strip()
        try:
            d = dt.datetime.strptime(date_str, "%d.%m.%Y").date()
        except ValueError:
            continue
        if d1 and not (d1 <= d <= d2):
            continue
        delivered_at = row[config.ROUTE_DELIVERED_AT - 1].strip()
        if not delivered_at:
            continue
        for cid in _parse_courier_ids(row[config.ROUTE_COURIER_TG_ID - 1]):
            key = (cid, date_str)
            cur = last_delivered.get(key)
            if cur is None or delivered_at > cur:
                last_delivered[key] = delivered_at

    scores_by_courier = {}  # courier_tg_id -> {date_str: score}
    for (cid, date_str), delivered_at in last_delivered.items():
        score = compute_kpi_score(delivered_at, deadline)
        scores_by_courier.setdefault(cid, {})[date_str] = score

    out_couriers = []
    period_scores = []
    for c in get_couriers():
        day_scores = scores_by_courier.get(c["tg_id"], {})
        score = round(sum(day_scores.values()) / len(day_scores), 1) if day_scores else None
        out_couriers.append({
            "tg_id": c["tg_id"],
            "name": c["name"],
            "hidden": c["kpi_hidden"],
            "score": score,
            "days_count": len(day_scores),
        })
        if score is not None:
            period_scores.append(score)

    overall = round(sum(period_scores) / len(period_scores), 1) if period_scores else None
    out_couriers.sort(key=lambda c: (c["score"] is None, -(c["score"] or 0)))

    avg_delivery_time = None
    if last_delivered:
        total_minutes = 0
        count = 0
        for delivered_at in last_delivered.values():
            try:
                t = dt.datetime.strptime(delivered_at, "%H:%M")
            except ValueError:
                continue
            total_minutes += t.hour * 60 + t.minute
            count += 1
        if count:
            avg_min = round(total_minutes / count)
            avg_delivery_time = "%02d:%02d" % (avg_min // 60, avg_min % 60)

    return {
        "deadline": deadline, "overall": overall, "avg_delivery_time": avg_delivery_time,
        "couriers": out_couriers,
    }


def reorder_route(date_str: str, order_map: dict):
    """order_map: {точка: новый порядок (число)} — сохраняет сразу в
    столбец "Порядок" листа "Маршрут"."""
    ws = _ws(config.SHEET_ROUTE)
    rows = ws.get_all_values()
    cells = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_POINT:
            continue
        if row[config.ROUTE_DATE - 1].strip() != date_str:
            continue
        point = row[config.ROUTE_POINT - 1].strip()
        if point in order_map:
            cells.append(gspread.Cell(r, config.ROUTE_ORDER, order_map[point]))
    if cells:
        ws.update_cells(cells)
    _invalidate_route_cache(date_str)


def set_route_pinned(date_str: str, point_name: str, pinned: bool):
    """Закрепляет/открепляет точку на её текущей позиции в "Маршрут"
    (столбец H, ROUTE_PINNED) — только админ, через кнопку "📌 Закрепить"
    на карточке. Закреплённая точка не двигается ни перетаскиванием (см.
    app.js: Sortable filter + пересборка order в onReorder), ни
    автодобавлением новых точек (sync_daily_route/add_route_point всегда
    дописывают В КОНЕЦ, не трогая существующие строки, так что для
    закрепления там ничего специально проверять не нужно — оно и так
    не меняет "Порядок" у уже существующих точек). На остальные действия
    с точкой (разворачивание, комментарий, "Поехали"/"Сдано", курьеры) не
    влияет вовсе — это только про столбец "Порядок" и возможность
    перетащить карточку."""
    ws = _ws(config.SHEET_ROUTE)
    rows = ws.get_all_values()
    value = "Да" if pinned else ""
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_POINT:
            continue
        if row[config.ROUTE_DATE - 1].strip() == date_str and row[config.ROUTE_POINT - 1].strip() == point_name:
            ws.update_cell(r, config.ROUTE_PINNED, value)
            _invalidate_route_cache(date_str)
            return


def add_route_point(date_str: str, point_name: str):
    """Добавляет точку в маршрут вручную (админ) — для точек без реального
    заказа на эту дату (точки с заказом и так появляются сами через
    sync_daily_route). Если точку раньше убрали через Mini App (строка
    существует со статусом ROUTE_STATUS_REMOVED) — просто возвращает её
    обратно, а не создаёт вторую строку на ту же дату."""
    ws = _ws(config.SHEET_ROUTE)
    rows = ws.get_all_values()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_POINT:
            continue
        if row[config.ROUTE_DATE - 1].strip() != date_str or row[config.ROUTE_POINT - 1].strip() != point_name:
            continue
        status = row[config.ROUTE_STATUS - 1].strip() if len(row) >= config.ROUTE_STATUS else ""
        if status == config.ROUTE_STATUS_REMOVED:
            ws.update_cell(r, config.ROUTE_STATUS, config.ROUTE_STATUS_WAITING)
            _invalidate_route_cache(date_str)
        return

    existing = get_route_for_date(date_str)  # заодно синхронизирует
    couriers = get_couriers()
    all_courier_ids = ",".join(c["tg_id"] for c in couriers)
    # В конец текущего списка (см. sync_daily_route) — не по каталожному
    # "Приоритету", чтобы не воткнуться в середину уже расставленного на
    # сегодня порядка.
    max_order = max([p["order"] for p in existing], default=0)
    ws.append_row(
        [date_str, point_name, all_courier_ids, max_order + 10, config.ROUTE_STATUS_WAITING, ""],
        value_input_option="RAW",
    )
    _invalidate_route_cache(date_str)


def remove_route_point(date_str: str, point_name: str):
    """Убирает точку из маршрута на этот день. Не удаляет строку физически
    — помечает статусом ROUTE_STATUS_REMOVED (см. get_route_for_date,
    которая такие строки не показывает) — потому что физическое удаление
    строки, пока по точке ещё есть настоящий заказ, приводило к тому, что
    sync_daily_route создавала её заново на следующей же загрузке, и
    удаление выглядело так, будто оно не работает."""
    ws = _ws(config.SHEET_ROUTE)
    rows = ws.get_all_values()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_POINT:
            continue
        if row[config.ROUTE_DATE - 1].strip() == date_str and row[config.ROUTE_POINT - 1].strip() == point_name:
            ws.update_cell(r, config.ROUTE_STATUS, config.ROUTE_STATUS_REMOVED)
            _invalidate_route_cache(date_str)
            return


def set_route_courier(date_str: str, point_name: str, courier_tg_ids: list):
    """Переназначает точку набору курьеров на конкретный день (столбец C
    "Маршрут", тот же ROUTE_COURIER_TG_ID, что читает get_route_for_date,
    разбирается через _parse_courier_ids) — точку можно закрепить сразу за
    несколькими курьерами: каждый видит её у себя как обычную, а "Сдано"
    от любого одного из них закрывает точку сразу для всех (общий статус
    в этой же строке). courier_tg_ids — полный итоговый список ID
    (не добавление/удаление одного, а замена целиком) — пустой список
    снимает назначение вовсе.

    Нужно, когда активных курьеров больше одного — по умолчанию новая
    точка достаётся первому курьеру по списку в "Курьеры" (см.
    sync_daily_route), а не распределяется сама; админ переносит вручную
    через Mini App."""
    ws = _ws(config.SHEET_ROUTE)
    rows = ws.get_all_values()
    value = ",".join(str(x).strip() for x in courier_tg_ids if str(x).strip())
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_POINT:
            continue
        if row[config.ROUTE_DATE - 1].strip() == date_str and row[config.ROUTE_POINT - 1].strip() == point_name:
            # update_cell() по умолчанию пишет с value_input_option=USER_ENTERED
            # (как если бы это вводил человек) — для одного ID (просто число)
            # это было безобидно, но "7118369020,7851970384" Google Sheets
            # то же самое USER_ENTERED пытается распарсить как ЧИСЛО (запятая —
            # разделитель разрядов), получая 20-значное число, которое не
            # влезает в точность double, и в ячейке остаётся исковерканный
            # набор цифр — воспроизведено и подтверждено на реальной таблице.
            # update_cells() с явным RAW пишет буквальный текст без такой
            # переинтерпретации.
            ws.update_cells([gspread.Cell(r, config.ROUTE_COURIER_TG_ID, value)], value_input_option="RAW")
            _invalidate_route_cache(date_str)
            return


def set_route_courier_comment(date_str: str, point_name: str, comment: str):
    """Сохраняет "Комментарий для курьера" для точки на конкретный день
    (столбец G "Маршрут") — привязан к паре (дата, точка), поэтому не
    переносится сам собой на следующий день."""
    ws = _ws(config.SHEET_ROUTE)
    rows = ws.get_all_values()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_POINT:
            continue
        if row[config.ROUTE_DATE - 1].strip() == date_str and row[config.ROUTE_POINT - 1].strip() == point_name:
            ws.update_cell(r, config.ROUTE_COURIER_COMMENT, comment)
            _invalidate_route_cache(date_str)
            return


def mark_route_delivered(date_str: str, point_name: str):
    ws = _ws(config.SHEET_ROUTE)
    rows = ws.get_all_values()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_POINT:
            continue
        if row[config.ROUTE_DATE - 1].strip() == date_str and row[config.ROUTE_POINT - 1].strip() == point_name:
            ws.update_cells([
                gspread.Cell(r, config.ROUTE_STATUS, config.ROUTE_STATUS_DELIVERED),
                gspread.Cell(r, config.ROUTE_DELIVERED_AT, _now().strftime("%H:%M")),
            ])
            _invalidate_route_cache(date_str)
            return


def get_courier_earnings(courier_tg_id, date_str: str) -> int:
    """Сумма ставок всех сданных ("Сдано") точек курьера за дату. Точка,
    назначенная нескольким курьерам сразу, засчитывается КАЖДОМУ из них
    полной ставкой (не делится) — так и было для одного курьера, менять
    это при добавлении множественного назначения не просили."""
    route = get_route_for_date(date_str)
    target = str(courier_tg_id)
    return sum(
        p["rate"] for p in route
        if target in p["courier_tg_ids"] and p["status"] == config.ROUTE_STATUS_DELIVERED
    )


def get_courier_earnings_month(courier_tg_id, year: int, month: int) -> int:
    """Сумма ставок всех сданных точек курьера за календарный месяц."""
    ws = _ws(config.SHEET_ROUTE)
    rows = ws.get_all_values()
    dp_index = _delivery_points_index()
    target = str(courier_tg_id)
    total = 0
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_STATUS:
            continue
        try:
            d = dt.datetime.strptime(row[config.ROUTE_DATE - 1].strip(), "%d.%m.%Y").date()
        except ValueError:
            continue
        if d.year != year or d.month != month:
            continue
        if target not in _parse_courier_ids(row[config.ROUTE_COURIER_TG_ID - 1]):
            continue
        if row[config.ROUTE_STATUS - 1].strip() != config.ROUTE_STATUS_DELIVERED:
            continue
        point = row[config.ROUTE_POINT - 1].strip()
        total += dp_index.get(point, {}).get("rate", 0)
    return total


# ---------------------------------------------------------------------------
# Наличные и расчёты с курьером (Mini App "Маршрут", кнопка "Наличные" на
# карточке точки + карточка курьера в "Центр управления" → "Курьеры").
#
# Три независимых листа:
#   - SHEET_CASH_COLLECTIONS — кто из курьеров, у какого клиента и сколько
#     собрал наличными (видно только админу, см. get_cash_entries).
#   - SHEET_LOGISTICS_EXPENSES (уже существует выше, "Оплата за смену") —
#     "Заработок"/"Доход курьера": сколько админ начислил курьеру за день.
#     Используется ТА ЖЕ запись/поле, что и в "Расходы на логистику" — по
#     прямой просьбе это полностью независимо от расчёта по ставкам
#     (get_courier_earnings выше), который эту карточку не трогает.
#   - SHEET_COURIER_SETTLEMENTS — события, уменьшающие "Наличные у
#     курьера": явное "Забрал наличные" (кнопка с выбором дней) и "Оплата
#     из наличных" (когда "Заработок" оплачен из уже собранных курьером
#     денег, а не отдельно — см. pay_courier_shift).
#
# "Наличные у курьера" / "Общая сумма у курьера" — ПО ДНЯМ, не единый
# накопительный баланс (как было раньше): get_courier_cash_for_day — сколько
# собрано/осталось ЗА ОДИН конкретный день; get_courier_cash_balance_as_of —
# нарастающий остаток "по состоянию на" этот день включительно (сумма всех
# сборов минус все списания с датой не позже него). "Доплатил курьеру" как
# отдельное действие убрано — теперь выбор "оплатить из наличных или
# отдельно" делается прямо при вводе "Заработка" (см. pay_courier_shift).
# ---------------------------------------------------------------------------

_CASH_HEADER = ["date", "courier_tg_id", "courier_name", "point", "client_id", "name", "contact", "telegram", "amount", "time"]
_SETL_HEADER = ["date", "courier_tg_id", "courier_name", "type", "amount", "time"]
_SETL_WITHDRAW_TYPES = (config.SETTLEMENT_TYPE_CASH_RECEIVED, config.SETTLEMENT_TYPE_PAID_FROM_CASH)

# Короткий кэш сырых строк каждого из трёх листов (та же идея и тот же
# TTL, что и у _orders_raw_rows выше, по той же причине: один показ
# кассы курьера — это get_courier_cash_for_day + get_logistics_total_
# for_courier + get_courier_cash_balance_as_of ОДНИМ запросом
# (api_courier_cash_summary), а это 5 отдельных проходов по трём
# листам БЕЗ кэша — на карточку курьера плюс пара кликов по датам это
# быстро превращалось в десятки чтений за несколько секунд и упиралось
# в квоту Google Sheets API (server_error) — воспроизведено и
# подтверждено. Кэш — по содержимому листа целиком, не по
# courier_tg_id/датам, поэтому переключение дня/курьера внутри TTL не
# означает новый поход в Sheets.
_cash_raw_cache = {"rows": None, "ts": 0}
_logistics_raw_cache = {"rows": None, "ts": 0}
_settlement_raw_cache = {"rows": None, "ts": 0}
_CASH_RAW_CACHE_TTL = 15  # секунд


def _invalidate_cash_raw_cache():
    _cash_raw_cache["rows"] = None
    _cash_raw_cache["ts"] = 0


def _invalidate_logistics_raw_cache():
    _logistics_raw_cache["rows"] = None
    _logistics_raw_cache["ts"] = 0


def _invalidate_settlement_raw_cache():
    _settlement_raw_cache["rows"] = None
    _settlement_raw_cache["ts"] = 0


def _cash_raw_rows() -> list:
    now = time.time()
    if _cash_raw_cache["rows"] is not None and now - _cash_raw_cache["ts"] < _CASH_RAW_CACHE_TTL:
        return _cash_raw_cache["rows"]
    rows = _ws_or_create(config.SHEET_CASH_COLLECTIONS, _CASH_HEADER).get_all_values()
    _cash_raw_cache["rows"] = rows
    _cash_raw_cache["ts"] = now
    return rows


def _logistics_raw_rows() -> list:
    now = time.time()
    if _logistics_raw_cache["rows"] is not None and now - _logistics_raw_cache["ts"] < _CASH_RAW_CACHE_TTL:
        return _logistics_raw_cache["rows"]
    rows = _ws_or_create(config.SHEET_LOGISTICS_EXPENSES, _LOG_HEADER).get_all_values()
    _logistics_raw_cache["rows"] = rows
    _logistics_raw_cache["ts"] = now
    return rows


def _settlement_raw_rows() -> list:
    now = time.time()
    if _settlement_raw_cache["rows"] is not None and now - _settlement_raw_cache["ts"] < _CASH_RAW_CACHE_TTL:
        return _settlement_raw_cache["rows"]
    rows = _ws_or_create(config.SHEET_COURIER_SETTLEMENTS, _SETL_HEADER).get_all_values()
    _settlement_raw_cache["rows"] = rows
    _settlement_raw_cache["ts"] = now
    return rows


def _date_bounds(date_from, date_to):
    """Парсит независимые (каждая необязательна) границы периода в
    datetime — None, None значит "без ограничений". Возвращает None,
    если переданная строка не парсится (вызывающий код тогда должен
    прекратить итерацию — см. использование ниже)."""
    d_from = d_to = None
    if date_from:
        d_from = dt.datetime.strptime(date_from, "%d.%m.%Y")
    if date_to:
        d_to = dt.datetime.strptime(date_to, "%d.%m.%Y")
    return d_from, d_to


def _in_bounds(date_str, d_from, d_to):
    if d_from is None and d_to is None:
        return True
    try:
        d = dt.datetime.strptime(date_str, "%d.%m.%Y")
    except ValueError:
        return False
    if d_from is not None and d < d_from:
        return False
    if d_to is not None and d > d_to:
        return False
    return True


def _iter_cash_rows(courier_tg_id=None, date_from: str = None, date_to: str = None):
    """Сырые строки "Наличные", отфильтрованные по курьеру и/или периоду.
    Все параметры необязательны и независимы: без них — все строки, с
    одним только date_to — "по состоянию на дату" (см.
    get_courier_cash_balance_as_of), с date_from==date_to — один день."""
    rows = _cash_raw_rows()
    target = str(courier_tg_id) if courier_tg_id is not None else None
    try:
        d_from, d_to = _date_bounds(date_from, date_to)
    except ValueError:
        return
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.CASH_DATA_START_ROW:
            continue
        if len(row) < config.CASH_TIME:
            continue
        if target is not None and row[config.CASH_COURIER_TG_ID - 1].strip() != target:
            continue
        if not _in_bounds(row[config.CASH_DATE - 1].strip(), d_from, d_to):
            continue
        yield row


def record_cash_collection(date_str: str, courier_tg_id, courier_name: str, point: str,
                            client_id, name: str, contact: str, telegram: str, amount: int):
    """Курьер отметил "Наличные" у конкретного человека на точке — пишет
    строку в кассу (SHEET_CASH_COLLECTIONS) и синхронизирует статус оплаты
    в "Заказы": все ещё не оплаченные строки этого клиента на этой точке
    за дату становятся "Наличными" (та же механика, что и ручное
    подтверждение админом, см. confirm_cash_payment), а в комментарий (M)
    дописывается заглавными буквами "ПОДТВЕРЖДЕНО КУРЬЕРОМ <имя>" — по
    прямой просьбе, чтобы это было видно прямо в таблице. Строка, бывшая
    долгом ("В долг"), дополнительно получает config.DEBT_PAID_MARKER —
    иначе она пропала бы из текущего долга (оплата сменилась), но не была
    бы видна как ПОГАШЕННЫЙ долг в истории клиента (см. is_debt_paid_marked)."""
    ws = _ws_or_create(config.SHEET_CASH_COLLECTIONS, _CASH_HEADER)
    now = _now()
    ws.append_row([
        date_str, str(courier_tg_id), courier_name or "", point, str(client_id),
        name or "", contact or "", telegram or "", str(int(amount)), now.strftime("%H:%M"),
    ], value_input_option="RAW")

    marker = (config.CASH_CONFIRMED_MARKER_PREFIX + " " + (courier_name or "")).strip().upper()
    ows = _ws(config.SHEET_ORDERS)
    rows = ows.get_all_values()
    cells = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_CLIENT_ID:
            continue
        if row[config.O_DATE - 1].strip() != date_str:
            continue
        if row[config.O_POINT - 1].strip() != point:
            continue
        if row[config.O_CLIENT_ID - 1].strip() != str(client_id):
            continue
        payment = row[config.O_PAYMENT - 1].strip() if len(row) >= config.O_PAYMENT else ""
        if payment in ("Картой", "Наличными"):
            continue  # уже оплачено — не трогаем
        # Строки из PAUSE App (способ в AE) — это "ждёт подтверждения", а не
        # настоящий долг: не помечаем их как "долг погашен".
        was_debt = payment == "В долг" and not _row_pay_method(row)
        cur_comment = row[config.O_COMMENT - 1].strip() if len(row) >= config.O_COMMENT else ""
        cells.append(gspread.Cell(r, config.O_PAYMENT, "Наличными"))
        new_comment = cur_comment
        if marker not in new_comment:
            new_comment = f"{new_comment} | {marker}" if new_comment else marker
        if was_debt and not is_debt_paid_marked(new_comment):
            new_comment = f"{new_comment} | {config.DEBT_PAID_MARKER}" if new_comment else config.DEBT_PAID_MARKER
        if new_comment != cur_comment:
            cells.append(gspread.Cell(r, config.O_COMMENT, new_comment))
    if cells:
        ows.update_cells(cells, value_input_option="RAW")
    _invalidate_orders_raw_cache()
    _invalidate_cash_raw_cache()


def get_cash_total(courier_tg_id, date_from: str = None, date_to: str = None) -> int:
    """Сумма наличных, собранных курьером (за период, либо за всё время,
    если date_from/date_to не переданы) — для "Мои доходы" (курьер) и
    карточки курьера в "Курьеры" (админ)."""
    total = 0
    for row in _iter_cash_rows(courier_tg_id, date_from, date_to):
        try:
            total += int(row[config.CASH_AMOUNT - 1].strip() or 0)
        except ValueError:
            pass
    return total


def get_cash_entries(courier_tg_id, date_from: str, date_to: str) -> list:
    """Подробный список сборов наличных курьера за период — ТОЛЬКО для
    админа (карточка курьера в "Курьеры"): кто из клиентов, когда, сколько
    и на какой точке дал наличные, с контактами — по прямой просьбе курьер
    этого списка не видит, только свою сумму (см. get_cash_total)."""
    out = []
    for row in _iter_cash_rows(courier_tg_id, date_from, date_to):
        try:
            amount = int(row[config.CASH_AMOUNT - 1].strip() or 0)
        except ValueError:
            amount = 0
        out.append({
            "date": row[config.CASH_DATE - 1].strip(),
            "time": row[config.CASH_TIME - 1].strip(),
            "point": row[config.CASH_POINT - 1].strip(),
            "client_id": row[config.CASH_CLIENT_ID - 1].strip(),
            "name": row[config.CASH_NAME - 1].strip(),
            "contact": row[config.CASH_CONTACT - 1].strip(),
            "telegram": row[config.CASH_TELEGRAM - 1].strip(),
            "amount": amount,
        })
    out.sort(key=lambda e: (e["date"], e["time"]), reverse=True)
    return out


def get_route_cash_totals(date_str: str) -> dict:
    """{точка: сумма наличных, собранных на ней за дату} — для синего
    бейджа "Наличные" на карточке точки (см. app.js: buildCard,
    api_route_get: "cash")."""
    totals = {}
    for row in _iter_cash_rows(None, date_str, date_str):
        point = row[config.CASH_POINT - 1].strip()
        try:
            amount = int(row[config.CASH_AMOUNT - 1].strip() or 0)
        except ValueError:
            amount = 0
        totals[point] = totals.get(point, 0) + amount
    return totals


def _iter_logistics_rows(courier_tg_id=None, date_from: str = None, date_to: str = None):
    """Как _iter_cash_rows, но по SHEET_LOGISTICS_EXPENSES ("Заработок" /
    "Оплата за смену") — см. get_logistics_total_for_courier."""
    rows = _logistics_raw_rows()
    target = str(courier_tg_id) if courier_tg_id is not None else None
    try:
        d_from, d_to = _date_bounds(date_from, date_to)
    except ValueError:
        return
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.LOG_DATA_START_ROW:
            continue
        if len(row) < config.LOG_SHIFT_PAY:
            continue
        if target is not None and row[config.LOG_COURIER_TG_ID - 1].strip() != target:
            continue
        if not _in_bounds(row[config.LOG_DATE - 1].strip(), d_from, d_to):
            continue
        yield row


def get_logistics_total_for_courier(courier_tg_id, date_from: str = None, date_to: str = None) -> int:
    """Сумма "Заработок" (= "Оплата за смену", см. set_logistics_expense —
    то же поле, что и в "Расходы на логистику") курьера за период, либо
    за всё время без date_from/date_to."""
    total = 0
    for row in _iter_logistics_rows(courier_tg_id, date_from, date_to):
        try:
            total += int(row[config.LOG_SHIFT_PAY - 1].strip() or 0)
        except ValueError:
            pass
    return total


def get_courier_earnings_by_day(courier_tg_id) -> list:
    """[{"date","amount","from_cash"}, ...] — "Заработок"/"Оплата за
    смену" курьера по дням, новые сверху — для истории по нажатию на
    "Доход курьера" (см. webapp.api_courier_earnings_by_day)."""
    out = []
    for row in _iter_logistics_rows(courier_tg_id):
        try:
            amount = int(row[config.LOG_SHIFT_PAY - 1].strip() or 0)
        except ValueError:
            amount = 0
        from_cash = len(row) >= config.LOG_FROM_CASH and row[config.LOG_FROM_CASH - 1].strip().lower() == "да"
        out.append({"date": row[config.LOG_DATE - 1].strip(), "amount": amount, "from_cash": from_cash})
    out.sort(key=lambda e: _parse_ru_date_safe(e["date"]), reverse=True)
    return out


def _parse_ru_date_safe(date_str):
    try:
        return dt.datetime.strptime(date_str, "%d.%m.%Y")
    except ValueError:
        return dt.datetime.min


def _iter_settlement_rows(courier_tg_id=None, date_from: str = None, date_to: str = None):
    """Как _iter_cash_rows, но по SHEET_COURIER_SETTLEMENTS ("Забрал
    наличные"/"Оплата из наличных")."""
    rows = _settlement_raw_rows()
    target = str(courier_tg_id) if courier_tg_id is not None else None
    try:
        d_from, d_to = _date_bounds(date_from, date_to)
    except ValueError:
        return
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.SETL_DATA_START_ROW:
            continue
        if len(row) < config.SETL_TIME:
            continue
        if target is not None and row[config.SETL_COURIER_TG_ID - 1].strip() != target:
            continue
        if not _in_bounds(row[config.SETL_DATE - 1].strip(), d_from, d_to):
            continue
        yield row


def record_courier_settlement(courier_tg_id, courier_name: str, settlement_type: str, amount: int, date_str: str = None):
    """Пишет строку в "Расчёты с курьерами" — date_str это ДЕНЬ, С
    КОТОРОГО списываются наличные (не обязательно сегодня — см.
    комментарий в начале раздела), по умолчанию сегодняшний. Время
    (SETL_TIME) — когда реально сделана запись, для справки, всегда
    "сейчас"."""
    ws = _ws_or_create(config.SHEET_COURIER_SETTLEMENTS, _SETL_HEADER)
    now = _now()
    ws.append_row([
        date_str or today_date_str(), str(courier_tg_id), courier_name or "", settlement_type,
        str(int(amount)), now.strftime("%H:%M"),
    ], value_input_option="RAW")
    _invalidate_settlement_raw_cache()


def _withdrawn_total(courier_tg_id, date_from: str = None, date_to: str = None) -> int:
    total = 0
    for row in _iter_settlement_rows(courier_tg_id, date_from, date_to):
        if row[config.SETL_TYPE - 1].strip() not in _SETL_WITHDRAW_TYPES:
            continue
        try:
            total += int(row[config.SETL_AMOUNT - 1].strip() or 0)
        except ValueError:
            pass
    return total


def get_courier_cash_for_day(courier_tg_id, date_str: str) -> int:
    """"Наличные у курьера" ЗА ОДИН конкретный день — собрано в этот день
    минус списано (SETTLEMENT_TYPE_CASH_RECEIVED/PAID_FROM_CASH) с датой
    ровно этого дня. Может быть отрицательным (списали больше, чем в тот
    конкретный день собрали — например, если забрали сразу остаток за
    несколько дней одной отметкой на один день)."""
    collected = get_cash_total(courier_tg_id, date_str, date_str)
    withdrawn = _withdrawn_total(courier_tg_id, date_str, date_str)
    return collected - withdrawn


def get_courier_cash_balance_as_of(courier_tg_id, date_str: str = None) -> int:
    """"Общая сумма у курьера" — остаток наличных на руках нарастающим
    итогом по состоянию на КОНЕЦ date_str включительно (все сборы и
    списания с датой не позже него) — без date_str это сегодняшний,
    "актуальный прямо сейчас" остаток (используется для проверки при
    оплате "из наличных", см. pay_courier_shift)."""
    date_str = date_str or today_date_str()
    collected = get_cash_total(courier_tg_id, None, date_str)
    withdrawn = _withdrawn_total(courier_tg_id, None, date_str)
    return collected - withdrawn


def get_courier_cash_by_day(courier_tg_id) -> list:
    """[{"date","collected","withdrawn","remaining"}, ...] — по всем
    дням, где у курьера было хоть какое-то движение (сбор или списание),
    новые сверху — для истории по нажатию на "Наличные у курьера"/
    "Общая сумма у курьера" и для выбора дней в "Забрать наличные" (см.
    webapp.api_courier_cash_by_day/api_courier_withdraw_cash)."""
    collected_by_day = {}
    for row in _iter_cash_rows(courier_tg_id):
        date_str = row[config.CASH_DATE - 1].strip()
        try:
            amount = int(row[config.CASH_AMOUNT - 1].strip() or 0)
        except ValueError:
            amount = 0
        collected_by_day[date_str] = collected_by_day.get(date_str, 0) + amount

    withdrawn_by_day = {}
    for row in _iter_settlement_rows(courier_tg_id):
        if row[config.SETL_TYPE - 1].strip() not in _SETL_WITHDRAW_TYPES:
            continue
        date_str = row[config.SETL_DATE - 1].strip()
        try:
            amount = int(row[config.SETL_AMOUNT - 1].strip() or 0)
        except ValueError:
            amount = 0
        withdrawn_by_day[date_str] = withdrawn_by_day.get(date_str, 0) + amount

    all_dates = set(collected_by_day) | set(withdrawn_by_day)
    out = []
    for date_str in all_dates:
        collected = collected_by_day.get(date_str, 0)
        withdrawn = withdrawn_by_day.get(date_str, 0)
        out.append({
            "date": date_str, "collected": collected, "withdrawn": withdrawn,
            "remaining": collected - withdrawn,
        })
    out.sort(key=lambda e: _parse_ru_date_safe(e["date"]), reverse=True)
    return out


def pay_courier_shift(courier_tg_id, courier_name: str, date_str: str, amount: int, from_cash: bool) -> dict:
    """Записывает "Заработок"/"Оплата за смену" за date_str (см.
    set_logistics_expense). Если from_cash=True — оплата выбрана "из уже
    собранных курьером наличных": сумма ДОПОЛНИТЕЛЬНО списывается с
    "Наличные у курьера" (SETTLEMENT_TYPE_PAID_FROM_CASH, дата та же —
    date_str), а если наличных на руках у курьера СЕЙЧАС меньше amount —
    отклоняет запись целиком, ничего не пишет (по прямой просьбе: сумма
    "из наличных" не может быть больше того, что реально у него на
    руках). Возвращает {"ok": True} или {"error": "insufficient_cash",
    "available": N}.

    "СЕЙЧАС" здесь — get_active_menu_date(), а не календарный
    today_date_str(): это та же дата, которую Mini App "Маршрут" считает
    "сегодня" везде (см. webapp._today) и под которой курьер реально
    записывает наличные (api_cash_record). Когда админ публикует
    следующий день заранее вечером, get_active_menu_date() уже "завтра"
    по календарю — наличные, собранные курьером под этой датой,
    календарным today_date_str() не увидены бы вовсе (отсюда "0
    собранных" при реально собранных деньгах) — воспроизведено и
    подтверждено."""
    if from_cash:
        available = get_courier_cash_balance_as_of(courier_tg_id, get_active_menu_date())
        if amount > available:
            return {"error": "insufficient_cash", "available": available}
    set_logistics_expense(date_str, courier_tg_id, courier_name, amount, from_cash=from_cash)
    if from_cash:
        record_courier_settlement(
            courier_tg_id, courier_name, config.SETTLEMENT_TYPE_PAID_FROM_CASH, amount, date_str=date_str,
        )
    return {"ok": True}


def withdraw_courier_cash(courier_tg_id, courier_name: str, day_amounts: dict) -> int:
    """"Забрать наличные" — day_amounts: {"ДД.ММ.ГГГГ": сумма, ...},
    одна запись SETTLEMENT_TYPE_CASH_RECEIVED на каждый день (так в
    истории по дням видно, с какого именно дня забрали, см.
    get_courier_cash_by_day). Нулевые/отрицательные суммы и пустой
    day_amounts пропускаются без записи. Возвращает сумму всех
    записанных строк."""
    total = 0
    for date_str, amount in day_amounts.items():
        amount = int(amount or 0)
        if amount <= 0:
            continue
        record_courier_settlement(courier_tg_id, courier_name, config.SETTLEMENT_TYPE_CASH_RECEIVED, amount, date_str=date_str)
        total += amount
    return total


# ---------------------------------------------------------------------------
# PAUSE Club — лента (PAUSE App, см. pauseapp.py). Публикация/удаление —
# только из самого приложения, отдельным экраном админа; в /admin бота
# ничего не переносилось.
# ---------------------------------------------------------------------------

def create_feed_post(post_type: str, caption: str, file_ids: list, author: str) -> str:
    """Создаёт пост ленты, возвращает его ID. file_ids — уже настоящие
    Telegram file_id (получены заранее в pauseapp.py отправкой фото в
    закрытый канал MEDIA_CHAT_ID), сюда просто пишутся через запятую —
    та же схема, что и у фото меню (см. set_today_menu_photos)."""
    ws = _ws(config.SHEET_FEED)
    post_id = f"FD{int(time.time() * 1000)}"
    row = [
        post_id, today_date_str(), post_type, caption or "",
        ",".join(file_ids), author or "", "",
    ]
    ws.append_row(row, value_input_option="RAW")
    return post_id


def get_feed_posts(limit: int = 50) -> list:
    """Опубликованные посты, от новых к старым — удалённые (см.
    delete_feed_post) в выдачу не попадают, но строки остаются в таблице
    (мягкое удаление, тот же приём, что и ROUTE_STATUS_REMOVED)."""
    ws = _ws(config.SHEET_FEED)
    rows = ws.get_all_values()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.FEED_DATA_START_ROW:
            continue
        if len(row) < config.FEED_ID or not row[config.FEED_ID - 1].strip():
            continue

        def cell(col, row=row):
            idx = col - 1
            return row[idx] if idx < len(row) else ""

        if cell(config.FEED_STATUS).strip() == config.FEED_STATUS_DELETED:
            continue
        file_ids_raw = cell(config.FEED_FILE_IDS)
        out.append({
            "row": r,
            "id": cell(config.FEED_ID),
            "date": cell(config.FEED_DATE),
            "type": cell(config.FEED_TYPE),
            "caption": cell(config.FEED_CAPTION),
            "file_ids": [f.strip() for f in file_ids_raw.split(",") if f.strip()],
            "author": cell(config.FEED_AUTHOR),
        })
    out.reverse()
    return out[:limit]


def delete_feed_post(post_id: str):
    """Мягкое удаление — строка остаётся в таблице со статусом "удалён",
    просто больше не отдаётся get_feed_posts."""
    ws = _ws(config.SHEET_FEED)
    rows = ws.get_all_values()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.FEED_DATA_START_ROW:
            continue
        if len(row) >= config.FEED_ID and row[config.FEED_ID - 1] == post_id:
            ws.update_cell(r, config.FEED_STATUS, config.FEED_STATUS_DELETED)
            return




# ---------------------------------------------------------------------------
# Mini App "Маршрут" — режим админов (владелец/назначенные курьеры-
# администраторы) и расходы на логистику. Оба листа — новые, не часть
# исходной таблицы PAUSE, поэтому
# заводятся автоматически (см. _ws_or_create), как и листы долгов выше.
# ---------------------------------------------------------------------------

def get_route_admin_mode(tg_id) -> str:
    """В каком режиме сейчас открывается "Заказы" у этого админа Mini App
    "Маршрут" — "admin" или "courier" (см. config.ROUTE_ADMIN_MODE_*). Нет
    строки — значит ни разу не переключался, по умолчанию "admin"."""
    ws = _ws_or_create(config.SHEET_ROUTE_ADMIN_MODE, ["tg_id", "name", "mode"])
    rows = ws.get_all_values()
    target = str(tg_id)
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.RAM_DATA_START_ROW:
            continue
        if len(row) >= config.RAM_MODE and row[config.RAM_TG_ID - 1].strip() == target:
            mode = row[config.RAM_MODE - 1].strip()
            return mode if mode in (config.ROUTE_ADMIN_MODE_ADMIN, config.ROUTE_ADMIN_MODE_COURIER) else config.ROUTE_ADMIN_MODE_ADMIN
    return config.ROUTE_ADMIN_MODE_ADMIN


def set_route_admin_mode(tg_id, name: str, mode: str):
    ws = _ws_or_create(config.SHEET_ROUTE_ADMIN_MODE, ["tg_id", "name", "mode"])
    rows = ws.get_all_values()
    target = str(tg_id)
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.RAM_DATA_START_ROW:
            continue
        if len(row) >= config.RAM_TG_ID and row[config.RAM_TG_ID - 1].strip() == target:
            ws.update_cell(r, config.RAM_NAME, name or "")
            ws.update_cell(r, config.RAM_MODE, mode)
            return
    ws.append_row([target, name or "", mode], value_input_option="RAW")


def get_logistics_expenses(date_str: str) -> dict:
    """{courier_tg_id: сумма оплаты за смену} на дату — для экрана "Расходы
    на логистику" в Mini App "Маршрут"."""
    rows = _logistics_raw_rows()
    out = {}
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.LOG_DATA_START_ROW:
            continue
        if len(row) < config.LOG_SHIFT_PAY:
            continue
        if row[config.LOG_DATE - 1].strip() != date_str:
            continue
        tg_id = row[config.LOG_COURIER_TG_ID - 1].strip()
        raw = row[config.LOG_SHIFT_PAY - 1].strip()
        try:
            out[tg_id] = int(raw) if raw else 0
        except ValueError:
            out[tg_id] = 0
    return out


_LOG_HEADER = ["date", "courier_tg_id", "courier_name", "shift_pay", "updated", "from_cash"]


def set_logistics_expense(date_str: str, courier_tg_id, courier_name: str, amount: int, from_cash: bool = False):
    """"Заработок"/"Оплата за смену" — один и тот же вызов из "Расходы на
    логистику" (общий экран, from_cash всегда False) и из карточки
    курьера в "Курьеры" (см. webapp.api_courier_pay_shift), где админ
    может выбрать оплатить из уже собранных курьером наличных —
    from_cash=True пишет отметку в LOG_FROM_CASH (сама сумма при этом
    дополнительно списывается с "Наличные у курьера" вызывающим кодом,
    см. record_courier_settlement/SETTLEMENT_TYPE_PAID_FROM_CASH)."""
    ws = _ws_or_create(config.SHEET_LOGISTICS_EXPENSES, _LOG_HEADER)
    _ensure_sheet_columns(ws, config.LOG_FROM_CASH)
    rows = ws.get_all_values()
    target = str(courier_tg_id)
    now_str = _now().strftime("%d.%m.%Y %H:%M")
    from_cash_val = "Да" if from_cash else ""
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.LOG_DATA_START_ROW:
            continue
        if len(row) < config.LOG_COURIER_TG_ID:
            continue
        if row[config.LOG_DATE - 1].strip() == date_str and row[config.LOG_COURIER_TG_ID - 1].strip() == target:
            # Одним batch-запросом (update_cells), а не четырьмя отдельными
            # update_cell — та же экономия вызовов API, что и у
            # record_cash_collection выше.
            ws.update_cells([
                gspread.Cell(r, config.LOG_COURIER_NAME, courier_name or ""),
                gspread.Cell(r, config.LOG_SHIFT_PAY, amount),
                gspread.Cell(r, config.LOG_UPDATED, now_str),
                gspread.Cell(r, config.LOG_FROM_CASH, from_cash_val),
            ], value_input_option="RAW")
            _invalidate_logistics_raw_cache()
            return
    ws.append_row([date_str, target, courier_name or "", amount, now_str, from_cash_val], value_input_option="RAW")
    _invalidate_logistics_raw_cache()


_delivery_raw_cache = {"rows": None, "ts": 0}


def _invalidate_delivery_raw_cache():
    _delivery_raw_cache["rows"] = None
    _delivery_raw_cache["ts"] = 0


def _delivery_raw_rows() -> list:
    now = time.time()
    if _delivery_raw_cache["rows"] is not None and now - _delivery_raw_cache["ts"] < _CASH_RAW_CACHE_TTL:
        return _delivery_raw_cache["rows"]
    rows = _ws_or_create(config.SHEET_DELIVERY_EXPENSE, ["date", "sum", "updated"]).get_all_values()
    _delivery_raw_cache["rows"] = rows
    _delivery_raw_cache["ts"] = now
    return rows


def get_delivery_expense(date_str: str) -> int:
    """Сумма, потраченная на доставку через сторонние сервисы (Яндекс,
    Uklon и т.п.) за один день — то, что вводит админ в Mini App "Маршрут"
    на экране "Расходы на логистику"."""
    rows = _delivery_raw_rows()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.DEL_DATA_START_ROW:
            continue
        if len(row) < config.DEL_SUM:
            continue
        if row[config.DEL_DATE - 1].strip() != date_str:
            continue
        raw = row[config.DEL_SUM - 1].strip()
        try:
            return int(raw) if raw else 0
        except ValueError:
            return 0
    return 0


def set_delivery_expense(date_str: str, amount: int):
    ws = _ws_or_create(config.SHEET_DELIVERY_EXPENSE, ["date", "sum", "updated"])
    rows = ws.get_all_values()
    now_str = _now().strftime("%d.%m.%Y %H:%M")
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.DEL_DATA_START_ROW:
            continue
        if len(row) < config.DEL_DATE:
            continue
        if row[config.DEL_DATE - 1].strip() == date_str:
            ws.update_cell(r, config.DEL_SUM, amount)
            ws.update_cell(r, config.DEL_UPDATED, now_str)
            _invalidate_delivery_raw_cache()
            return
    ws.append_row([date_str, amount, now_str], value_input_option="RAW")
    _invalidate_delivery_raw_cache()


def get_delivery_expense_total(date_from: str, date_to: str) -> int:
    """Сумма расходов на доставку через сторонние сервисы (Яндекс, Uklon
    и т.п.) за период [date_from, date_to] включительно — одно из ДВУХ
    слагаемых "Доставки" в "Чистая прибыль" PAUSE App, см.
    get_logistics_expense_total (второе слагаемое — оплата курьерам) и
    pauseapp.api_ops_summary, который суммирует оба."""
    try:
        d_from = dt.datetime.strptime(date_from, "%d.%m.%Y")
        d_to = dt.datetime.strptime(date_to, "%d.%m.%Y")
    except ValueError:
        return 0
    rows = _delivery_raw_rows()
    total = 0
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.DEL_DATA_START_ROW:
            continue
        if len(row) < config.DEL_SUM:
            continue
        try:
            d = dt.datetime.strptime(row[config.DEL_DATE - 1].strip(), "%d.%m.%Y")
        except ValueError:
            continue
        if not (d_from <= d <= d_to):
            continue
        raw = row[config.DEL_SUM - 1].strip()
        try:
            total += int(raw) if raw else 0
        except ValueError:
            pass
    return total


def get_logistics_expense_total(date_from: str, date_to: str) -> int:
    """Сумма оплаты за смену ВСЕМ курьерам за период [date_from, date_to]
    включительно — второе слагаемое "Доставки" в "Чистая прибыль" PAUSE
    App (первое — get_delivery_expense_total, расходы на сторонние
    сервисы). Раньше в "Чистая прибыль" учитывалась только эта сторонняя
    доставка — поймано на реальном примере (оплата курьеру 150 000 сум не
    прибавлялась к расходу на доставку через Яндекс) и исправлено."""
    try:
        d_from = dt.datetime.strptime(date_from, "%d.%m.%Y")
        d_to = dt.datetime.strptime(date_to, "%d.%m.%Y")
    except ValueError:
        return 0
    rows = _logistics_raw_rows()
    total = 0
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.LOG_DATA_START_ROW:
            continue
        if len(row) < config.LOG_SHIFT_PAY:
            continue
        try:
            d = dt.datetime.strptime(row[config.LOG_DATE - 1].strip(), "%d.%m.%Y")
        except ValueError:
            continue
        if not (d_from <= d <= d_to):
            continue
        raw = row[config.LOG_SHIFT_PAY - 1].strip()
        try:
            total += int(raw) if raw else 0
        except ValueError:
            pass
    return total


# ---------------------------------------------------------------------------
# Делегированные админы PAUSE App (см. config.SHEET_PAUSE_ADMINS) —
# "Операционный центр" → "Администраторы", управляет только главный админ
# (config.ADMIN_IDS). Новый лист, поэтому через _ws_or_create, как и
# остальные листы, появившиеся вместе с фичами (долги, логистика).
# ---------------------------------------------------------------------------

_PA_HEADER = ["tg_id", "name", "finance", "debtors", "added", "menu"]


def get_pause_admins() -> list:
    """[{"tg_id","name","finance","debtors","added"}] — все делегированные
    админы (не включает главного — ADMIN_IDS, тот не хранится здесь).

    Кэшируется на _CACHE_TTL секунд — admin_auth_middleware (pauseapp.py)
    дёргает get_pause_admin (а значит и эту функцию) на КАЖДЫЙ запрос
    /api/* от любого НЕ главного админа, то есть на каждый клик в
    приложении — без кэша это было лишним чтением на каждое действие,
    тем же классом проблемы, что и у остального в этом файле."""
    now = time.time()
    if _cache.get("pause_admins") is not None and now - _cache.get("pause_admins_ts", 0) < _CACHE_TTL:
        return _cache["pause_admins"]
    ws = _ws_or_create(config.SHEET_PAUSE_ADMINS, _PA_HEADER)
    rows = ws.get_all_values()
    out = []
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.PA_DATA_START_ROW:
            continue
        if len(row) < config.PA_TG_ID or not row[config.PA_TG_ID - 1].strip():
            continue
        out.append({
            "tg_id": row[config.PA_TG_ID - 1].strip(),
            "name": row[config.PA_NAME - 1].strip() if len(row) >= config.PA_NAME else "",
            "finance": row[config.PA_FINANCE - 1].strip().lower() == "да" if len(row) >= config.PA_FINANCE else False,
            "debtors": row[config.PA_DEBTORS - 1].strip().lower() == "да" if len(row) >= config.PA_DEBTORS else False,
            "added": row[config.PA_ADDED - 1].strip() if len(row) >= config.PA_ADDED else "",
            "menu": row[config.PA_MENU - 1].strip().lower() == "да" if len(row) >= config.PA_MENU else False,
        })
    _cache["pause_admins"] = out
    _cache["pause_admins_ts"] = now
    return out


def get_pause_admin(tg_id) -> dict:
    """Одна запись по tg_id либо None — для проверки прав на каждый
    запрос (см. pauseapp.admin_auth_middleware)."""
    target = str(tg_id)
    for a in get_pause_admins():
        if a["tg_id"] == target:
            return a
    return None


def add_pause_admin(tg_id, name: str):
    """Не дублирует строку, если такой tg_id уже есть — функции у
    существующей записи трогать не нужно, "Добавить" на уже добавленном
    человеке просто ничего не меняет."""
    ws = _ws_or_create(config.SHEET_PAUSE_ADMINS, _PA_HEADER)
    rows = ws.get_all_values()
    target = str(tg_id)
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.PA_DATA_START_ROW:
            continue
        if len(row) >= config.PA_TG_ID and row[config.PA_TG_ID - 1].strip() == target:
            return
    ws.append_row([target, name or "", "", "", today_date_str()], value_input_option="RAW")
    _cache["pause_admins"] = None


def set_pause_admin_feature(tg_id, feature: str, allowed: bool):
    """feature: "finance" | "debtors" | "menu"."""
    col = {"finance": config.PA_FINANCE, "debtors": config.PA_DEBTORS, "menu": config.PA_MENU}[feature]
    ws = _ws_or_create(config.SHEET_PAUSE_ADMINS, _PA_HEADER)
    rows = ws.get_all_values()
    target = str(tg_id)
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.PA_DATA_START_ROW:
            continue
        if len(row) >= config.PA_TG_ID and row[config.PA_TG_ID - 1].strip() == target:
            ws.update_cell(r, col, "да" if allowed else "")
            _cache["pause_admins"] = None
            return


def remove_pause_admin(tg_id):
    ws = _ws_or_create(config.SHEET_PAUSE_ADMINS, _PA_HEADER)
    rows = ws.get_all_values()
    target = str(tg_id)
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.PA_DATA_START_ROW:
            continue
        if len(row) >= config.PA_TG_ID and row[config.PA_TG_ID - 1].strip() == target:
            ws.delete_rows(r)
            _cache["pause_admins"] = None
            return


# ---------------------------------------------------------------------------
# PAUSE App → "Pause Club": карточки "Сейчас в клубе" (config.SHEET_CLUB_CARDS).
# Админ ("Операционный центр" → "Управление Pause Club") добавляет/удаляет/
# переставляет карточки и правит весь их текст и фото. Лист маленький, поэтому
# каждая правка = прочитать все строки, изменить список, переписать лист целиком
# (под замком, чтобы две правки подряд не затёрли друг друга).
#
# Текстовое поле у встроенной карточки (kind != "custom") пустое = "показывать
# стандартный текст из i18n" — так смена языка продолжает работать, пока админ
# сам ничего не переписал. У kind == "custom" пустое поле = элемент не рисуется.
# Пустой СПИСОК хранится строкой-маркером "_empty" — иначе удаление всех
# карточек выглядело бы как "ничего не настроено" и возвращало стандартные.
# ---------------------------------------------------------------------------

_CC_HEADER = ["id", "kind", "eyebrow", "heading", "desc", "cta", "stat1", "stat2", "photo", "color", "carousel"]
CLUB_CARD_TEXT_FIELDS = ("eyebrow", "heading", "desc", "cta", "stat1", "stat2")
CLUB_CARD_COLORS = ("green", "gold", "terracotta", "caramel")
CLUB_BUILTIN_KINDS = ("pday", "biggift", "top", "moments")
_CC_BUILTIN_COLOR = {"pday": "green", "biggift": "gold", "top": "terracotta", "moments": "caramel"}
_club_cards_lock = threading.Lock()


def _club_card_new(kind: str) -> dict:
    custom = kind not in CLUB_BUILTIN_KINDS
    card = {f: "" for f in CLUB_CARD_TEXT_FIELDS}
    card.update({
        "id": ("c" + uuid.uuid4().hex[:8]) if custom else kind,
        "kind": "custom" if custom else kind,
        "photo": "",
        "color": "green" if custom else _CC_BUILTIN_COLOR[kind],
        # Исходная раскладка: "PAUSE DAY" и "Большой приз" — одна карусель.
        "carousel": kind in ("pday", "biggift"),
    })
    if custom:
        card["heading"] = "Новая карточка"
    return card


def _club_cards_default() -> list:
    return [_club_card_new(k) for k in CLUB_BUILTIN_KINDS]


def _read_club_cards_raw():
    """None — лист пуст (ещё не настраивали), иначе список карточек."""
    ws = _ws_or_create(config.SHEET_CLUB_CARDS, _CC_HEADER)
    rows = ws.get_all_values()[1:]
    rows = [r for r in rows if r and r[0].strip()]
    if not rows:
        return None
    out = []
    for r in rows:
        r = list(r) + [""] * (len(_CC_HEADER) - len(r))
        d = dict(zip(_CC_HEADER, [c.strip() if i not in (2, 3, 4, 5, 6, 7) else c for i, c in enumerate(r)]))
        if d["id"] == "_empty":
            continue
        d["carousel"] = d["carousel"].lower() == "да"
        if d["color"] not in CLUB_CARD_COLORS:
            d["color"] = "green"
        out.append(d)
    return out


def get_club_cards() -> list:
    now = time.time()
    if _cache.get("club_cards") is not None and now - _cache.get("club_cards_ts", 0) < _CACHE_TTL:
        return _cache["club_cards"]
    cards = _read_club_cards_raw()
    if cards is None:
        cards = _club_cards_default()
    _cache["club_cards"] = cards
    _cache["club_cards_ts"] = now
    return cards


def _write_club_cards(cards: list):
    ws = _ws_or_create(config.SHEET_CLUB_CARDS, _CC_HEADER)
    if cards:
        values = [[c.get(h, "") if h != "carousel" else ("да" if c.get("carousel") else "") for h in _CC_HEADER] for c in cards]
    else:
        values = [["_empty"] + [""] * (len(_CC_HEADER) - 1)]
    ws.clear()
    ws.update([_CC_HEADER] + values, "A1", value_input_option="RAW")
    _cache["club_cards"] = [dict(c) for c in cards]
    _cache["club_cards_ts"] = time.time()


def _mutate_club_cards(fn):
    """fn(cards) меняет список на месте и может вернуть значение; читаем
    свежее из таблицы (не из кэша), чтобы не затереть чужую правку."""
    with _club_cards_lock:
        cards = _read_club_cards_raw()
        if cards is None:
            cards = _club_cards_default()
        result = fn(cards)
        _write_club_cards(cards)
        return result if result is not None else cards


def add_club_card(kind: str = "custom"):
    """Новая пустая карточка в конец; встроенную (kind из CLUB_BUILTIN_KINDS)
    можно "вернуть" после удаления — дубль не создаём."""
    def fn(cards):
        if kind in CLUB_BUILTIN_KINDS and any(c["id"] == kind for c in cards):
            return None
        card = _club_card_new(kind)
        cards.append(card)
    return _mutate_club_cards(fn)


def update_club_card(card_id: str, fields: dict):
    def fn(cards):
        for c in cards:
            if c["id"] != card_id:
                continue
            for f in CLUB_CARD_TEXT_FIELDS:
                if f in fields:
                    c[f] = str(fields[f] or "").strip()[:600]
            if fields.get("color") in CLUB_CARD_COLORS:
                c["color"] = fields["color"]
            if "carousel" in fields:
                c["carousel"] = bool(fields["carousel"])
            return None
    return _mutate_club_cards(fn)


def delete_club_card(card_id: str):
    def fn(cards):
        cards[:] = [c for c in cards if c["id"] != card_id]
    return _mutate_club_cards(fn)


def move_club_card(card_id: str, delta: int):
    def fn(cards):
        for i, c in enumerate(cards):
            if c["id"] == card_id:
                j = i + (1 if delta > 0 else -1)
                if 0 <= j < len(cards):
                    cards[i], cards[j] = cards[j], cards[i]
                return None
    return _mutate_club_cards(fn)


def set_club_card_photo(card_id: str, file_id: str):
    """file_id == "" — убрать фото."""
    def fn(cards):
        for c in cards:
            if c["id"] == card_id:
                c["photo"] = file_id
                return None
    return _mutate_club_cards(fn)


# ---------------------------------------------------------------------------
# PAUSE MOMENTS — стена постов клиентов и комментарии (config.SHEET_MOMENTS /
# SHEET_MOMENT_COMMENTS). Свои листы, старая "Лента" (Послания) не трогается.
# ---------------------------------------------------------------------------

_MOM_HEADER = ["id", "ts", "tg_id", "name", "text", "file_ids", "status"]
_MOMC_HEADER = ["id", "post_id", "ts", "tg_id", "name", "text", "status"]
_MOML_HEADER = ["post_id", "tg_id", "ts", "status"]  # status "" — лайк стоит, "снят" — убран


def _moment_now() -> str:
    return dt.datetime.now(TASHKENT_TZ).isoformat(timespec="seconds")


def _moment_row(row, n):
    return list(row) + [""] * (n - len(row))


def create_moment(tg_id, name: str, text: str, file_ids: list) -> dict:
    ws = _ws_or_create(config.SHEET_MOMENTS, _MOM_HEADER)
    post = {"id": f"M{int(time.time() * 1000)}", "ts": _moment_now(), "tg_id": str(tg_id), "name": name or "",
            "text": text or "", "file_ids": [f for f in file_ids if f]}
    ws.append_row([post["id"], post["ts"], post["tg_id"], post["name"], post["text"], ",".join(post["file_ids"]), ""],
                  value_input_option="RAW")
    return post


def _live_comment_counts() -> dict:
    ws = _ws_or_create(config.SHEET_MOMENT_COMMENTS, _MOMC_HEADER)
    counts = {}
    for row in ws.get_all_values()[1:]:
        row = _moment_row(row, len(_MOMC_HEADER))
        if row[0].strip() and row[6].strip() != config.FEED_STATUS_DELETED:
            counts[row[1]] = counts.get(row[1], 0) + 1
    return counts


def _live_likes():
    """({post_id: число лайков}, {(post_id, tg_id)} — кто что лайкнул)."""
    ws = _ws_or_create(config.SHEET_MOMENT_LIKES, _MOML_HEADER)
    counts, pairs = {}, set()
    for row in ws.get_all_values()[1:]:
        row = _moment_row(row, len(_MOML_HEADER))
        if row[0].strip() and row[3].strip() != "снят":
            counts[row[0]] = counts.get(row[0], 0) + 1
            pairs.add((row[0], row[1]))
    return counts, pairs


def toggle_moment_like(post_id: str, tg_id) -> tuple:
    """Ставит/снимает лайк, возвращает (liked, like_count)."""
    ws = _ws_or_create(config.SHEET_MOMENT_LIKES, _MOML_HEADER)
    target = str(tg_id)
    liked = None
    for i, row in enumerate(ws.get_all_values()):
        row = _moment_row(row, len(_MOML_HEADER))
        if i and row[0] == post_id and row[1] == target:
            liked = row[3].strip() == "снят"  # был снят — теперь ставим
            ws.update_cell(i + 1, 4, "" if liked else "снят")
            break
    if liked is None:
        ws.append_row([post_id, target, _moment_now(), ""], value_input_option="RAW")
        liked = True
    counts, _pairs = _live_likes()
    return liked, counts.get(post_id, 0)


def get_moment_author(post_id: str) -> str:
    """tg_id автора живого поста либо ""."""
    ws = _ws_or_create(config.SHEET_MOMENTS, _MOM_HEADER)
    for row in ws.get_all_values()[1:]:
        row = _moment_row(row, len(_MOM_HEADER))
        if row[0] == post_id and row[6].strip() != config.FEED_STATUS_DELETED:
            return row[2]
    return ""


def get_moments(limit: int = 50, viewer_tg_id=None) -> list:
    """Живые посты, новые сверху, с числом комментариев/лайков и liked —
    поставил ли лайк смотрящий."""
    ws = _ws_or_create(config.SHEET_MOMENTS, _MOM_HEADER)
    out = []
    for row in ws.get_all_values()[1:]:
        row = _moment_row(row, len(_MOM_HEADER))
        if not row[0].strip() or row[6].strip() == config.FEED_STATUS_DELETED:
            continue
        out.append({"id": row[0], "ts": row[1], "tg_id": row[2], "name": row[3], "text": row[4],
                    "file_ids": [f.strip() for f in row[5].split(",") if f.strip()]})
    out.reverse()
    out = out[:limit]
    counts = _live_comment_counts()
    like_counts, pairs = _live_likes()
    viewer = str(viewer_tg_id) if viewer_tg_id is not None else None
    for p in out:
        p["comment_count"] = counts.get(p["id"], 0)
        p["like_count"] = like_counts.get(p["id"], 0)
        p["liked"] = viewer is not None and (p["id"], viewer) in pairs
    return out


def _set_status_by_id(sheet_name, header, item_id, status_col):
    ws = _ws_or_create(sheet_name, header)
    for i, row in enumerate(ws.get_all_values()):
        if i and row and row[0] == item_id:
            ws.update_cell(i + 1, status_col, config.FEED_STATUS_DELETED)
            return True
    return False


def delete_moment(post_id: str) -> bool:
    return _set_status_by_id(config.SHEET_MOMENTS, _MOM_HEADER, post_id, 7)


def add_moment_comment(post_id: str, tg_id, name: str, text: str) -> dict:
    ws = _ws_or_create(config.SHEET_MOMENT_COMMENTS, _MOMC_HEADER)
    c = {"id": f"C{int(time.time() * 1000)}", "post_id": post_id, "ts": _moment_now(),
         "tg_id": str(tg_id), "name": name or "", "text": text or ""}
    ws.append_row([c["id"], post_id, c["ts"], c["tg_id"], c["name"], c["text"], ""], value_input_option="RAW")
    return c


def get_moment_comments(post_id: str) -> list:
    """Комментарии поста — от старых к новым (как в переписке)."""
    ws = _ws_or_create(config.SHEET_MOMENT_COMMENTS, _MOMC_HEADER)
    out = []
    for row in ws.get_all_values()[1:]:
        row = _moment_row(row, len(_MOMC_HEADER))
        if row[1] != post_id or not row[0].strip() or row[6].strip() == config.FEED_STATUS_DELETED:
            continue
        out.append({"id": row[0], "post_id": row[1], "ts": row[2], "tg_id": row[3], "name": row[4], "text": row[5]})
    return out


def delete_moment_comment(comment_id: str) -> bool:
    return _set_status_by_id(config.SHEET_MOMENT_COMMENTS, _MOMC_HEADER, comment_id, 7)

# -*- coding: utf-8 -*-
"""
Слой работы с Google Таблицей. Всё общение с гугл-таблицей PAUSE идёт только
через эти функции — если завтра поменяются столбцы, править нужно только тут.
"""
import json
import time
import datetime as dt
from typing import Optional
from zoneinfo import ZoneInfo

import gspread
from google.oauth2.service_account import Credentials

import config

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
_cache = {"clients": None, "clients_ts": 0, "couriers": None, "couriers_ts": 0}
_CACHE_TTL = 60  # секунд — не дёргаем таблицу на каждый чих


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


def _ws(name):
    return _connect().worksheet(name)


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
        })
    _cache["clients"] = clients
    _cache["clients_ts"] = now
    return clients


def find_client_by_tg_id(tg_id: int) -> Optional[dict]:
    tg_id = str(tg_id)
    for c in _load_clients():
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


def _row_amount(row: list, prices: dict) -> int:
    """Сумма по строке заказа — считаем сами по цене сета, а не полагаемся на
    формулу в таблице (она может быть не протянута на новые строки)."""
    set_name = row[config.O_SET - 1].strip() if len(row) >= config.O_SET else ""
    try:
        qty = int(row[config.O_QTY - 1].strip() or 0) if len(row) >= config.O_QTY else 0
    except ValueError:
        qty = 0
    amount = qty * prices.get(set_name, 0)
    if amount:
        return amount
    if len(row) >= config.O_SUM:
        try:
            return int(row[config.O_SUM - 1].replace(" ", "").replace(",", "") or 0)
        except (ValueError, IndexError):
            pass
    return 0


def create_client(tg_id: int, name: str, phone: str, telegram_username: str = "") -> int:
    """Создаёт нового клиента, возвращает его новый ID."""
    ws = _ws(config.SHEET_CLIENTS)
    clients = _load_clients(force=True)
    max_id = max([int(c["id"]) for c in clients if str(c["id"]).isdigit()], default=0)
    new_id = max_id + 1
    new_row_num = max([c["row"] for c in clients], default=config.CLIENTS_DATA_START_ROW - 1) + 1

    updates = [
        (config.COL_ID, str(new_id)),
        (config.COL_NAME, name),
        (config.COL_CONTACT, phone),
        (config.COL_TELEGRAM, telegram_username),
        (config.COL_STATUS, "Новичок"),
        (config.COL_TG_ID, str(tg_id)),
        (config.COL_REG_DATE, today_date_str()),
    ]
    for col, value in updates:
        ws.update_cell(new_row_num, col, value)

    _cache["clients"] = None  # сбрасываем кэш
    return new_id


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
    """Если клиент указал новую точку — сохраняем её ему в карточку."""
    ws = _ws(config.SHEET_CLIENTS)
    ws.update_cell(client_row, config.COL_ZONE, zone)
    ws.update_cell(client_row, config.COL_POINT, point)
    _cache["clients"] = None


def update_client_field(client_row: int, col: int, value: str):
    """Правка одного поля клиента (имя/телефон) из личного кабинета."""
    ws = _ws(config.SHEET_CLIENTS)
    ws.update_cell(client_row, col, value)
    _cache["clients"] = None


def is_canceled(comment: str) -> bool:
    return config.CANCEL_MARKER in (comment or "")


def get_client_debt(client_id) -> int:
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
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


def get_all_debtors() -> list:
    """Возвращает список [(имя, id, сумма_долга)] — агрегированный по всем заказам."""
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
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
        if payment != "В долг":
            continue
        comment = row[config.O_COMMENT - 1].strip() if len(row) >= config.O_COMMENT else ""
        if is_canceled(comment):
            continue
        eid = row[config.O_CLIENT_ID - 1].strip()
        name = (clients.get(eid) or {}).get("name") or (row[config.O_NAME - 1].strip() if len(row) >= config.O_NAME else "") or eid
        amount = _row_amount(row, prices)
        key = eid or name
        if key not in debts:
            debts[key] = {"name": name, "id": eid, "sum": 0}
        debts[key]["sum"] += amount
    return sorted(debts.values(), key=lambda d: -d["sum"])


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
                "comment": comment,
                "canceled": is_canceled(comment),
            })
    return out[-limit:][::-1]


def get_client_order_groups(client_id, limit=10) -> list:
    """Заказы клиента, сгруппированные по дате — один оформленный заказ мог
    занять несколько строк (несколько сетов), но это по-прежнему один заказ
    для отмены/отзыва/истории. Возвращает от новых к старым."""
    rows = get_client_orders(client_id, limit=10**9)  # уже от новых к старым
    groups, order = {}, []
    for r in rows:
        key = r["date"]
        if key not in groups:
            groups[key] = {
                "date": r["date"],
                "zone": r["zone"],
                "items": [],
                "rows": [],
                "payment": r["payment"],
                "comment": r["comment"],
                "canceled": r["canceled"],
            }
            order.append(key)
        g = groups[key]
        g["items"].append({"set": r["set"], "qty": r["qty"]})
        g["rows"].append(r["row"])
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
                  screenshot: str = "") -> int:
    """Добавляет строку заказа, возвращает номер строки (нужен для подтверждения оплаты картой)."""
    ws = _ws(config.SHEET_ORDERS)
    row_num = _next_empty_order_row()
    updates = [
        (config.O_DATE, date_str),
        (config.O_ZONE, zone),
        (config.O_POINT, point),
        (config.O_CLIENT_ID, _id_value(client_id)),
        (config.O_SET, set_name),
        (config.O_QTY, str(qty)),
        (config.O_GARNISH, garnish or ""),
        (config.O_PAYMENT, payment),
        (config.O_COMMENT, comment or ""),
    ]
    if screenshot:
        updates.append((config.O_SCREENSHOT, screenshot))
    cells = [gspread.Cell(row_num, col, value) for col, value in updates]
    ws.update_cells(cells)
    return row_num


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


def mark_screenshot_sent(row_nums: list):
    """Клиент прислал скрин оплаты картой (сразу при заказе или позже) —
    статус оплаты (столбец K) становится "На проверке", формула столбца L
    показывает "НЕ ОПЛАЧЕНО" до подтверждения администратором
    (confirm_card_payment)."""
    ws = _ws(config.SHEET_ORDERS)
    for r in row_nums:
        ws.update_cell(r, config.O_PAYMENT, "На проверке")


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
        if payment != "":
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
            by_client[client_id] = {"client_id": client_id, "tg_id": tg_id, "rows": []}
            order.append(client_id)
        by_client[client_id]["rows"].append(r)

    return [by_client[cid] for cid in order]


def get_payment_screenshots(date_str: str) -> list:
    """Скрины оплаты за указанную дату — источник для /payments.

    Без какой-либо фильтрации по статусу/отмене/способу оплаты: одна
    запись на каждую строку «Заказы» за эту дату, где столбец
    O_SCREENSHOT непустой — и всё. Если в одном заказе несколько сетов
    (несколько строк с одним и тем же скрином), каждая строка всё равно
    попадёт в список отдельной записью."""
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    prices = get_set_prices()
    clients = _clients_index()
    out = []

    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_DATE or row[config.O_DATE - 1].strip() != date_str:
            continue
        screenshot = row[config.O_SCREENSHOT - 1].strip() if len(row) >= config.O_SCREENSHOT else ""
        if not screenshot:
            continue
        client_id = row[config.O_CLIENT_ID - 1].strip() if len(row) >= config.O_CLIENT_ID else ""
        client = clients.get(client_id) or {}
        name = client.get("name") or (row[config.O_NAME - 1].strip() if len(row) >= config.O_NAME else "") or client_id or "—"
        out.append({
            "row": r,
            "client_id": client_id,
            "name": name,
            "set": row[config.O_SET - 1].strip() if len(row) >= config.O_SET else "",
            "qty": row[config.O_QTY - 1].strip() if len(row) >= config.O_QTY else "",
            "sum": _row_amount(row, prices),
            "screenshot": screenshot,
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

def get_set_prices() -> dict:
    ws = _ws(config.SHEET_REFERENCE)
    values = ws.get(config.REF_SET_PRICE_RANGE)
    out = {}
    for row in values:
        if len(row) >= 2 and row[0]:
            try:
                out[row[0]] = int(str(row[1]).replace(" ", "").replace(",", ""))
            except ValueError:
                pass
    return out


def get_sets() -> list:
    ws = _ws(config.SHEET_REFERENCE)
    return [v[0] for v in ws.get(config.REF_SETS_RANGE) if v]


def get_garnishes() -> list:
    """Полный список всех возможных гарниров — справочник на будущее."""
    ws = _ws(config.SHEET_REFERENCE)
    return [v[0] for v in ws.get(config.REF_GARNISH_RANGE) if v]


def get_today_garnishes() -> list:
    """Гарниры, которые реально есть сегодня — задаёт админ после публикации
    меню. Если ещё не заданы, вызывающая сторона сама решает, что показать
    (обычно — падать обратно на полный список get_garnishes())."""
    ws = _ws(config.SHEET_REFERENCE)
    raw = ws.acell(config.REF_TODAY_GARNISH_CELL).value or ""
    return [g.strip() for g in raw.split(",") if g.strip()]


def set_today_garnishes(garnishes: list):
    ws = _ws(config.SHEET_REFERENCE)
    ws.update_acell(config.REF_TODAY_GARNISH_CELL, ", ".join(garnishes))


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


def save_care_message(number: int, tg_id, name: str, date_str: str, phrase: str):
    ws = _ws(config.SHEET_MESSAGES)
    ws.append_row([number, str(tg_id), name, date_str, phrase], value_input_option="RAW")


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
    предыдущую, тем самым "закрывая" её."""
    ws = _ws(config.SHEET_REFERENCE)
    date_str = (ws.acell(config.REF_TODAY_MENU_DATE_CELL).value or "").strip()
    return date_str or today_date_str()


# ---------------------------------------------------------------------------
# Pause Club
# ---------------------------------------------------------------------------

def get_club_level(order_count: int) -> dict:
    """Уровень клуба по количеству заказов — чистая функция, таблицу не трогает."""
    levels = config.CLUB_LEVELS
    current = levels[0]
    next_level = None
    for i, (threshold, emoji, label) in enumerate(levels):
        if order_count >= threshold:
            current = (threshold, emoji, label)
            next_level = levels[i + 1] if i + 1 < len(levels) else None
        else:
            break
    _, emoji, label = current
    result = {"emoji": emoji, "label": label, "order_count": order_count, "next_label": None, "left": 0}
    if next_level:
        next_threshold, next_emoji, next_label = next_level
        result["next_label"] = next_label
        result["next_emoji"] = next_emoji
        result["left"] = max(0, next_threshold - order_count)
    return result


def get_giveaway() -> tuple:
    """(активен ли розыгрыш, текст розыгрыша)."""
    ws = _ws(config.SHEET_CLUB)
    active = (ws.acell(config.CLUB_ACTIVE_CELL).value or "").strip().lower() == "да"
    text = ws.acell(config.CLUB_GIVEAWAY_TEXT_CELL).value or ""
    return active, text


def set_giveaway(text: str, active: bool):
    ws = _ws(config.SHEET_CLUB)
    ws.update_acell(config.CLUB_ACTIVE_CELL, "Да" if active else "Нет")
    ws.update_acell(config.CLUB_GIVEAWAY_TEXT_CELL, text or "")


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

def is_in_daily_giveaway(date_str: str, tg_id) -> bool:
    ws = _ws(config.SHEET_DAILY_GIVEAWAY)
    rows = ws.get_all_values()
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
    сетов, заказанных клиентом сегодня)."""
    tg_id = client.get("tg_id")
    if not tg_id or is_in_daily_giveaway(date_str, tg_id):
        return
    tickets = get_client_ticket_counts(date_str).get(str(client.get("id")), 0)
    ws = _ws(config.SHEET_DAILY_GIVEAWAY)
    ws.append_row(
        [date_str, _id_value(client.get("id")), str(tg_id), client.get("name", ""), tickets, ""],
        value_input_option="RAW",
    )


def get_daily_giveaway_participants(date_str: str) -> list:
    """Участники розыгрыша на дату:
    [{"row", "client_id", "tg_id", "name", "tickets", "winner"}]."""
    ws = _ws(config.SHEET_DAILY_GIVEAWAY)
    rows = ws.get_all_values()
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
# Отчёты для кухни / курьера — те же формулы, что и в самой таблице,
# просто пересчитанные тут, чтобы бот мог прислать их сам
# ---------------------------------------------------------------------------

def get_orders_for_date(date_str: str) -> list:
    """Сырые строки заказов на дату (без отменённых) — источник для PDF-отчёта.
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
        out.append({
            "name": name,
            "zone": row[config.O_ZONE - 1].strip(),
            "point": row[config.O_POINT - 1].strip(),
            "set": row[config.O_SET - 1].strip(),
            "qty": row[config.O_QTY - 1].strip() or "0",
            "garnish": row[config.O_GARNISH - 1].strip(),
            "comment": comment,
        })
    return out


def build_kitchen_report(date_str: str) -> str:
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    clients = _clients_index()
    lines_by_name = {}
    order_by_name = []
    comments = []
    total = blyudo = standart = 0

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

        try:
            q = int(qty)
        except ValueError:
            q = 0
        total += q
        if set_name == "Блюдо дня":
            blyudo += q
        elif set_name == "Сет стандарт":
            standart += q

        piece = f"{qty}шт {set_name}"
        if garnish and garnish != "без гарнира":
            piece += f" ({garnish})"

        if name not in lines_by_name:
            lines_by_name[name] = []
            order_by_name.append(name)
        lines_by_name[name].append(piece)

        if comment:
            comments.append(f"{name} - {comment}")

    out = ["ИНФОРМАЦИЯ ДЛЯ КУХНИ", "", f"{total} сетов", f"{blyudo} - Блюдо дня", f"{standart} - Сет стандарт", ""]
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
    """Справочник точек доставки — [{"name","address","lat","lon","priority","rate"}]."""
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
    return out


def _delivery_points_index() -> dict:
    return {p["name"]: p for p in get_delivery_points()}


def get_couriers() -> list:
    """Все записи из "Курьеры" — [{"tg_id","name","status"}]. Кэшируется на
    _CACHE_TTL секунд — is_active_courier() дёргается на каждом показе
    главного меню бота, каждый раз ходить в Sheets незачем."""
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
        })
    _cache["couriers"] = out
    _cache["couriers_ts"] = now
    return out


def is_active_courier(tg_id) -> bool:
    target = str(tg_id)
    return any(c["tg_id"] == target and c["status"] == config.COURIER_STATUS_ACTIVE for c in get_couriers())


def _active_couriers() -> list:
    return [c for c in get_couriers() if c["status"] == config.COURIER_STATUS_ACTIVE]


def get_route_people(date_str: str) -> dict:
    """Люди с реальными (неотменёнными) заказами на дату, сгруппированные по
    точке доставки, затем по клиенту — {точка: [{"client_id","name",
    "contact","comment","items":[{"set","qty"}]}]}."""
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

        people = by_point.setdefault(point, {})
        person = people.setdefault(client_id, {
            "client_id": client_id, "name": name, "contact": contact,
            "comment": comment, "items": [],
        })
        person["items"].append({
            "set": row[config.O_SET - 1].strip(),
            "qty": row[config.O_QTY - 1].strip() or "0",
        })

    return {point: list(people.values()) for point, people in by_point.items()}


def sync_daily_route(date_str: str):
    """Гарантирует, что для каждой точки с реальным заказом на дату есть
    строка в "Маршрут" — не трогает уже существующие строки (порядок,
    статус, курьера), только добавляет недостающие. Идемпотентно, безопасно
    вызывать при каждом открытии экрана — актуальность не кэшируется."""
    points_with_orders = set(get_route_people(date_str).keys())
    if not points_with_orders:
        return

    ws = _ws(config.SHEET_ROUTE)
    rows = ws.get_all_values()
    existing = set()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_POINT:
            continue
        if row[config.ROUTE_DATE - 1].strip() == date_str:
            existing.add(row[config.ROUTE_POINT - 1].strip())

    missing = points_with_orders - existing
    if not missing:
        return

    dp_index = _delivery_points_index()
    couriers = _active_couriers()
    default_courier = couriers[0]["tg_id"] if couriers else ""

    new_rows = [
        [date_str, point, default_courier, dp_index.get(point, {}).get("priority", 0),
         config.ROUTE_STATUS_WAITING, ""]
        for point in missing
    ]
    new_rows.sort(key=lambda row: row[3] if isinstance(row[3], (int, float)) else 0)
    ws.append_rows(new_rows, value_input_option="RAW")


def get_route_for_date(date_str: str) -> list:
    """Полный маршрут на дату — точки с людьми, координатами, ставкой,
    статусом, отсортирован по "Порядок". Сначала синхронизирует новые точки
    (см. sync_daily_route) — данные всегда актуальны на момент вызова."""
    sync_daily_route(date_str)

    ws = _ws(config.SHEET_ROUTE)
    rows = ws.get_all_values()
    dp_index = _delivery_points_index()
    people = get_route_people(date_str)

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

        point_name = cell(config.ROUTE_POINT).strip()
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
            "courier_tg_id": cell(config.ROUTE_COURIER_TG_ID).strip(),
            "order": order_num,
            "status": cell(config.ROUTE_STATUS).strip() or config.ROUTE_STATUS_WAITING,
            "delivered_at": cell(config.ROUTE_DELIVERED_AT).strip(),
            "people": people.get(point_name, []),
        })

    out.sort(key=lambda p: p["order"])
    return out


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


def add_route_point(date_str: str, point_name: str):
    """Добавляет точку в маршрут вручную (админ), даже если реальных
    заказов на неё сегодня нет — ставится в конец маршрута."""
    existing = get_route_for_date(date_str)  # заодно синхронизирует
    if any(p["point"] == point_name for p in existing):
        return

    ws = _ws(config.SHEET_ROUTE)
    couriers = _active_couriers()
    default_courier = couriers[0]["tg_id"] if couriers else ""
    max_order = max([p["order"] for p in existing], default=0)
    ws.append_row(
        [date_str, point_name, default_courier, max_order + 1, config.ROUTE_STATUS_WAITING, ""],
        value_input_option="RAW",
    )


def remove_route_point(date_str: str, point_name: str):
    ws = _ws(config.SHEET_ROUTE)
    rows = ws.get_all_values()
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ROUTE_DATA_START_ROW:
            continue
        if len(row) < config.ROUTE_POINT:
            continue
        if row[config.ROUTE_DATE - 1].strip() == date_str and row[config.ROUTE_POINT - 1].strip() == point_name:
            ws.delete_rows(r)
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
            ws.update_cell(r, config.ROUTE_STATUS, config.ROUTE_STATUS_DELIVERED)
            ws.update_cell(r, config.ROUTE_DELIVERED_AT, _now().strftime("%H:%M"))
            return


def get_courier_earnings(courier_tg_id, date_str: str) -> int:
    """Сумма ставок всех сданных ("Сдано") точек курьера за дату."""
    route = get_route_for_date(date_str)
    target = str(courier_tg_id)
    return sum(
        p["rate"] for p in route
        if p["courier_tg_id"] == target and p["status"] == config.ROUTE_STATUS_DELIVERED
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
        if row[config.ROUTE_COURIER_TG_ID - 1].strip() != target:
            continue
        if row[config.ROUTE_STATUS - 1].strip() != config.ROUTE_STATUS_DELIVERED:
            continue
        point = row[config.ROUTE_POINT - 1].strip()
        total += dp_index.get(point, {}).get("rate", 0)
    return total

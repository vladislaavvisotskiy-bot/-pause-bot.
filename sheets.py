# -*- coding: utf-8 -*-
"""
Слой работы с Google Таблицей. Всё общение с гугл-таблицей PAUSE идёт только
через эти функции — если завтра поменяются столбцы, править нужно только тут.
"""
import json
import time
import datetime as dt
from typing import Optional

import gspread
from google.oauth2.service_account import Credentials

import config

_SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
]

_client = None
_sheet = None
_cache = {"clients": None, "clients_ts": 0}
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
                  qty: int, garnish: str, payment: str, comment: str = "") -> int:
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
    cells = [gspread.Cell(row_num, col, value) for col, value in updates]
    ws.update_cells(cells)
    return row_num


def confirm_card_payment(row_nums: list):
    """Отмечает в комментарии заказа, что скрин оплаты картой проверен и подтверждён."""
    ws = _ws(config.SHEET_ORDERS)
    for r in row_nums:
        cur = ws.cell(r, config.O_COMMENT).value or ""
        new = cur.replace("оплата на проверке", "оплата подтверждена")
        if new == cur and cur:
            new = cur + " | оплата подтверждена"
        elif not cur:
            new = "оплата подтверждена"
        ws.update_cell(r, config.O_COMMENT, new)


def mark_screenshot_sent(row_nums: list):
    """Отмечает в комментарии заказа, что клиент прислал скрин оплаты
    (например, в ответ на напоминание) — статус переходит с "не
    подтверждена" на "на проверке", дальше — обычное подтверждение
    администратором (confirm_card_payment)."""
    ws = _ws(config.SHEET_ORDERS)
    for r in row_nums:
        cur = ws.cell(r, config.O_COMMENT).value or ""
        new = cur.replace("оплата не подтверждена", "оплата на проверке")
        if new == cur and cur:
            new = cur + " | оплата на проверке"
        elif not cur:
            new = "оплата на проверке"
        ws.update_cell(r, config.O_COMMENT, new)


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
    """Клиенты, оплатившие картой и выбравшие "пришлю скрин позже", но
    так и не приславшие его — источник для дневного напоминания об
    оплате. Группируем по клиенту (несколько строк одного заказа — одно
    напоминание). Возвращает [{"client_id", "tg_id", "rows": [...]}]."""
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
        if "карт" not in payment.lower():
            continue
        comment = row[config.O_COMMENT - 1].strip()
        if is_canceled(comment):
            continue
        if "оплата не подтверждена" not in comment:
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


def is_after_cutoff() -> bool:
    now = dt.datetime.now()
    cutoff_h, cutoff_m = map(int, config.ORDER_CUTOFF_TIME.split(":"))
    cutoff = now.replace(hour=cutoff_h, minute=cutoff_m, second=0, microsecond=0)
    return now >= cutoff


def is_after_cancel_cutoff() -> bool:
    now = dt.datetime.now()
    cutoff_h, cutoff_m = map(int, config.CANCEL_CUTOFF_TIME.split(":"))
    cutoff = now.replace(hour=cutoff_h, minute=cutoff_m, second=0, microsecond=0)
    return now >= cutoff


def today_date_str() -> str:
    return dt.datetime.now().strftime("%d.%m.%Y")


def get_recent_order_dates() -> list:
    """Уникальные даты, реально встречающиеся в «Заказы», в окне последних
    7 дней (включая сегодня) и завтра — источник для кнопок выбора даты в
    отчётах администратора. Хронологический порядок, формат DD.MM.YYYY."""
    ws = _ws(config.SHEET_ORDERS)
    col = ws.col_values(config.O_DATE)
    today = dt.datetime.now().date()
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
    заменяется новой."""
    ws = _ws(config.SHEET_REFERENCE)
    ws.update_acell(config.REF_TODAY_MENU_DATE_CELL, date_str)


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

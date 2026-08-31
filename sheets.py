# -*- coding: utf-8 -*-
"""
Слой работы с Google Таблицей. Всё общение с гугл-таблицей PAUSE идёт только
через эти функции — если завтра поменяются столбцы, править нужно только тут.
"""
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
        clients.append({
            "row": r,
            "id": int(cid) if cid.isdigit() else cid,
            "name": cell(config.COL_NAME),
            "zone": cell(config.COL_ZONE),
            "point": cell(config.COL_POINT),
            "contact": cell(config.COL_CONTACT),
            "telegram": cell(config.COL_TELEGRAM),
            "tg_id": cell(config.COL_TG_ID),
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


def get_client_debt(client_id) -> int:
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    total = 0
    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        eid = row[config.O_CLIENT_ID - 1].strip() if len(row) >= config.O_CLIENT_ID else ""
        payment = row[config.O_PAYMENT - 1].strip() if len(row) >= config.O_PAYMENT else ""
        if eid == str(client_id) and payment == "В долг":
            try:
                total += int(row[config.O_SUM - 1].replace(" ", "").replace(",", "") or 0)
            except (ValueError, IndexError):
                pass
    return total


def get_all_debtors() -> list:
    """Возвращает список [(имя, id, сумма_долга)] — агрегированный по всем заказам."""
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
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
        eid = row[config.O_CLIENT_ID - 1].strip()
        name = row[config.O_NAME - 1].strip() if len(row) >= config.O_NAME else eid
        try:
            amount = int(row[config.O_SUM - 1].replace(" ", "").replace(",", "") or 0)
        except (ValueError, IndexError):
            amount = 0
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
            out.append({
                "date": row[config.O_DATE - 1] if len(row) >= config.O_DATE else "",
                "set": row[config.O_SET - 1] if len(row) >= config.O_SET else "",
                "qty": row[config.O_QTY - 1] if len(row) >= config.O_QTY else "",
                "payment": row[config.O_PAYMENT - 1] if len(row) >= config.O_PAYMENT else "",
            })
    return out[-limit:][::-1]


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
        (config.O_CLIENT_ID, str(client_id)),
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


def get_order_date_for_now() -> str:
    """Заказ до времени отсечки — на сегодня, после — на завтра. Формат DD.MM.YYYY."""
    now = dt.datetime.now()
    cutoff_h, cutoff_m = map(int, config.ORDER_CUTOFF_TIME.split(":"))
    cutoff = now.replace(hour=cutoff_h, minute=cutoff_m, second=0, microsecond=0)
    target = now if now < cutoff else now + dt.timedelta(days=1)
    return target.strftime("%d.%m.%Y")


def is_after_cutoff() -> bool:
    now = dt.datetime.now()
    cutoff_h, cutoff_m = map(int, config.ORDER_CUTOFF_TIME.split(":"))
    cutoff = now.replace(hour=cutoff_h, minute=cutoff_m, second=0, microsecond=0)
    return now >= cutoff


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
    ws = _ws(config.SHEET_REFERENCE)
    return [v[0] for v in ws.get(config.REF_GARNISH_RANGE) if v]


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
    ws = _ws(config.SHEET_REFERENCE)
    ws.update_acell(config.REF_TODAY_MENU_CELL, ",".join(photo_ids))
    ws.update_acell(config.REF_TODAY_MENU2_CELL, caption or "")


# ---------------------------------------------------------------------------
# Отчёты для кухни / курьера — те же формулы, что и в самой таблице,
# просто пересчитанные тут, чтобы бот мог прислать их сам
# ---------------------------------------------------------------------------

def build_kitchen_report(date_str: str) -> str:
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
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
        name = row[config.O_NAME - 1].strip()
        if not name:
            continue
        set_name = row[config.O_SET - 1].strip()
        qty = row[config.O_QTY - 1].strip() or "0"
        garnish = row[config.O_GARNISH - 1].strip()
        comment = row[config.O_COMMENT - 1].strip()

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
    ws = _ws(config.SHEET_ORDERS)
    rows = ws.get_all_values()
    by_zone = {}
    zone_order = []

    for i, row in enumerate(rows):
        r = i + 1
        if r < config.ORDERS_DATA_START_ROW:
            continue
        if len(row) < config.O_TELEGRAM:
            row = row + [""] * (config.O_TELEGRAM - len(row))
        if row[config.O_DATE - 1].strip() != date_str:
            continue
        zone = row[config.O_ZONE - 1].strip()
        name = row[config.O_NAME - 1].strip()
        if not zone or not name:
            continue
        point = row[config.O_POINT - 1].strip()
        contact = row[config.O_CONTACT - 1].strip() or "Неизвестно"
        telegram = row[config.O_TELEGRAM - 1].strip()
        payment = row[config.O_PAYMENT - 1].strip()
        try:
            amount = int(row[config.O_SUM - 1].replace(" ", "").replace(",", "") or 0)
        except (ValueError, IndexError):
            amount = 0

        tg = f"@{telegram}" if telegram and not telegram.startswith("@") else (telegram or "—")
        line = f"○ {name} - {contact} / {tg} - {point} - {amount:,} сум - {payment}".replace(",", " ")

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

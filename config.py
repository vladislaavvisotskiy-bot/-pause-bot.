import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID", "")
GOOGLE_CREDENTIALS_FILE = os.getenv("GOOGLE_CREDENTIALS_FILE", "credentials.json")
# На облачном хостинге (Railway и т.п.) файл рядом с кодом не положить —
# туда весь credentials.json кладут одной строкой в переменную окружения.
# Если она задана, используем её; если нет — как раньше, читаем файл.
GOOGLE_CREDENTIALS_JSON = os.getenv("GOOGLE_CREDENTIALS_JSON", "")
ADMIN_CHAT_ID = int(os.getenv("ADMIN_CHAT_ID", "0") or 0)
ORDER_CUTOFF_TIME = os.getenv("ORDER_CUTOFF_TIME", "10:00")
CANCEL_CUTOFF_TIME = os.getenv("CANCEL_CUTOFF_TIME", "09:00")
MORNING_REPORT_TIME = os.getenv("MORNING_REPORT_TIME", "10:05")
WARM_BROADCAST_TIME = os.getenv("WARM_BROADCAST_TIME", "08:00")
PAYMENT_REMINDER_TIME = os.getenv("PAYMENT_REMINDER_TIME", "14:30")
GIVEAWAY_TIME = os.getenv("GIVEAWAY_TIME", "10:00")

# Отметка в комментарии заказа, по которой бот считает его отменённым клиентом
# (отчёты кухни/курьера и подсчёт долга такие строки пропускают)
CANCEL_MARKER = "ОТМЕНЁН"

# --- Названия листов и колонки — под структуру уже существующей таблицы PAUSE ---
SHEET_CLIENTS = "Sheet1"
SHEET_ORDERS = "Заказы"
SHEET_REFERENCE = "Справочники"

# Sheet1 (CRM): header row 5, data starts row 6
CLIENTS_HEADER_ROW = 5
CLIENTS_DATA_START_ROW = 6
COL_ID = 5          # E
COL_NAME = 6        # F
COL_ZONE = 7        # G  ("Район" / зона доставки)
COL_POINT = 8       # H  ("Место работы" / точка)
COL_CONTACT = 10    # J  (телефон)
COL_TELEGRAM = 11   # K  (Instagram/Telegram username, текстом)
COL_STATUS = 13     # M
COL_NOTE = 14        # N
COL_ORDER_COUNT = 15  # O ("Кол-во Заказов" — уже считается в таблице, бот только читает)
COL_LAST_ORDER_DATE = 16  # P ("Дата последнего заказа" — тоже уже считается, бот не трогает)
COL_TG_ID = 17       # Q — НОВЫЙ столбец, надо добавить в таблицу вручную (см. README)
COL_REG_DATE = 18    # R — НОВЫЙ столбец, дата регистрации, бот пишет сам

# Заказы: header row 1, data starts row 2
ORDERS_HEADER_ROW = 1
ORDERS_DATA_START_ROW = 2
O_DATE = 1        # A
O_ZONE = 2        # B  (Направление)
O_POINT = 3       # C  (Точка)
O_CLIENT_LABEL = 4  # D (не используется ботом — оставляем пустым)
O_CLIENT_ID = 5    # E
O_NAME = 6        # F (формула — не трогаем)
O_SET = 7         # G
O_QTY = 8         # H
O_GARNISH = 9     # I
O_SUM = 10        # J (формула — не трогаем)
O_PAYMENT = 11    # K
O_STATUS = 12     # L ("Статус" — формула/ручная отметка ОПЛАЧЕНО, бот не трогает)
O_COMMENT = 13    # M (Комментарии)
O_CONTACT = 14    # N (формула — не трогаем)
O_TELEGRAM = 15   # O (формула — не трогаем)

# Справочники: цены сетов
REF_SET_PRICE_RANGE = "F2:G3"     # (Сет, Цена)
REF_ZONES_RANGE = "A2:A50"        # направления
REF_SETS_RANGE = "B2:B20"         # сеты
REF_GARNISH_RANGE = "C2:C20"      # гарниры
REF_PAYMENT_RANGE = "D2:D20"      # способы оплаты
REF_TODAY_MENU_CELL = "J1"        # список file_id фотографий меню на сегодня (через запятую) — бот пишет сам
REF_TODAY_MENU2_CELL = "J2"       # подпись к посту меню на сегодня — бот пишет сам
REF_TODAY_GARNISH_CELL = "J3"     # гарниры, доступные сегодня (через запятую) — бот пишет сам
REF_TODAY_MENU_DATE_CELL = "J4"   # дата доставки, на которую действует опубликованное меню — бот пишет сам
REF_GIVEAWAY_CLOSED_CELL = "J5"   # "Да" — сегодняшняя "Пауза в подарок" уже подведена, окно участия закрыто

# --- Pause Club: лист "Клуб" ---
SHEET_CLUB = "Клуб"
CLUB_ACTIVE_CELL = "B1"          # "Да" / "Нет" — есть ли сейчас активный розыгрыш
CLUB_GIVEAWAY_TEXT_CELL = "B2"   # текст розыгрыша
CLUB_INFO_TEXT_CELL = "B3"       # общий текст о клубе (когда розыгрыша нет)

# Пороги уровней Pause Club — по количеству заказов (столбец O в CRM)
CLUB_LEVELS = [
    (0, "🕊", "Гость PAUSE"),
    (3, "🤍", "Свой человек"),
    (10, "🧡", "Круг PAUSE"),
    (25, "🌄", "Амбассадор PAUSE"),
]

# --- PDF-отчёт для кухни ---
PDF_FONT_REGULAR = os.path.join(os.path.dirname(__file__), "fonts", "DejaVuSans.ttf")
PDF_FONT_BOLD = os.path.join(os.path.dirname(__file__), "fonts", "DejaVuSans-Bold.ttf")

# --- Заказы на новую точку, ждущие подтверждения координатором ---
SHEET_PENDING = "Ожидают подтверждения"
PENDING_HEADER_ROW = 1
PENDING_DATA_START_ROW = 2
P_ID = 1
P_DATE = 2
P_ZONE = 3
P_POINT = 4
P_CLIENT_ID = 5
P_CLIENT_NAME = 6
P_CLIENT_PHONE = 7
P_CART_JSON = 8
P_PAYMENT = 9
P_COMMENT = 10
P_SCREENSHOT = 11
P_STATUS = 12
PENDING_STATUS_WAITING = "ожидает"
PENDING_STATUS_APPROVED = "подтверждено"
PENDING_STATUS_DENIED = "отклонено"

# --- Ежедневный розыгрыш "Пауза в подарок" — участники дня ---
SHEET_DAILY_GIVEAWAY = "Пауза в подарок"
DG_HEADER_ROW = 1
DG_DATA_START_ROW = 2
DG_DATE = 1        # A  Дата
DG_CLIENT_ID = 2   # B  ID клиента (CRM)
DG_TG_ID = 3       # C  Telegram ID
DG_NAME = 4        # D  Имя
DG_TICKETS = 5     # E  Билеты
DG_WINNER = 6      # F  Победитель

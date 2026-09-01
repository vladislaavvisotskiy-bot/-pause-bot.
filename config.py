import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID", "")
GOOGLE_CREDENTIALS_FILE = os.getenv("GOOGLE_CREDENTIALS_FILE", "credentials.json")
ADMIN_CHAT_ID = int(os.getenv("ADMIN_CHAT_ID", "0") or 0)
ORDER_CUTOFF_TIME = os.getenv("ORDER_CUTOFF_TIME", "10:00")
MORNING_REPORT_TIME = os.getenv("MORNING_REPORT_TIME", "10:05")

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
COL_TG_ID = 17       # Q — НОВЫЙ столбец, надо добавить в таблицу вручную (см. README)

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

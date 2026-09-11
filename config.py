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
ORDER_COMPLETE_TIME = os.getenv("ORDER_COMPLETE_TIME", "13:00")
MORNING_REPORT_TIME = os.getenv("MORNING_REPORT_TIME", "10:05")
WARM_BROADCAST_TIME = os.getenv("WARM_BROADCAST_TIME", "08:00")
PAYMENT_REMINDER_TIME = os.getenv("PAYMENT_REMINDER_TIME", "13:30")

# Пауза между отправками в массовых рассылках клиентам (тёплая рассылка,
# оповещение о новом меню, напоминание об оплате) — чтобы не словить
# flood-контроль Telegram на большом списке получателей.
BROADCAST_DELAY_SECONDS = float(os.getenv("BROADCAST_DELAY_SECONDS", "0.1"))

# --- Telegram Mini App (курьерский маршрут) ---
# Публичный HTTPS-адрес, по которому Railway отдаёт веб-сервис (см. README) —
# без него кнопки маршрута в меню бота не показываются.
WEBAPP_URL = os.getenv("WEBAPP_URL", "").rstrip("/")
# Railway сам прокидывает PORT для сервисов с публичным доменом.
WEBAPP_PORT = int(os.getenv("PORT", os.getenv("WEBAPP_PORT", "8080")))

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
O_SCREENSHOT = 28  # AB — скрытый столбец, file_id скрина оплаты картой, бот пишет сам.
# ВАЖНО: столбцы Q:AA в "Заказы" — уже занятая нативная служебная область
# таблицы (формулы подсчёта уникальных клиентов, вспомогательные отчётные
# данные) — их трогать нельзя. Новый столбец добавлен строго в конец
# (после AA), а не в середину, чтобы не сдвигать и не задевать эти формулы.

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
REF_BROADCASTS_OFF_CELL = "J6"    # "Да" — админ временно выключил все автоматические рассылки клиентам
REF_LAST_MESSAGE_NUMBER_CELL = "J7"  # последний выданный номер "послания дня" — бот пишет сам

# --- Цифровые "послания дня" (замена бумажным карточкам с номерами) ---
SHEET_MESSAGES = "Послания"
MSG_HEADER_ROW = 1
MSG_DATA_START_ROW = 2
MSG_NUMBER = 1     # A
MSG_TG_ID = 2      # B
MSG_NAME = 3       # C
MSG_DATE = 4       # D
MSG_TEXT = 5       # E
CARE_MESSAGE_START_NUMBER = 1019
CARE_MESSAGE_TOTAL = 1518

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

# --- Курьерский маршрут (Telegram Mini App) ---
SHEET_DELIVERY_POINTS = "Точки доставки"
DP_HEADER_ROW = 1
DP_DATA_START_ROW = 2
DP_NAME = 1        # A  Точка (совпадает с "Точка" в "Заказы")
DP_ADDRESS = 2     # B  Адрес
DP_LAT = 3         # C  Широта
DP_LON = 4         # D  Долгота
DP_PRIORITY = 5    # E  Приоритет по умолчанию
DP_RATE = 6        # F  Ставка курьеру за точку (сум)

SHEET_COURIERS = "Курьеры"
COURIER_HEADER_ROW = 1
COURIER_DATA_START_ROW = 2
COURIER_TG_ID = 1  # A
COURIER_NAME = 2   # B
COURIER_STATUS = 3  # C
COURIER_STATUS_ACTIVE = "Активен"
COURIER_STATUS_INACTIVE = "Неактивен"

SHEET_ROUTE = "Маршрут"
ROUTE_HEADER_ROW = 1
ROUTE_DATA_START_ROW = 2
ROUTE_DATE = 1          # A
ROUTE_POINT = 2         # B
ROUTE_COURIER_TG_ID = 3  # C
ROUTE_ORDER = 4         # D  Порядок (число)
ROUTE_STATUS = 5        # E
ROUTE_DELIVERED_AT = 6  # F  Время сдачи (заполняется автоматически)
ROUTE_COURIER_COMMENT = 7  # G  Комментарий для курьера на этот день (вводит админ)
ROUTE_STATUS_WAITING = "Ожидает"
ROUTE_STATUS_IN_PROGRESS = "В пути"
ROUTE_STATUS_DELIVERED = "Сдано"
# Точку убрали из маршрута на этот день через Mini App — строка не удаляется
# физически, а помечается этим статусом: если её не отличать от "просто
# отсутствует", sync_daily_route() (см. sheets.py) увидит точку с реальным
# заказом без строки в "Маршрут" и тут же добавит её обратно — визуально это
# выглядит как "удаление не работает". Строка со статусом "Убрано" по-прежнему
# существует (не даёт sync_daily_route создать дубликат), но get_route_for_date
# исключает такие строки из выдачи, так что курьер/админ её не видят.
ROUTE_STATUS_REMOVED = "Убрано"

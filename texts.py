# -*- coding: utf-8 -*-
"""Все тексты бота собраны в одном месте — в стиле PAUSE (тепло, коротко, без канцелярита)."""
import html
import re

# Как называются сеты для клиента в боте — при этом в таблицу и отчёты кухни/
# курьера по-прежнему уходят исходные названия из Справочников ("Блюдо дня",
# "Сет стандарт"), чтобы ничего не сломать в уже настроенных отчётах.
SET_DISPLAY_NAMES = {
    "Блюдо дня": "Пауза дня",
    "Сет стандарт": "Для тебя",
}


def display_set_name(name: str) -> str:
    return SET_DISPLAY_NAMES.get(name, name)


def display_garnish(garnish: str) -> str:
    """Гарнир для показа клиенту — с заглавной буквы (кнопки, сводка заказа,
    итоговое сообщение). В таблицу "Заказы" по-прежнему пишем как прислали
    (с маленькой буквы) — отчёты Кухня/Курьер ищут точное совпадение
    "без гарнира" в нижнем регистре, менять это нельзя."""
    g = (garnish or "").strip()
    if not g:
        return g
    if "/" in g:
        # составной гарнир вида "рис/пюре 50/50" -> "Рис/Пюре 50/50"
        head, sep, tail = g.partition(" ")
        parts = [p[:1].upper() + p[1:] if p else p for p in head.split("/")]
        head_cap = "/".join(parts)
        return f"{head_cap} {tail}".strip() if tail else head_cap
    return g[:1].upper() + g[1:]


# --- Форматирование текста меню при пересылке клиентам ---
# Заголовок сета ("Пауза дня." / "Для тебя.", допускаем небольшие отличия в
# формулировке) — жирным. Строка с ценой (содержит "uzs") — курсивом.
_MENU_HEADER_RE = re.compile(r"^\s*(пауза\s+дня|для\s+тебя)", re.IGNORECASE)
_MENU_PRICE_RE = re.compile(r"uzs", re.IGNORECASE)


def format_menu_text(text: str) -> str:
    """HTML-разметка текста меню от админа для показа клиенту. Экранируем
    исходный текст целиком (это свободный текст от человека, может
    содержать "<"/"&"), затем оборачиваем найденные строки в <b>/<i>."""
    if not text:
        return text
    out_lines = []
    for line in text.split("\n"):
        stripped = line.strip()
        escaped = html.escape(line)
        if stripped and _MENU_HEADER_RE.match(stripped):
            out_lines.append(f"<b>{escaped}</b>")
        elif stripped and _MENU_PRICE_RE.search(stripped):
            out_lines.append(f"<i>{escaped}</i>")
        else:
            out_lines.append(escaped)
    return "\n".join(out_lines)


SUPPORT_USERNAME = "@ssaavveeyy"

# --- Главное меню и общая навигация ---
HOME_BTN = "🏠 Главное меню"
PROFILE_BTN = "👤 Профиль"
MENU_BTN = "💌 Меню"
CLUB_BTN = "🌿 Pause Club"
SUPPORT_BTN = "🤍 Поддержка"

REQUISITES_TEXT = "5614 6829 1627 0798\nVladislav Visotskiy"

WELCOME_NEW = (
    "☘️ Привет, здесь PAUSE.\n\n"
    "Мы каждый день готовим два тёплых сета — «Пауза дня» и «Для тебя» — "
    "и привозим прямо к вам, с маленьким посланием внутри коробки.\n\n"
    "Давай немного познакомимся, чтобы дальше заказывать было в один клик."
)

WELCOME_BACK = "☘️ С возвращением! Что сегодня закажем?"

ASK_NAME = "Как к вам обращаться? Напишите имя, как удобно."

ASK_PHONE = (
    "И последнее — оставьте номер телефона, чтобы курьер мог с вами связаться 📱\n\n"
    "Пример: 90 000 99 66"
)

REGISTERED = (
    "Как здорово, {name} — теперь вы часть Pause Club 🌿\n\n"
    "Дальше просто заходите и выбирайте то, что по душе — мы всегда рады "
    "позаботиться о вас ☘️"
)

MAIN_MENU = "Чем займёмся?"

NO_MENU_YET = "Меню на сегодня ещё не опубликовано — загляните чуть позже."

CHOOSE_SET = "Какой сет выбираем?"

CHOOSE_GARNISH = "Гарнир на выбор — какой положить?"
MIX_GARNISH_BTN = "🔀 Смешать гарниры"
CHOOSE_GARNISH_MIX1 = "Выберите первый гарнир:"
CHOOSE_GARNISH_MIX2 = "И второй — смешаем 50/50:"

ASK_QTY = "Сколько порций этого сета?"

ASK_MORE = "Добавим ещё сет к заказу?"

FIRST_TIME_ZONE_INTRO = (
    "Укажите, куда доставлять — это нужно сделать только один раз, "
    "дальше мы запомним и не будем спрашивать снова."
)

CHOOSE_ZONE = "В каком районе вас найти?"

CHOOSE_BUILDING = "Уточните дом/комплекс:"

CHOOSE_POINT = "И конкретную точку:"

ASK_NEW_POINT = "Впишите адрес — мы сохраним его на будущее."

CHOOSE_PAYMENT = "Как удобнее оплатить?"

CARD_REQUISITES_MSG = "Реквизиты для оплаты:\n\n{requisites}"
CARD_PAYMENT_ASK = "Пришлите скрин оплаты сейчас, или подтвердите чуть позже?"
CARD_SEND_NOW_BTN = "📎 Пришлю сейчас"
CARD_LATER_BTN = "🕐 Подтвержу позже"
CARD_SEND_SCREENSHOT = "Пришлите, пожалуйста, скрин оплаты — просто отправьте фото сюда."
CARD_SCREENSHOT_EXPECTED = "Жду именно фото со скрином оплаты — или напишите /start, если передумали."
CARD_SCREENSHOT_RECEIVED = "Скрин получили, спасибо — передаём на проверку."

PAYMENT_REMINDER_TEXT = (
    "☘️ Не забудьте прислать скрин оплаты за сегодняшний заказ — "
    "так мы сможем быстрее его подтвердить 🪴"
)

ORDER_SUMMARY_HEADER = "Проверьте заказ:"
ORDER_PAYMENT_STATUS_CHECKING = "\nОплата: скрин на проверке"
ORDER_PAYMENT_STATUS_LATER = "\nОплата: подтвердите позже"

ORDER_CONFIRM_BTN = "Всё верно, отправить"
ORDER_RESTART_BTN = "Изменить"
ADD_COMMENT_BTN = "💬 Добавить комментарий"
EDIT_COMMENT_BTN = "✏️ Изменить комментарий"
ADD_COMMENT_PROMPT = "Напишите комментарий к заказу:"

ORDER_SENT = (
    "Записал 🪴, спасибо за выбор 🌿✨\n\n"
    "Ждите — мы уже готовим что-то тёплое специально для вас."
)

ORDER_PENDING_NEW_POINT = (
    "☘️ Заказ принят! Новая точка доставки сейчас проверяется координатором — "
    "обычно это быстро.\n\nЕсли хотите ускорить — можете написать напрямую {support}."
)
ORDER_POINT_APPROVED = "Точка подтверждена, ваш заказ принят в работу ☘️"
ORDER_POINT_DENIED = (
    "К сожалению, пока не можем доставить по этому адресу. "
    "Напишите {support}, разберёмся."
)

ADMIN_PENDING_POINT_ALERT = (
    "📍 Новый адрес — нужна проверка\n\n"
    "Клиент: {name} (ID {client_id})\n"
    "Куда: {zone}, {point}\n"
    "Заказ: {items}\n"
    "Сумма: {sum} сум\n"
    "Оплата: {payment}\n\n"
    "Подтвердите точку, чтобы заказ ушёл на кухню, или отклоните."
)
ADMIN_PENDING_SCREENSHOT_NOTE = (
    "\n\n💳 Приложен скрин оплаты — «Подтвердить» разом одобрит и точку, и оплату."
)
ADMIN_PENDING_APPROVE_BTN = "✅ Подтвердить"
ADMIN_PENDING_DENY_BTN = "❌ Отклонить"
ADMIN_PENDING_APPROVED_TOAST = "Подтверждено, заказ ушёл в «Заказы» ✓"
ADMIN_PENDING_DENIED_TOAST = "Отклонено ✓"
ADMIN_PENDING_ALREADY_HANDLED = "Этот заказ уже обработан."

CUTOFF_CLOSED_NOTICE = (
    "Приём заказов на сегодня закрыт. Напишем, как только опубликуем меню на завтра."
)

MY_ORDERS_EMPTY = "Пока не было ни одного заказа — самое время начать 🪴"

MY_ORDERS_HEADER = "Ваша история с нами:"

MY_DEBT_LINE = "\n\nТекущий долг: {sum:,} сум".replace(",", " ")
MY_ORDERS_CANCELED_TAG = " (отменён)"

# --- Раздел «Профиль» ---
PROFILE_NOT_SET = "не указано"
PROFILE_TEMPLATE = (
    "👤 {name}\n"
    "📞 {phone}\n"
    "📍 {point}\n\n"
    "{club_emoji} Статус в Pause Club: {club_label}\n"
    "🗓 С нами с {reg_date}\n"
    "🧾 Всего заказов: {order_count}"
)
MY_ORDERS_LINK_BTN = "📋 Мои заказы"

EDIT_PROFILE_BTN = "✏️ Изменить данные"
EDIT_NAME_BTN = "Имя"
EDIT_PHONE_BTN = "Телефон"
EDIT_POINT_BTN = "Точку по умолчанию"
EDIT_PROFILE_HEADER = "Что поправим?"
EDIT_NAME_PROMPT = "Как вас теперь называть? Напишите имя."
EDIT_PHONE_PROMPT = "Впишите новый номер телефона."
EDIT_SAVED = "Готово, сохранили ✓"

CANCEL_ORDER_BTN = "❌ Отменить заказ"
CANCEL_NO_ORDERS = "Пока нечего отменять — заказов ещё не было."
CANCEL_ALREADY = "Этот заказ уже отменён."
CANCEL_TOO_LATE = (
    "Отменить заказ можно только до {cutoff} — сейчас уже поздно.\n"
    "Если очень нужно — напишите нашему помощнику {support}, разберёмся."
)
CANCEL_CARD_REDIRECT = (
    "Оплата по этому заказу уже {status} — самостоятельно отменить нельзя, "
    "тут нужна помощь человека. Напишите {support}, поможем с отменой и возвратом."
)
CANCEL_CONFIRM_ASK = "Точно отменить заказ от {date}: {items}?"
CANCEL_CONFIRM_YES = "Да, отменить"
CANCEL_CONFIRM_NO = "Нет, оставить"
CANCEL_DONE = "Готово, заказ отменён. Если что — мы тут же рядом 🪴"
CANCEL_KEPT = "Хорошо, оставили заказ в силе."

ADMIN_ORDER_CANCELLED_ALERT = (
    "❌ Клиент {name} (ID {client_id}) отменил заказ на {date}:\n{items}"
)

FEEDBACK_BTN = "⭐ Оставить отзыв: {date}"
FEEDBACK_NO_ORDERS = "Пока нечего оценивать — закажите что-нибудь в первый раз 🪴"
FEEDBACK_PROMPT = "Расскажите, как всё прошло — что понравилось, что стоит поправить."
FEEDBACK_THANKS = "Спасибо, что рассказали! Обязательно передадим команде 🪴"

ADMIN_FEEDBACK_ALERT = (
    "⭐ Отзыв от клиента {name} (ID {client_id})\n"
    "О заказе: {order}\n\n"
    "{text}"
)

SUPPORT_INFO = (
    "Если что-то не так, есть вопрос или просто хочется рассказать — "
    "мы всегда на связи 🤍\n\n"
    "Пишите в любое время: {support}"
).format(support=SUPPORT_USERNAME)

# --- Раздел «Pause Club» ---
CLUB_STATUS_TEMPLATE = "{emoji} Статус: {label}\nЗаказов сделано: {order_count}"
CLUB_NEXT_LEVEL_LINE = "\nЕщё {left} до уровня «{next_emoji} {next_label}»"
CLUB_MAX_LEVEL_LINE = "\nВы на максимальном уровне 🌄"
CLUB_NEWS_HEADER = "\n\n🗞 Новости и события\n"

GIVEAWAY_PARTICIPATE_BTN = "🎁 Участвовать"
GIVEAWAY_JOINED = "Готово, записали вас — удачи 🍀"
ADMIN_GIVEAWAY_JOIN_ALERT = "🎁 {name} (ID {client_id}) хочет участвовать в розыгрыше."

# --- Ежедневный розыгрыш "Пауза в подарок" (отдельно от /giveaway) ---
DAILY_GIVEAWAY_BLOCK = (
    "🤎 Пауза в подарок\n\n"
    "Дарим один сет PAUSE.\n"
    "Просто потому что иногда каждому нужен маленький повод остановиться, "
    "выдохнуть и позаботиться о себе. 🤎\n\n"
    "Условия:\n"
    "Каждый день мы выбираем одного человека среди тех, кто заказал сегодня, "
    "и дарим ему обед. Чем больше сетов вы заказали, тем выше шанс, что "
    "сегодня выберут именно вас.\n\n"
    "Итоги подводим каждый день — если это будете вы, мы напишем лично, а "
    "имя появится в канале PAUSE 🌿"
)
DAILY_GIVEAWAY_ORDER_BTN = "⬇️для участия, выбери сет⬇️"
DAILY_GIVEAWAY_JOIN_BTN = "🎉 Участвовать"
DAILY_GIVEAWAY_JOINED_TEXT = "Вы участвуете в сегодняшней «Паузе в подарок» 🌿 Удачи!"
DAILY_GIVEAWAY_CLOSED_TEXT = (
    "Сегодняшняя «Пауза в подарок» уже нашла своего героя 🤎 "
    "Загляните завтра — будет новый повод"
)
DAILY_GIVEAWAY_WINNER_MSG = "🎉 Сегодня ваш заказ за наш счёт! Спасибо, что вы с нами 🌿"
ADMIN_DAILY_GIVEAWAY_WINNER_ALERT = (
    "🤎 Победитель «Паузы в подарок»: {name} (ID {client_id}), контакт: {contact}"
)
ADMIN_GIVEAWAY_TODAY_HEADER = "🤎 Участники «Паузы в подарок» на {date}:"
ADMIN_GIVEAWAY_TODAY_EMPTY = "Пока никто не участвует в сегодняшней «Паузе в подарок»."
ORDER_SENT_GIVEAWAY_HINT = (
    "Кстати, загляните в 🌿 Pause Club — сегодня разыгрывается "
    "«Пауза в подарок», вы уже можете участвовать 🎉"
)

BACK_BTN = "‹ Назад"
OTHER_BTN = "Другое / нет в списке"

# --- Админ ---
ADMIN_ONLY = "Эта команда доступна только администратору."

ADMIN_NEW_POINT_ALERT = (
    "📍 Новая точка от клиента {name} (ID {client_id}):\n"
    "Район: {zone}\nТочка: {point}\n\n"
    "Впишите её в CRM (столбец «Место работы»), чтобы она появилась в списке у всех."
)

ADMIN_MENU_HOWTO = (
    "Чтобы обновить меню на сегодня — просто пришлите мне сюда пост, как для "
    "публикации: одну или несколько фотографий с подписью. Я сохраню всё как "
    "есть и покажу клиентам ровно в этом виде."
)
ADMIN_MENU_SAVED = "Меню сохранено ✓ Покажу его клиентам, как прислали."

ADMIN_ASK_MENU_DATE = (
    "На какое число это меню?\n\n"
    "Можно нажать кнопку, или прислать дату вручную в формате ДД.ММ.ГГГГ."
)
ADMIN_DATE_TODAY_BTN = "Сегодня, {date}"
ADMIN_DATE_TOMORROW_BTN = "Завтра, {date}"
ADMIN_MENU_DATE_SAVED = "Дата меню: {date} ✓"
ADMIN_ACTIVE_MENU_DATE = "Сейчас активно меню на {date}."

ADMIN_ASK_TODAY_GARNISH = (
    "Какие гарниры сегодня доступны? Напишите через запятую (например: пюре, гречка)."
)
ADMIN_GARNISH_SAVED = "Гарниры на сегодня сохранены ✓ Сегодня доступно: {list}"
ADMIN_GARNISH_CLEARED = "Ок, гарниров на сегодня не задано — покажу клиентам общий список из Справочников."

ADMIN_DEBTORS_EMPTY = "Долгов нет — приятная новость 🪴"
ADMIN_DEBTORS_HEADER = "Текущие долги:"

ADMIN_MORNING_HEADER = "☘️ Доброе утро! Отчёты на сегодня готовы."

ADMIN_CARD_PAYMENT_ALERT = (
    "💳 Оплата картой — скрин на проверку\n\n"
    "Клиент: {name} (ID {client_id})\n"
    "Заказ: {items}\n"
    "Сумма: {sum} сум"
)
ADMIN_CARD_CONFIRMED_SUFFIX = "\n\n✅ Оплата подтверждена"
ADMIN_CARD_CONFIRMED_TOAST = "Отмечено ✓"

ADMIN_CLUB_PANEL_BTN = "🌿 Pause Club"
ADMIN_CLUB_INFO_BTN = "📝 Текст о клубе"
ADMIN_CLUB_INFO_PROMPT = "Пришлите новый текст о клубе — он покажется, когда розыгрыша нет."
ADMIN_CLUB_INFO_SAVED = "Текст о клубе сохранён ✓"
ADMIN_GIVEAWAY_BTN = "🎁 Розыгрыш"
ADMIN_GIVEAWAY_PROMPT = (
    "Пришлите текст розыгрыша — клиенты увидят его и кнопку «Участвовать».\n"
    "Чтобы выключить текущий розыгрыш без нового текста — напишите «выключить»."
)
ADMIN_GIVEAWAY_SAVED = "Розыгрыш опубликован ✓"
ADMIN_GIVEAWAY_OFF = "Розыгрыш выключен ✓"
ADMIN_GIVEAWAY_OFF_WORDS = {"выключить", "выключи", "нет", "стоп", "off"}

ADMIN_KITCHEN_PDF_CAPTION = "📄 PDF-отчёт для кухни — {date}"
ADMIN_NO_ORDERS_TODAY = "На сегодня заказов нет."
ADMIN_NO_ORDERS_FOR_DATE = "Заказов на {date} нет."

ADMIN_ASK_REPORT_DATE = "За какую дату показать отчёт?"
ADMIN_NO_RECENT_ORDERS = "Заказов пока нет."
ADMIN_BAD_DATE_FORMAT = "Не понял дату — пришлите в формате ДД.ММ.ГГГГ, например 25.08.2026."

ADMIN_NO_PAYMENTS_FOR_DATE = "Скринов оплаты за {date} нет."
ADMIN_PAYMENTS_HEADER = "💳 Скрины оплаты за {date} — {count} шт.:"
ADMIN_PAYMENT_ITEM_CAPTION = "{name} — {sum} сум"
ADMIN_PAYMENT_SEND_FAILED = "⚠️ Не удалось отправить скрин {name} (строка {row}): {error}"

ADMIN_COMMANDS_LIST = (
    "Доступные команды:\n"
    "/admin — панель администратора (это меню)\n"
    "/kitchen — текстовый отчёт для кухни\n"
    "/kitchen_pdf — PDF-отчёт для кухни\n"
    "/courier — отчёт для курьера\n"
    "/payments — скрины оплаты за дату (без даты — за сегодня)\n"
    "/giveaway — запустить или обновить розыгрыш\n"
    "/giveaway_finish — завершить текущий розыгрыш\n"
    "/giveaway_today — участники сегодняшней «Паузы в подарок»"
)

CARE_LINES = [
    "Пусть сегодняшний обед будет самым спокойным моментом дня.",
    "Ты не обязан(а) быть продуктивным(ой) во время паузы.",
    "Немного тепла — на удачу до вечера.",
]

# --- Рассылки клиентам ---
MORNING_GREETING = "Здравствуйте, {name} 🌿 Позвольте позаботиться о вашем желудке ☺️💫"
NEW_MENU_GREETING = (
    "Здравствуйте, {name} 🌿 Меню на сегодня уже готово — "
    "придумали кое-что тёплое специально для вас ✨"
)
MENU_BROADCAST_BTN = "💌 Посмотреть меню"

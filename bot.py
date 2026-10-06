# -*- coding: utf-8 -*-
import asyncio
import logging
import random

from aiogram import Bot, Dispatcher
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import BotCommand, BotCommandScopeDefault, BotCommandScopeChat
from apscheduler.schedulers.asyncio import AsyncIOScheduler

import config
import sheets
import texts
import keyboards as kb
import webapp
import pauseapp
from handlers import start, order, profile, club, admin

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pause_bot")


async def send_morning_reports(bot: Bot):
    if not config.ADMIN_IDS:
        return
    date_str = sheets.get_active_menu_date()
    try:
        kitchen = sheets.build_kitchen_report(date_str)
        courier = sheets.build_courier_report(date_str)
    except Exception as e:
        logger.exception("Не удалось построить утренний отчёт: %s", e)
        return
    # Каждому админу — отдельно, один недоступный/заблокировавший бота не
    # должен обрывать отчёт остальным (тот же приём, что и в клиентских
    # рассылках, см. send_warm_broadcast).
    for admin_id in config.ADMIN_IDS:
        try:
            await bot.send_message(admin_id, texts.ADMIN_MORNING_HEADER)
            await bot.send_message(admin_id, kitchen or texts.ADMIN_NO_ORDERS_TODAY)
            if courier:
                await bot.send_message(admin_id, courier)
            await admin.send_kitchen_pdf(bot, admin_id, date_str)
        except Exception:
            logger.exception("Не удалось отправить утренний отчёт админу ID %s", admin_id)


async def send_debt_reminders(bot: Bot):
    """Напоминания "Должники → Напоминание" из PAUSE App (Операционный
    центр), которые должны сработать сегодня — см. sheets.
    get_due_debt_reminders/set_debt_reminder. Одна напоминалка — одно
    сообщение каждому админу, сразу помечаем отправленной (mark_debt_
    reminder_sent), чтобы не прислать второй раз завтра."""
    if not config.ADMIN_IDS:
        return
    date_str = sheets.today_date_str()
    try:
        due = sheets.get_due_debt_reminders(date_str)
    except Exception:
        logger.exception("Не удалось получить напоминания по должникам на %s", date_str)
        return
    for r in due:
        text = texts.ADMIN_DEBT_REMINDER.format(name=r["name"])
        if r["note"]:
            text += f"\n{r['note']}"
        for admin_id in config.ADMIN_IDS:
            try:
                await bot.send_message(admin_id, text)
            except Exception:
                logger.exception("Не удалось отправить напоминание о должнике админу ID %s", admin_id)
        try:
            sheets.mark_debt_reminder_sent(r["row"])
        except Exception:
            logger.exception("Не удалось отметить напоминание отправленным (row=%s)", r["row"])


async def send_warm_broadcast(bot: Bot):
    """Ежедневная тёплая рассылка всем зарегистрированным клиентам —
    персональное приветствие по имени + общая фраза дня. Тем, кто уже
    сделал заказ на сегодня (дату активного меню), рассылка не идёт —
    незачем звать заказывать того, кто уже заказал."""
    if sheets.is_broadcasts_disabled():
        return
    clients = sheets.get_broadcast_clients()
    if not clients:
        return
    tickets = sheets.get_client_ticket_counts(sheets.get_active_menu_date())
    line = random.choice(texts.CARE_LINES)
    for c in clients:
        if tickets.get(str(c.get("id")), 0) > 0:
            continue
        if c.get("notify_morning_off"):
            continue
        try:
            greeting = texts.MORNING_GREETING.format(name=c.get("name") or "")
            await bot.send_message(int(c["tg_id"]), f"{greeting}\n\n{line}")
        except Exception:
            logger.exception("Не удалось отправить тёплое утреннее сообщение клиенту ID %s", c.get("id"))
        await asyncio.sleep(config.BROADCAST_DELAY_SECONDS)


async def send_payment_reminders(bot: Bot):
    """Мягкое напоминание в PAYMENT_REMINDER_TIME — тем, кто выбрал оплату
    картой "пришлю скрин позже" по сегодняшнему (активному) заказу и так и
    не прислал его к этому моменту (статус "🕊 Ожидает скрин" в "Мои
    заказы"). Кнопка ведёт к тому же механизму прикрепления скрина, что и
    в "Мои заказы"."""
    if sheets.is_broadcasts_disabled():
        return
    date_str = sheets.get_active_menu_date()
    groups = sheets.get_unconfirmed_card_orders(date_str)
    for g in groups:
        rows_str = ",".join(str(r) for r in g["rows"])
        name = (g.get("name") or "").strip()
        try:
            await bot.send_message(
                int(g["tg_id"]), texts.PAYMENT_REMINDER_TEXT.format(name=f", {name}" if name else ""),
                reply_markup=kb.pay_today_kb() if config.WEBAPP_URL else kb.reminder_screenshot_kb(rows_str),
            )
        except Exception:
            logger.exception("Не удалось отправить напоминание об оплате клиенту ID %s", g.get("client_id"))
        await asyncio.sleep(config.BROADCAST_DELAY_SECONDS)


async def setup_commands(bot: Bot):
    # Для обычных клиентов выпадающее меню команд (кнопка "/" у поля ввода)
    # убрано полностью — интерфейс только на кнопках внутри переписки.
    # /start при этом продолжает работать как обычно, если набрать его
    # текстом вручную — delete_my_commands убирает только пункт из этого
    # меню, а не саму команду (её ловит отдельный CommandStart() фильтр
    # в handlers/start.py, никак не связанный со списком команд).
    await bot.delete_my_commands(scope=BotCommandScopeDefault())
    if config.ADMIN_IDS:
        # Всё, кроме /start и /admin, теперь доступно кнопками внутри самой
        # панели /admin — остальные команды (kitchen, courier, payments,
        # broadcasts_*, giveaway_today) по-прежнему работают, если набрать
        # их текстом, просто больше не загромождают меню "/".
        admin_commands = [
            BotCommand(command="start", description="Начать / открыть главное меню"),
            BotCommand(command="admin", description="Панель администратора"),
        ]
        for admin_id in config.ADMIN_IDS:
            try:
                await bot.set_my_commands(admin_commands, scope=BotCommandScopeChat(chat_id=admin_id))
            except Exception:
                logger.exception("Не удалось задать список команд для админа ID %s", admin_id)


async def main():
    if not config.BOT_TOKEN:
        raise SystemExit("BOT_TOKEN не задан — заполните .env (см. .env.example)")

    # Без HTML-режима по умолчанию: в текстах бота нет разметки, а свободный
    # текст от клиентов и координатора (комментарии, подпись к меню) может
    # содержать символы вроде "<" или "&", которые сломали бы HTML-парсинг.
    bot = Bot(token=config.BOT_TOKEN)
    dp = Dispatcher(storage=MemoryStorage())

    dp.include_router(start.router)
    dp.include_router(order.router)
    dp.include_router(profile.router)
    dp.include_router(club.router)
    dp.include_router(admin.router)

    await setup_commands(bot)

    scheduler = AsyncIOScheduler(timezone="Asia/Tashkent")
    h, m = map(int, config.MORNING_REPORT_TIME.split(":"))
    scheduler.add_job(send_morning_reports, "cron", hour=h, minute=m, args=[bot])
    scheduler.add_job(send_debt_reminders, "cron", hour=h, minute=m, args=[bot])
    wh, wm = map(int, config.WARM_BROADCAST_TIME.split(":"))
    scheduler.add_job(send_warm_broadcast, "cron", hour=wh, minute=wm, args=[bot])
    prh, prm = map(int, config.PAYMENT_REMINDER_TIME.split(":"))
    scheduler.add_job(send_payment_reminders, "cron", hour=prh, minute=prm, args=[bot])
    # "Пауза в подарок" в PAUSE App (видимый всем пул, см. pauseapp.py) —
    # отдельная от старой ручной механики бота (club.router, не трогаем)
    # ежедневная автоматика.
    gh, gm = map(int, config.GIVEAWAY_DRAW_TIME.split(":"))
    scheduler.add_job(pauseapp.run_daily_giveaway_draw, "cron", hour=gh, minute=gm, args=[bot])
    scheduler.start()

    # PAUSE App (новый клиентский Mini App, пока только для админов) живёт
    # в том же aiohttp-процессе, что и Mini App "Маршрут" — подмонтирован
    # отдельным subapp'ом под /pauseapp, маршруты курьерского приложения
    # этим не затрагиваются (см. webapp.run_webapp/pauseapp.py).
    await webapp.run_webapp(bot, extra_subapps={"/pauseapp": pauseapp.create_app(bot)})

    logger.info("PAUSE бот запущен.")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())

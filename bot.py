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
from handlers import start, order, profile, club, admin, survey

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pause_bot")


async def send_morning_reports(bot: Bot):
    if not config.ADMIN_CHAT_ID:
        return
    date_str = sheets.get_active_menu_date()
    try:
        kitchen = sheets.build_kitchen_report(date_str)
        courier = sheets.build_courier_report(date_str)
        await bot.send_message(config.ADMIN_CHAT_ID, texts.ADMIN_MORNING_HEADER)
        await bot.send_message(config.ADMIN_CHAT_ID, kitchen or texts.ADMIN_NO_ORDERS_TODAY)
        if courier:
            await bot.send_message(config.ADMIN_CHAT_ID, courier)
        await admin.send_kitchen_pdf(bot, config.ADMIN_CHAT_ID, date_str)
    except Exception as e:
        logger.exception("Не удалось отправить утренний отчёт: %s", e)


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
        try:
            await bot.send_message(
                int(g["tg_id"]), texts.PAYMENT_REMINDER_TEXT,
                reply_markup=kb.reminder_screenshot_kb(rows_str),
            )
        except Exception:
            logger.exception("Не удалось отправить напоминание об оплате клиенту ID %s", g.get("client_id"))
        await asyncio.sleep(config.BROADCAST_DELAY_SECONDS)


async def setup_commands(bot: Bot):
    await bot.set_my_commands(
        [BotCommand(command="start", description="Начать / открыть главное меню")],
        scope=BotCommandScopeDefault(),
    )
    if config.ADMIN_CHAT_ID:
        admin_commands = [
            BotCommand(command="admin", description="Панель администратора"),
            BotCommand(command="kitchen", description="Текстовый отчёт для кухни"),
            BotCommand(command="kitchen_pdf", description="PDF-отчёт для кухни"),
            BotCommand(command="courier", description="Отчёт для курьера"),
            BotCommand(command="payments", description="Скрины оплаты за дату"),
            BotCommand(command="giveaway", description="Запустить/обновить розыгрыш"),
            BotCommand(command="giveaway_finish", description="Завершить текущий розыгрыш"),
            BotCommand(command="giveaway_today", description="Участники «Паузы в подарок» сегодня"),
            BotCommand(command="giveaway_close", description="Закрыть приём участников вручную"),
            BotCommand(command="broadcasts_off", description="Выключить автоматические рассылки клиентам"),
            BotCommand(command="broadcasts_on", description="Включить автоматические рассылки клиентам"),
            BotCommand(command="broadcasts_status", description="Статус автоматических рассылок"),
            BotCommand(command="menu_survey", description="Разослать разовый опрос о меню"),
            BotCommand(command="menu_survey_results", description="Результаты опроса о меню"),
        ]
        try:
            await bot.set_my_commands(admin_commands, scope=BotCommandScopeChat(chat_id=config.ADMIN_CHAT_ID))
        except Exception:
            logger.exception("Не удалось задать список команд для админа")


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
    dp.include_router(survey.router)

    await setup_commands(bot)

    scheduler = AsyncIOScheduler(timezone="Asia/Tashkent")
    h, m = map(int, config.MORNING_REPORT_TIME.split(":"))
    scheduler.add_job(send_morning_reports, "cron", hour=h, minute=m, args=[bot])
    wh, wm = map(int, config.WARM_BROADCAST_TIME.split(":"))
    scheduler.add_job(send_warm_broadcast, "cron", hour=wh, minute=wm, args=[bot])
    prh, prm = map(int, config.PAYMENT_REMINDER_TIME.split(":"))
    scheduler.add_job(send_payment_reminders, "cron", hour=prh, minute=prm, args=[bot])
    scheduler.start()

    await webapp.run_webapp()

    logger.info("PAUSE бот запущен.")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())

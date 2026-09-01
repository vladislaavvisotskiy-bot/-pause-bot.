# -*- coding: utf-8 -*-
import asyncio
import logging
import datetime as dt

from aiogram import Bot, Dispatcher
from aiogram.fsm.storage.memory import MemoryStorage
from apscheduler.schedulers.asyncio import AsyncIOScheduler

import config
import sheets
import texts
from handlers import start, order, profile, club, admin

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pause_bot")


async def send_morning_reports(bot: Bot):
    if not config.ADMIN_CHAT_ID:
        return
    date_str = dt.datetime.now().strftime("%d.%m.%Y")
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

    scheduler = AsyncIOScheduler(timezone="Asia/Tashkent")
    h, m = map(int, config.MORNING_REPORT_TIME.split(":"))
    scheduler.add_job(send_morning_reports, "cron", hour=h, minute=m, args=[bot])
    scheduler.start()

    logger.info("PAUSE бот запущен.")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())

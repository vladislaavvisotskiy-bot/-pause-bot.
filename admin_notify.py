# -*- coding: utf-8 -*-
"""Рассылка push-уведомлений ВСЕМ администраторам из config.ADMIN_IDS —
общая точка для всех мест, где раньше уведомление уходило одному
config.ADMIN_CHAT_ID (новая точка на подтверждение, скрин оплаты, отмена
заказа, обратная связь и т.п.). Один недоступный/заблокировавший бота
админ не должен обрывать отправку остальным — тот же приём, что и в
клиентских рассылках (см. bot.py: send_warm_broadcast)."""
import logging

import config

logger = logging.getLogger("pause_bot")


async def notify_admins(bot, text: str, reply_markup=None):
    for admin_id in config.ADMIN_IDS:
        try:
            await bot.send_message(admin_id, text, reply_markup=reply_markup)
        except Exception:
            logger.exception("Не удалось отправить админ-уведомление ID %s", admin_id)


async def notify_admins_photo(bot, photo, caption: str, reply_markup=None):
    for admin_id in config.ADMIN_IDS:
        try:
            await bot.send_photo(admin_id, photo, caption=caption, reply_markup=reply_markup)
        except Exception:
            logger.exception("Не удалось отправить админ-уведомление (фото) ID %s", admin_id)

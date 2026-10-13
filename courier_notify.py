# -*- coding: utf-8 -*-
"""Оповещения клиентам «курьер рядом»: «вы следующие» (курьер сдал предыдущую
точку) и «подъезжаю» (курьер нажал кнопку). Только тем, у кого есть заказ на
эту точку в этот день, с Telegram и не отключившим оповещение; каждому — не
чаще одного раза каждого вида в день."""
import asyncio
import logging

from aiogram.exceptions import TelegramRetryAfter, TelegramForbiddenError, TelegramBadRequest

import config
import sheets
import texts
from webapp import _retry_sheets

logger = logging.getLogger("pause_bot")

KIND_NEXT = "next"
KIND_ARRIVING = "arriving"


async def notify_point(bot, date_str: str, point_data: dict, kind: str) -> int:
    """Возвращает, сколько клиентов получили сообщение."""
    if not point_data or await _retry_sheets(sheets.is_courier_notify_disabled):
        return 0
    clients = {str(c["id"]): c for c in await _retry_sheets(sheets.get_broadcast_clients)}
    log = await _retry_sheets(sheets.get_courier_near_log, date_str)
    sent_entries, sent = [], 0
    for p in point_data.get("people", []):
        cid = str(p.get("client_id") or "").strip()
        c = clients.get(cid)
        if not c or c.get("notify_courier_off"):
            continue
        if (cid, kind) in log:
            continue
        # «Вы следующие» после «подъезжаю» уже не нужно.
        if kind == KIND_NEXT and (cid, KIND_ARRIVING) in log:
            continue
        nm = (c.get("name") or "").strip()
        if kind == KIND_ARRIVING:
            text = (texts.COURIER_ARRIVING_TEXT.format(name=nm) if nm else texts.COURIER_ARRIVING_TEXT_NONAME)
        else:
            text = (texts.COURIER_NEXT_TEXT.format(name=nm) if nm else texts.COURIER_NEXT_TEXT_NONAME)
        for attempt in range(2):
            try:
                await bot.send_message(int(c["tg_id"]), text)
                sent += 1
                sent_entries.append((cid, kind))
                break
            except TelegramRetryAfter as e:
                await asyncio.sleep(float(e.retry_after) + 1)
            except (TelegramForbiddenError, TelegramBadRequest):
                sent_entries.append((cid, kind))  # не доставить — не пытаемся снова
                break
            except Exception:
                logger.exception("Оповещение «курьер рядом»: ошибка отправки клиенту %s", cid)
                break
        await asyncio.sleep(0.1)
    try:
        await _retry_sheets(sheets.add_courier_near_log, date_str, point_data.get("point", ""), sent_entries)
    except Exception:
        logger.exception("Оповещение «курьер рядом»: не удалось записать журнал")
    return sent

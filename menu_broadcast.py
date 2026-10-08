# -*- coding: utf-8 -*-
"""Рассылка клиентам "новое меню готово". Запускается автоматически при
публикации меню (бот и Операционный центр) и вручную (Операционный центр →
Рассылка). Безопасно для Telegram: ~10 сообщений/с, ожидание при flood-лимите,
заблокировавших бота и отключивших оповещения о меню пропускаем, каждый
человек получает сообщение один раз. Итог (сколько получили / не получили)
приходит админу в бот."""
import asyncio
import logging

from aiogram.exceptions import TelegramRetryAfter, TelegramForbiddenError, TelegramBadRequest

import config
import sheets
import texts
import keyboards as kb
from webapp import _retry_sheets

logger = logging.getLogger("pause_bot")

state = {"running": False, "date": "", "total": 0, "sent": 0, "failed": 0, "blocked": 0, "skipped_off": 0, "done_at": ""}
_tasks = set()


def when_label(date_str: str) -> str:
    if date_str == sheets.today_date_str():
        return "на сегодня"
    if date_str == sheets.get_tomorrow_date_str():
        return "на завтра"
    return "на " + date_str


async def _notify_admins(bot, admin_id, text: str):
    ids = [admin_id] if admin_id else list(config.ADMIN_IDS)
    for a in ids:
        try:
            await bot.send_message(int(a), text)
        except Exception:
            logger.exception("Рассылка меню: не удалось отправить итог админу %s", a)


async def run(bot, date_str: str, admin_id):
    st = state
    try:
        clients = await _retry_sheets(sheets.get_broadcast_clients)
        seen, targets, skipped_off = set(), [], 0
        for c in clients:
            tid = str(c.get("tg_id") or "").strip()
            if not tid or tid in seen:
                continue
            seen.add(tid)
            if c.get("notify_menu_off"):
                skipped_off += 1
                continue
            targets.append(c)
        st.update(total=len(targets), sent=0, failed=0, blocked=0, skipped_off=skipped_off)
        when = when_label(date_str)
        delay = max(config.BROADCAST_DELAY_SECONDS, 0.08)
        for c in targets:
            nm = (c.get("name") or "").strip()
            text = (texts.APP_MENU_BROADCAST_TEXT.format(name=nm, when=when) if nm
                    else texts.APP_MENU_BROADCAST_TEXT_NONAME.format(when=when))
            for attempt in range(3):
                try:
                    await bot.send_message(int(c["tg_id"]), text, reply_markup=kb.menu_broadcast_kb())
                    st["sent"] += 1
                    break
                except TelegramRetryAfter as e:
                    await asyncio.sleep(float(e.retry_after) + 1)
                except TelegramForbiddenError:
                    st["blocked"] += 1
                    st["failed"] += 1
                    break
                except TelegramBadRequest:
                    st["failed"] += 1
                    break
                except Exception:
                    logger.exception("Рассылка меню: ошибка отправки клиенту ID %s", c.get("id"))
                    if attempt == 2:
                        st["failed"] += 1
                    else:
                        await asyncio.sleep(2)
            await asyncio.sleep(delay)
        try:
            await _retry_sheets(sheets.log_menu_broadcast, date_str, st["total"], st["sent"], st["failed"], admin_id or "авто")
        except Exception:
            logger.exception("Рассылка меню: не удалось записать журнал")
        report = (f"Рассылка о меню {when} завершена.\n"
                  f"Получили: {st['sent']}\n"
                  f"Не получили: {st['failed']}"
                  + (f" (заблокировали бота: {st['blocked']})" if st["blocked"] else "") + "\n"
                  f"Отключили оповещения о меню (пропущены): {skipped_off}")
        await _notify_admins(bot, admin_id, report)
    except Exception:
        logger.exception("Рассылка меню: сбой")
        await _notify_admins(bot, admin_id, "Рассылка о меню остановилась из-за ошибки. Проверьте логи.")
    finally:
        st["running"] = False
        st["done_at"] = sheets.today_date_str()


async def start(bot, date_str: str, admin_id, force: bool = False) -> str:
    """Запускает рассылку в фоне. Возвращает: "started" | "running" |
    "disabled" (рассылки выключены в настройках) | "already_sent" (на эту дату
    уже рассылали — при автозапуске повторно не шлём)."""
    if state["running"]:
        return "running"
    if await _retry_sheets(sheets.is_broadcasts_disabled):
        return "disabled"
    if not force:
        log = await _retry_sheets(sheets.get_menu_broadcast_log, date_str)
        if log:
            return "already_sent"
    state.update(running=True, date=date_str, total=0, sent=0, failed=0, blocked=0, skipped_off=0)
    task = asyncio.ensure_future(run(bot, date_str, admin_id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return "started"

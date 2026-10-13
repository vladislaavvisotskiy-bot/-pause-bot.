# -*- coding: utf-8 -*-
"""Оповещения клиентам «курьер рядом»: «выехал» (кнопка «Поехали») и
«подъезжает» (кнопка «Подъезжаю»). Только тем, у кого есть заказ на эту точку в
этот день, с Telegram и не отключившим оповещение; каждому — не чаще одного раза
каждого вида в день. Ответ курьеру — сразу (кнопка не «висит»), отправка идёт в
фоне параллельно; отметка шага для интерфейса курьера пишется в журнал строкой
с клиентом "*"."""
import asyncio
import logging

from aiogram.exceptions import TelegramRetryAfter, TelegramForbiddenError, TelegramBadRequest

import sheets
import texts
from webapp import _retry_sheets

logger = logging.getLogger("pause_bot")

KIND_GOING = "going"
KIND_ARRIVING = "arriving"
STEP = "*"

_tasks = set()


def _text(kind: str, name: str) -> str:
    if kind == KIND_ARRIVING:
        return texts.COURIER_ARRIVING_TEXT.format(name=name) if name else texts.COURIER_ARRIVING_TEXT_NONAME
    return texts.COURIER_GOING_TEXT.format(name=name) if name else texts.COURIER_GOING_TEXT_NONAME


async def trigger(bot, date_str: str, point_data: dict, kind: str) -> dict:
    """Быстро: считает получателей и ставит рассылку в фон. Возвращает
    {"recipients": N, "time": "ЧЧ:ММ", "already": bool}."""
    now_hm = sheets._now().strftime("%H:%M")
    steps = await _retry_sheets(sheets.get_courier_steps, date_str)
    if kind in steps.get(point_data["point"], {}):
        return {"recipients": 0, "time": steps[point_data["point"]][kind], "already": True}
    disabled = await _retry_sheets(sheets.is_courier_notify_disabled)
    targets = []
    if not disabled:
        clients = {str(c["id"]): c for c in await _retry_sheets(sheets.get_broadcast_clients)}
        log = await _retry_sheets(sheets.get_courier_near_log, date_str)
        seen = set()
        for p in point_data.get("people", []):
            cid = str(p.get("client_id") or "").strip()
            c = clients.get(cid)
            if not c or cid in seen or c.get("notify_courier_off") or (cid, kind) in log:
                continue
            if kind == KIND_GOING and (cid, KIND_ARRIVING) in log:
                continue
            seen.add(cid)
            targets.append((cid, int(c["tg_id"]), _text(kind, (c.get("name") or "").strip())))
    task = asyncio.ensure_future(_deliver(bot, date_str, point_data["point"], kind, targets))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return {"recipients": len(targets), "time": now_hm, "already": False}


async def _deliver(bot, date_str: str, point: str, kind: str, targets: list):
    entries = [(STEP, kind)]  # шаг для интерфейса курьера — пишем всегда
    sem = asyncio.Semaphore(8)

    async def send(cid, tg_id, text):
        async with sem:
            for _ in range(2):
                try:
                    await bot.send_message(tg_id, text)
                    return (cid, kind)
                except TelegramRetryAfter as e:
                    await asyncio.sleep(float(e.retry_after) + 1)
                except (TelegramForbiddenError, TelegramBadRequest):
                    return (cid, kind)  # не доставить — повторно не пытаемся
                except Exception:
                    logger.exception("Оповещение «курьер рядом»: ошибка отправки клиенту %s", cid)
                    return None
        return None

    try:
        results = await asyncio.gather(*[send(c, t, x) for c, t, x in targets])
        entries += [r for r in results if r]
        await _retry_sheets(sheets.add_courier_near_log, date_str, point, entries)
    except Exception:
        logger.exception("Оповещение «курьер рядом»: сбой")

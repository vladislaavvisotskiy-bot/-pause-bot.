# -*- coding: utf-8 -*-
"""Режим Mini App (config.MINIAPP_ONLY): любые старые кнопки и тексты в
чате у обычных клиентов отвечают тёплым сообщением о ребрендинге и кнопкой
в приложение. Админы (config.ADMIN_IDS) пользуются ботом как раньше.
Роутер подключается ПЕРВЫМ; регистрация (/start и шаги FSM) сюда не
попадает — у неё всегда выставлено состояние или это команда."""
import time

from aiogram import Router, F
from aiogram.filters import StateFilter
from aiogram.types import Message, CallbackQuery

import config
import texts
import keyboards as kb

router = Router()

_last_sent: dict = {}
_COOLDOWN = 8  # секунд — не засыпать сообщением того, кто жмёт кнопки подряд


def _is_client(user_id) -> bool:
    return config.MINIAPP_ONLY and user_id not in config.ADMIN_IDS


async def _rebrand(target: Message, user_id: int):
    now = time.time()
    if now - _last_sent.get(user_id, 0) < _COOLDOWN:
        return
    _last_sent[user_id] = now
    await target.answer(texts.REBRAND_TEXT, reply_markup=kb.open_pauseapp_kb())


@router.callback_query(lambda c: _is_client(c.from_user.id))
async def legacy_callback(callback: CallbackQuery):
    try:
        await callback.answer()
    except Exception:
        pass
    if callback.message:
        await _rebrand(callback.message, callback.from_user.id)


@router.message(
    StateFilter(None), F.chat.type == "private",
    lambda m: _is_client(m.from_user.id) and not (m.text or "").startswith("/"),
)
async def legacy_message(message: Message):
    await _rebrand(message, message.from_user.id)

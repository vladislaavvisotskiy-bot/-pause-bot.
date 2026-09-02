# -*- coding: utf-8 -*-
from aiogram import Router, F, Bot
from aiogram.types import CallbackQuery, Message, InputMediaPhoto
from aiogram.fsm.context import FSMContext

import sheets
import texts
import keyboards as kb
import config
from states import Order

router = Router()


def _require_client(callback_or_message):
    client = sheets.find_client_by_tg_id(callback_or_message.from_user.id)
    return client


def _is_card_payment(payment: str) -> bool:
    return "карт" in (payment or "").lower()


# ---------------------------------------------------------------------------
# Раздел «Меню» — показ меню на сегодня и сразу старт заказа
# ---------------------------------------------------------------------------

@router.callback_query(F.data == "menu_section")
async def menu_section(callback: CallbackQuery, state: FSMContext, bot: Bot):
    await state.clear()
    client = _require_client(callback)
    if not client:
        await callback.message.answer("Похоже, вы ещё не зарегистрированы — наберите /start")
        await callback.answer()
        return

    can_order = not sheets.is_after_cutoff()

    photo_ids, caption = sheets.get_today_menu_photos()
    if photo_ids:
        formatted = texts.format_menu_text(caption) if caption else None
        if len(photo_ids) == 1:
            await callback.message.answer_photo(
                photo_ids[0], caption=formatted or None,
                parse_mode="HTML" if formatted else None,
            )
        else:
            media = [
                InputMediaPhoto(
                    media=pid,
                    caption=(formatted if i == 0 else None),
                    parse_mode=("HTML" if i == 0 and formatted else None),
                )
                for i, pid in enumerate(photo_ids)
            ]
            await bot.send_media_group(callback.message.chat.id, media)
    else:
        await callback.message.answer(texts.NO_MENU_YET)

    if not can_order:
        await callback.message.answer(texts.CUTOFF_CLOSED_NOTICE, reply_markup=kb.home_only_kb())
        await callback.answer()
        return

    # Меню показали — сразу в заказ, без промежуточного «Готовы заказать?».
    await state.update_data(client_id=client["id"], client_row=client["row"],
                             client_name=client["name"], client_phone=client["contact"],
                             client_zone=client.get("zone", ""), client_point=client.get("point", ""),
                             cart=[])
    await _ask_set(callback.message, state)
    await callback.answer()


async def _ask_set(message: Message, state: FSMContext):
    data = await state.get_data()
    back = bool(data.get("cart"))
    sets = sheets.get_sets()
    await message.answer(texts.CHOOSE_SET, reply_markup=kb.set_kb(sets, back=back))
    await state.set_state(Order.choosing_set)


async def _back_to_asking_more(message: Message, state: FSMContext):
    await message.answer(texts.ASK_MORE, reply_markup=kb.yes_no_kb("add_more", "done_adding"))
    await state.set_state(Order.asking_more)


@router.callback_query(Order.choosing_set, F.data.startswith("set:"))
async def chosen_set(callback: CallbackQuery, state: FSMContext):
    set_name = callback.data.split(":", 1)[1]

    if set_name == "__back__":
        await _back_to_asking_more(callback.message, state)
        await callback.answer()
        return

    await state.update_data(cur_set=set_name)

    if set_name.strip().lower() == "сет стандарт":
        # Гарниры, реально доступные сегодня (задаёт админ после публикации
        # меню); если ещё не заданы — берём общий справочник, чтобы не
        # оставить клиента без вариантов.
        garnishes = sheets.get_today_garnishes() or sheets.get_garnishes()
        await state.update_data(garnish_options=garnishes)
        await callback.message.answer(texts.CHOOSE_GARNISH, reply_markup=kb.garnish_kb(garnishes, back=True))
        await state.set_state(Order.choosing_garnish)
    else:
        await state.update_data(cur_garnish="")
        await callback.message.answer(texts.ASK_QTY, reply_markup=kb.qty_kb())
        await state.set_state(Order.choosing_qty)
    await callback.answer()


@router.callback_query(Order.choosing_garnish, F.data.startswith("garnish:"))
async def chosen_garnish(callback: CallbackQuery, state: FSMContext):
    value = callback.data.split(":", 1)[1]

    if value == "__back__":
        await _ask_set(callback.message, state)
        await callback.answer()
        return

    if value == "__mix__":
        data = await state.get_data()
        options = data.get("garnish_options", [])
        await callback.message.answer(
            texts.CHOOSE_GARNISH_MIX1,
            reply_markup=kb.options_kb(options, "gmix1", back=True, display=texts.display_garnish),
        )
        await state.set_state(Order.choosing_garnish_mix1)
        await callback.answer()
        return

    await state.update_data(cur_garnish=value)
    await callback.message.answer(texts.ASK_QTY, reply_markup=kb.qty_kb())
    await state.set_state(Order.choosing_qty)
    await callback.answer()


@router.callback_query(Order.choosing_garnish_mix1, F.data.startswith("gmix1:"))
async def chosen_garnish_mix1(callback: CallbackQuery, state: FSMContext):
    g1 = callback.data.split(":", 1)[1]
    data = await state.get_data()

    if g1 == "__back__":
        garnishes = data.get("garnish_options", [])
        await callback.message.answer(texts.CHOOSE_GARNISH, reply_markup=kb.garnish_kb(garnishes, back=True))
        await state.set_state(Order.choosing_garnish)
        await callback.answer()
        return

    options = [g for g in data.get("garnish_options", []) if g != g1]
    await state.update_data(mix_g1=g1)
    await callback.message.answer(
        texts.CHOOSE_GARNISH_MIX2,
        reply_markup=kb.options_kb(options, "gmix2", back=True, display=texts.display_garnish),
    )
    await state.set_state(Order.choosing_garnish_mix2)
    await callback.answer()


@router.callback_query(Order.choosing_garnish_mix2, F.data.startswith("gmix2:"))
async def chosen_garnish_mix2(callback: CallbackQuery, state: FSMContext):
    g2 = callback.data.split(":", 1)[1]
    data = await state.get_data()
    g1 = data.get("mix_g1", "")

    if g2 == "__back__":
        options = [g for g in data.get("garnish_options", []) if g != g1]
        await callback.message.answer(
            texts.CHOOSE_GARNISH_MIX1,
            reply_markup=kb.options_kb(options, "gmix1", back=True, display=texts.display_garnish),
        )
        await state.set_state(Order.choosing_garnish_mix1)
        await callback.answer()
        return

    mixed = f"{g1}/{g2} 50/50"
    await state.update_data(cur_garnish=mixed)
    await callback.message.answer(texts.ASK_QTY, reply_markup=kb.qty_kb())
    await state.set_state(Order.choosing_qty)
    await callback.answer()


@router.callback_query(Order.choosing_qty, F.data.startswith("qty:"))
async def chosen_qty(callback: CallbackQuery, state: FSMContext):
    value = callback.data.split(":", 1)[1]

    if value == "__back__":
        data = await state.get_data()
        if (data.get("cur_set") or "").strip().lower() == "сет стандарт":
            garnishes = data.get("garnish_options", [])
            await callback.message.answer(texts.CHOOSE_GARNISH, reply_markup=kb.garnish_kb(garnishes, back=True))
            await state.set_state(Order.choosing_garnish)
        else:
            await _ask_set(callback.message, state)
        await callback.answer()
        return

    qty = int(value)
    data = await state.get_data()
    cart = data.get("cart", [])
    cart.append({
        "set": data["cur_set"],
        "garnish": data.get("cur_garnish", ""),
        "qty": qty,
    })
    await state.update_data(cart=cart, cur_set=None, cur_garnish=None)

    await callback.message.answer(texts.ASK_MORE, reply_markup=kb.yes_no_kb("add_more", "done_adding"))
    await state.set_state(Order.asking_more)
    await callback.answer()


@router.callback_query(Order.asking_more, F.data == "add_more")
async def add_more(callback: CallbackQuery, state: FSMContext):
    await _ask_set(callback.message, state)
    await callback.answer()


@router.callback_query(Order.asking_more, F.data == "done_adding")
async def done_adding(callback: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    zone = data.get("client_zone", "")
    point = data.get("client_point", "")
    if zone and point:
        await callback.message.answer(
            texts.DEFAULT_POINT_ASK.format(zone=zone, point=point),
            reply_markup=kb.default_point_kb(),
        )
        await state.set_state(Order.asking_default_point)
    else:
        await _ask_zone(callback.message, state, from_default=False)
    await callback.answer()


async def _ask_zone(message: Message, state: FSMContext, from_default: bool = None):
    # from_default запоминает, откуда пришли на этот шаг — нужно, чтобы
    # кнопка «Назад» отсюда вернула на правильный предыдущий экран
    # (к вопросу "как обычно?" или к "добавить ещё один сет?"). None — не
    # меняем то, что уже сохранено (используется при возврате со «Точки»).
    if from_default is not None:
        await state.update_data(zone_back_target="default_point" if from_default else "asking_more")
    zones = sheets.get_zones()
    await message.answer(texts.CHOOSE_ZONE, reply_markup=kb.options_kb(zones, "zone", back=True))
    await state.set_state(Order.choosing_zone)


@router.callback_query(Order.asking_default_point, F.data == "default_point_yes")
async def default_point_yes(callback: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    await state.update_data(
        cur_zone=data.get("client_zone", ""),
        cur_point=data.get("client_point", ""),
        is_new_point=False,
    )
    await _ask_clarification(callback.message, state, "default_point")
    await callback.answer()


@router.callback_query(Order.asking_default_point, F.data == "default_point_change")
async def default_point_change(callback: CallbackQuery, state: FSMContext):
    await _ask_zone(callback.message, state, from_default=True)
    await callback.answer()


# ---------------------------------------------------------------------------
# Точка доставки
# ---------------------------------------------------------------------------

@router.callback_query(Order.choosing_zone, F.data.startswith("zone:"))
async def chosen_zone(callback: CallbackQuery, state: FSMContext):
    zone = callback.data.split(":", 1)[1]

    if zone == "__back__":
        data = await state.get_data()
        if data.get("zone_back_target") == "default_point":
            await callback.message.answer(
                texts.DEFAULT_POINT_ASK.format(
                    zone=data.get("client_zone", ""), point=data.get("client_point", "")
                ),
                reply_markup=kb.default_point_kb(),
            )
            await state.set_state(Order.asking_default_point)
        else:
            await _back_to_asking_more(callback.message, state)
        await callback.answer()
        return

    await state.update_data(cur_zone=zone)
    await _ask_point(callback.message, state, zone)
    await callback.answer()


async def _ask_point(message: Message, state: FSMContext, zone: str):
    points = sheets.get_points(zone)
    if points:
        await message.answer(texts.CHOOSE_POINT,
                              reply_markup=kb.options_kb(points, "point", other=True, back=True))
        await state.set_state(Order.choosing_point)
    else:
        await state.update_data(clarify_back_target="zone")
        await message.answer(texts.ASK_NEW_POINT)
        await state.set_state(Order.entering_new_point)


@router.callback_query(Order.choosing_point, F.data.startswith("point:"))
async def chosen_point(callback: CallbackQuery, state: FSMContext):
    point = callback.data.split(":", 1)[1]

    if point == "__back__":
        await _ask_zone(callback.message, state)
        await callback.answer()
        return

    if point == "__other__":
        await state.update_data(clarify_back_target="point")
        await callback.message.answer(texts.ASK_NEW_POINT)
        await state.set_state(Order.entering_new_point)
        await callback.answer()
        return

    await state.update_data(cur_point=point, is_new_point=False)
    await _ask_clarification(callback.message, state, "point")
    await callback.answer()


@router.message(Order.entering_new_point)
async def entered_new_point(message: Message, state: FSMContext):
    point = (message.text or "").strip()
    if not point:
        await message.answer(texts.ASK_NEW_POINT)
        return
    await state.update_data(cur_point=point, is_new_point=True)
    await _ask_clarification(message, state)


# ---------------------------------------------------------------------------
# Уточнение и оплата
# ---------------------------------------------------------------------------

async def _ask_clarification(message: Message, state: FSMContext, back_target: str = None):
    # back_target запоминает, куда вернуть по «Назад» отсюда — на выбор
    # точки, района (если у района вообще нет точек) или на вопрос
    # "доставить как обычно?". None — не меняем то, что уже сохранено
    # (используется, когда уточнение показывается после ввода нового
    # адреса свободным текстом — там back_target уже выставлен раньше).
    if back_target is not None:
        await state.update_data(clarify_back_target=back_target)
    await message.answer(texts.ASK_CLARIFICATION, reply_markup=kb.skip_kb(back=True))
    await state.set_state(Order.entering_clarification)


@router.callback_query(Order.entering_clarification, F.data == "clarify:__back__")
async def clarification_back(callback: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    target = data.get("clarify_back_target", "point")
    if target == "default_point":
        await callback.message.answer(
            texts.DEFAULT_POINT_ASK.format(
                zone=data.get("client_zone", ""), point=data.get("client_point", "")
            ),
            reply_markup=kb.default_point_kb(),
        )
        await state.set_state(Order.asking_default_point)
    elif target == "zone":
        await _ask_zone(callback.message, state)
    else:
        await _ask_point(callback.message, state, data.get("cur_zone", ""))
    await callback.answer()


@router.callback_query(Order.entering_clarification, F.data == "clarify:skip")
async def skip_clarification(callback: CallbackQuery, state: FSMContext):
    await state.update_data(cur_comment="")
    await _ask_payment(callback.message, state)
    await callback.answer()


@router.message(Order.entering_clarification)
async def got_clarification(message: Message, state: FSMContext):
    await state.update_data(cur_comment=(message.text or "").strip())
    await _ask_payment(message, state)


async def _ask_payment(message: Message, state: FSMContext):
    # Клиент выбирает только между наличными и картой — "В долг" ставится
    # вручную в таблице, самостоятельно клиент этот вариант не выбирает.
    options = [o for o in sheets.get_payment_options() if "долг" not in o.lower()]
    await message.answer(texts.CHOOSE_PAYMENT, reply_markup=kb.options_kb(options, "payment", home=False))
    await state.set_state(Order.choosing_payment)


@router.callback_query(Order.choosing_payment, F.data.startswith("payment:"))
async def chosen_payment(callback: CallbackQuery, state: FSMContext):
    payment = callback.data.split(":", 1)[1]
    await state.update_data(cur_payment=payment, card_screenshot=None, card_status="")

    if _is_card_payment(payment):
        await callback.message.answer(texts.CARD_REQUISITES_MSG.format(requisites=texts.REQUISITES_TEXT))
        await callback.message.answer(texts.CARD_PAYMENT_ASK, reply_markup=kb.card_payment_kb())
        await state.set_state(Order.card_decision)
    else:
        await _show_summary(callback.message, state)
        await state.set_state(Order.confirming)
    await callback.answer()


@router.callback_query(Order.card_decision, F.data == "card_decision_back")
async def card_decision_back(callback: CallbackQuery, state: FSMContext):
    await _ask_payment(callback.message, state)
    await callback.answer()


@router.callback_query(Order.card_decision, F.data == "card_now")
async def card_now(callback: CallbackQuery, state: FSMContext):
    await callback.message.answer(texts.CARD_SEND_SCREENSHOT)
    await state.set_state(Order.waiting_card_screenshot)
    await callback.answer()


@router.callback_query(Order.card_decision, F.data == "card_later")
async def card_later(callback: CallbackQuery, state: FSMContext):
    await state.update_data(card_status="не подтверждена")
    await _show_summary(callback.message, state)
    await state.set_state(Order.confirming)
    await callback.answer()


@router.message(Order.waiting_card_screenshot, F.photo)
async def card_screenshot_received(message: Message, state: FSMContext):
    file_id = message.photo[-1].file_id
    await state.update_data(card_screenshot=file_id, card_status="на проверке")
    await message.answer(texts.CARD_SCREENSHOT_RECEIVED)
    await _show_summary(message, state)
    await state.set_state(Order.confirming)


@router.message(Order.waiting_card_screenshot)
async def card_screenshot_not_photo(message: Message):
    await message.answer(texts.CARD_SCREENSHOT_EXPECTED)


async def _show_summary(message: Message, state: FSMContext):
    data = await state.get_data()
    cart = data.get("cart", [])
    prices = sheets.get_set_prices()

    lines = [texts.ORDER_SUMMARY_HEADER, ""]
    total = 0
    for item in cart:
        price = prices.get(item["set"], 0)
        sub = price * item["qty"]
        total += sub
        line = f"• {item['qty']}× {texts.display_set_name(item['set'])}"
        if item["garnish"]:
            line += f" ({texts.display_garnish(item['garnish'])})"
        line += f" — {sub:,} сум".replace(",", " ")
        lines.append(line)

    lines.append("")
    lines.append(f"Итого: {total:,} сум".replace(",", " "))
    lines.append(f"Куда: {data.get('cur_zone', '')}, {data.get('cur_point', '')}")
    if data.get("cur_comment"):
        lines.append(f"Комментарий: {data['cur_comment']}")
    lines.append(f"Оплата: {data.get('cur_payment', '')}")

    card_status = data.get("card_status", "")
    if card_status == "на проверке":
        lines.append(texts.ORDER_PAYMENT_STATUS_CHECKING)
    elif card_status == "не подтверждена":
        lines.append(texts.ORDER_PAYMENT_STATUS_LATER)

    await message.answer("\n".join(lines), reply_markup=kb.confirm_order_kb())


def _order_comment(data: dict) -> str:
    base_comment = data.get("cur_comment", "")
    card_status = data.get("card_status", "")
    marker = ""
    if card_status == "на проверке":
        marker = "оплата на проверке"
    elif card_status == "не подтверждена":
        marker = "оплата не подтверждена"
    return " | ".join(p for p in [base_comment, marker] if p)


@router.callback_query(Order.confirming, F.data == "order_confirm")
async def confirm_order(callback: CallbackQuery, state: FSMContext, bot: Bot):
    data = await state.get_data()
    cart = data.get("cart", [])
    date_str = sheets.get_active_menu_date()
    full_comment = _order_comment(data)

    # Новая точка через «Другое» — заказ придерживаем до подтверждения
    # координатором, в «Заказы» (и отчёты кухни/курьера) пока не попадает.
    if data.get("is_new_point"):
        pending_id = sheets.create_pending_order(
            date_str=date_str,
            zone=data["cur_zone"],
            point=data["cur_point"],
            client_id=data["client_id"],
            client_name=data.get("client_name", ""),
            client_phone=data.get("client_phone", ""),
            cart=cart,
            payment=data["cur_payment"],
            comment=full_comment,
            screenshot=data.get("card_screenshot") or "",
        )

        if config.ADMIN_CHAT_ID:
            try:
                prices = sheets.get_set_prices()
                total = sum(prices.get(i["set"], 0) * i["qty"] for i in cart)
                items_text = ", ".join(
                    f"{i['qty']}× {texts.display_set_name(i['set'])}" + (f" ({i['garnish']})" if i["garnish"] else "")
                    for i in cart
                )
                alert = texts.ADMIN_PENDING_POINT_ALERT.format(
                    name=data.get("client_name", ""),
                    client_id=data.get("client_id", ""),
                    zone=data["cur_zone"],
                    point=data["cur_point"],
                    items=items_text,
                    sum=f"{total:,}".replace(",", " "),
                    payment=data["cur_payment"],
                )
                markup = kb.pending_point_admin_kb(pending_id)
                screenshot = data.get("card_screenshot")
                if screenshot:
                    alert += texts.ADMIN_PENDING_SCREENSHOT_NOTE
                    await bot.send_photo(config.ADMIN_CHAT_ID, screenshot, caption=alert, reply_markup=markup)
                else:
                    await bot.send_message(config.ADMIN_CHAT_ID, alert, reply_markup=markup)
            except Exception:
                pass

        await state.clear()
        await callback.message.answer(texts.ORDER_PENDING_NEW_POINT.format(support=texts.SUPPORT_USERNAME))
        await callback.message.answer(texts.MAIN_MENU, reply_markup=kb.main_menu_kb())
        await callback.answer()
        return

    row_nums = []
    for item in cart:
        row_num = sheets.append_order(
            date_str=date_str,
            zone=data["cur_zone"],
            point=data["cur_point"],
            client_id=data["client_id"],
            set_name=item["set"],
            qty=item["qty"],
            garnish=item["garnish"],
            payment=data["cur_payment"],
            comment=full_comment,
        )
        row_nums.append(row_num)

    # точка уже известна (по умолчанию или выбрана из списка) — пересохраняем
    # как текущую точку по умолчанию клиента
    if data.get("cur_zone") and data.get("cur_point"):
        try:
            sheets.update_client_point(data["client_row"], data["cur_zone"], data["cur_point"])
        except Exception:
            pass

    # скрин оплаты картой — отправляем админу на подтверждение
    screenshot = data.get("card_screenshot")
    if screenshot and config.ADMIN_CHAT_ID:
        try:
            prices = sheets.get_set_prices()
            total = sum(prices.get(i["set"], 0) * i["qty"] for i in cart)
            items_text = ", ".join(
                f"{i['qty']}× {texts.display_set_name(i['set'])}" + (f" ({i['garnish']})" if i["garnish"] else "")
                for i in cart
            )
            caption = texts.ADMIN_CARD_PAYMENT_ALERT.format(
                name=data.get("client_name", ""),
                client_id=data.get("client_id", ""),
                items=items_text,
                sum=f"{total:,}".replace(",", " "),
            )
            rows_str = ",".join(str(r) for r in row_nums)
            await bot.send_photo(
                config.ADMIN_CHAT_ID, screenshot, caption=caption,
                reply_markup=kb.card_confirm_admin_kb(rows_str),
            )
        except Exception:
            pass

    await state.clear()
    await callback.message.answer(texts.ORDER_SENT)
    await callback.message.answer(texts.MAIN_MENU, reply_markup=kb.main_menu_kb())
    await callback.answer()


@router.callback_query(Order.confirming, F.data == "order_cancel")
async def cancel_order(callback: CallbackQuery, state: FSMContext):
    await state.clear()
    await callback.message.answer(texts.ORDER_CANCELLED)
    await callback.message.answer(texts.MAIN_MENU, reply_markup=kb.main_menu_kb())
    await callback.answer()

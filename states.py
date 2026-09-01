# -*- coding: utf-8 -*-
from aiogram.fsm.state import State, StatesGroup


class Registration(StatesGroup):
    waiting_name = State()
    waiting_phone = State()


class Order(StatesGroup):
    choosing_set = State()
    choosing_garnish = State()
    choosing_garnish_mix1 = State()
    choosing_garnish_mix2 = State()
    choosing_qty = State()
    asking_more = State()
    choosing_zone = State()
    choosing_point = State()
    entering_new_point = State()
    entering_clarification = State()
    choosing_payment = State()
    card_decision = State()
    waiting_card_screenshot = State()
    confirming = State()


class EditProfile(StatesGroup):
    waiting_name = State()
    waiting_phone = State()
    choosing_zone = State()
    choosing_point = State()
    entering_new_point = State()


class Feedback(StatesGroup):
    waiting_text = State()

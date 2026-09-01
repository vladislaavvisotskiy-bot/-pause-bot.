# -*- coding: utf-8 -*-
"""
Сборка PDF-версии отчёта для кухни — те же данные, что и в текстовом
/kitchen, но оформленные как документ и сгруппированные по направлениям
(локациям), чтобы удобнее было собирать заказы по районам.

Шрифт — DejaVu Sans (лежит в папке fonts/), потому что стандартные PDF-
шрифты кириллицу не показывают.
"""
from fpdf import FPDF

import config
import sheets


def build_kitchen_report_pdf(date_str: str) -> bytes:
    orders = sheets.get_orders_for_date(date_str)

    totals = {}
    total = 0
    by_zone = {}
    zone_order = []
    for o in orders:
        qty = int(o["qty"]) if o["qty"].isdigit() else 0
        total += qty
        totals[o["set"]] = totals.get(o["set"], 0) + qty
        zone = o["zone"] or "Без направления"
        if zone not in by_zone:
            by_zone[zone] = []
            zone_order.append(zone)
        by_zone[zone].append(o)

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()
    pdf.add_font("DejaVu", "", config.PDF_FONT_REGULAR)
    pdf.add_font("DejaVu", "B", config.PDF_FONT_BOLD)

    pdf.set_font("DejaVu", "B", 16)
    pdf.cell(0, 10, f"Информация для кухни — {date_str}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    pdf.set_font("DejaVu", "B", 12)
    pdf.cell(0, 8, f"Всего сетов: {total}", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("DejaVu", "", 11)
    for set_name, count in totals.items():
        pdf.cell(0, 6, f"    {count} — {set_name}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(6)

    col_widths = (42, 50, 16, 42, 40)
    headers = ("Имя", "Сет", "Кол-во", "Гарнир", "Комментарий")
    row_h = 7

    def table_header():
        pdf.set_font("DejaVu", "B", 10)
        pdf.set_fill_color(230, 236, 224)
        for w, h in zip(col_widths, headers):
            pdf.cell(w, row_h, h, border=1, fill=True)
        pdf.ln(row_h)

    for zone in zone_order:
        pdf.set_font("DejaVu", "B", 13)
        pdf.set_fill_color(210, 221, 199)
        pdf.cell(0, 9, zone, new_x="LMARGIN", new_y="NEXT", fill=True)
        table_header()

        pdf.set_font("DejaVu", "", 9)
        for o in by_zone[zone]:
            values = (
                _clip(o["name"], 22),
                _clip(o["set"], 26),
                o["qty"],
                _clip(o["garnish"] or "—", 22),
                _clip(o["comment"] or "", 24),
            )
            for w, v in zip(col_widths, values):
                pdf.cell(w, row_h, v, border=1)
            pdf.ln(row_h)
        pdf.ln(5)

    if not orders:
        pdf.set_font("DejaVu", "", 12)
        pdf.cell(0, 8, "На эту дату заказов нет.", new_x="LMARGIN", new_y="NEXT")

    return bytes(pdf.output())


def _clip(text: str, max_len: int) -> str:
    text = text or ""
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "…"

# -*- coding: utf-8 -*-
"""
Сборка PDF-версии отчёта для кухни — те же данные, что и в текстовом
/kitchen, но оформленные как документ и сгруппированные по направлениям
(локациям), чтобы удобнее было собирать заказы по районам.

Шрифт — DejaVu Sans (лежит в папке fonts/), потому что стандартные PDF-
шрифты кириллицу не показывают.
"""
from fpdf import FPDF
from fpdf.fonts import FontFace

import config
import sheets


def build_kitchen_report_pdf(date_str: str) -> bytes:
    items = sheets.get_kitchen_line_items(date_str)

    totals = {}
    total = 0
    # По направлению, а внутри направления — по клиенту: несколько позиций
    # одного клиента за день объединяются в одну строку под одним именем,
    # той же группировкой (по имени, с готовым "piece" на позицию), что и в
    # текстовом /kitchen (sheets.build_kitchen_report) — раньше здесь была
    # отдельная, менее полная логика вообще без группировки по клиенту, и
    # один человек с несколькими сетами показывался несколькими строками с
    # повторяющимся именем.
    by_zone = {}
    zone_order = []
    for o in items:
        qty = int(o["qty"]) if o["qty"].isdigit() else 0
        total += qty
        totals[o["set"]] = totals.get(o["set"], 0) + qty
        zone = o["zone"] or "Без направления"
        if zone not in by_zone:
            by_zone[zone] = {}
            zone_order.append(zone)
        clients_in_zone = by_zone[zone]
        if o["name"] not in clients_in_zone:
            clients_in_zone[o["name"]] = {"pieces": [], "comments": []}
        clients_in_zone[o["name"]]["pieces"].append(o["piece"])
        if o["comment"]:
            clients_in_zone[o["name"]]["comments"].append(o["comment"])

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

    col_widths = (45, 105, 40)
    headers = ("Имя", "Позиции", "Комментарий")

    # fpdf2's table() wraps long text to fit each column's width and grows
    # the row to fit however many lines that takes (word-wrap, not
    # truncation) — everything after a tall row is pushed down automatically,
    # and the table itself breaks across pages cleanly when it runs out of
    # room. The old code used fixed-height pdf.cell() + a hand-rolled clip()
    # that just cut long comments off with "…" instead of wrapping them.
    for zone in zone_order:
        pdf.set_font("DejaVu", "B", 13)
        pdf.set_fill_color(210, 221, 199)
        pdf.cell(0, 9, zone, new_x="LMARGIN", new_y="NEXT", fill=True)

        pdf.set_font("DejaVu", "", 9)
        with pdf.table(
            col_widths=col_widths,
            text_align="LEFT",
            headings_style=FontFace(emphasis="B", fill_color=(230, 236, 224)),
            line_height=5,
        ) as table:
            table.row(headers)
            for name, data in by_zone[zone].items():
                row = table.row()
                row.cell(name)
                row.cell(" ".join(data["pieces"]))
                row.cell("; ".join(data["comments"]))
        pdf.ln(5)

    if not items:
        pdf.set_font("DejaVu", "", 12)
        pdf.cell(0, 8, "На эту дату заказов нет.", new_x="LMARGIN", new_y="NEXT")

    return bytes(pdf.output())

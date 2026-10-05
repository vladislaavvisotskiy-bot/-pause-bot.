#!/usr/bin/env python3
"""Одноразовый фикс: превращает "Кол-во" (столбец H листа "Заказы") из
текста в настоящие числа во всех существующих строках заказов.

Зачем: до фикса в sheets.py (append_order/append_orders_batch) количество
писалось str()'ом, из-за чего "Кол-во Заказов" в Sheet1 (формула SUMIF по
этому столбцу) не считало уже оформленные заказы — SUMIF молча
пропускает текстовые ячейки при суммировании, даже если они выглядят как
число. Подробности — в докстринге sheets.migrate_order_qty_to_numbers().

Запускать там, где у бота есть реальный доступ к Google Таблице (то есть
настроены переменные окружения GOOGLE_CREDENTIALS_JSON/GOOGLE_SHEET_ID —
обычно в том же окружении, где обычно запускается сам бот). НЕ запускать
в песочнице без реальных credentials — там просто не подключится к
таблице и упадёт с ошибкой.

Запуск:
    python3 scripts/fix_order_qty.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sheets  # noqa: E402


def main():
    print("Читаю лист \"Заказы\" и чиню столбец \"Кол-во\"...")
    result = sheets.migrate_order_qty_to_numbers()
    print()
    print("Готово.")
    print(f"  Исправлено ячеек:        {result['fixed']}")
    print(f"  Пропущено (пустые):      {result['skipped_blank']}")
    print(f"  Пропущено (не похоже на число): {result['skipped_not_numeric']}")
    print(f"  Всего просмотрено строк: {result['rows_scanned']}")
    print()
    print("Теперь столбец O в Sheet1 (\"Кол-во Заказов\") должен показывать")
    print("правильные числа по всей истории заказов.")


if __name__ == "__main__":
    main()

"""Выгрузка выбранных людей: только данные организации, ячейки без формул."""

from collections.abc import Sequence
from decimal import Decimal, InvalidOperation
from io import BytesIO
from typing import Any

from fastapi import HTTPException
from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from app.schemas.personnel import PersonnelExportInput


def text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Да" if value else "Нет"
    return str(value) if isinstance(value, (str, int, float)) else ""


def export_people(data: dict[str, Any], payload: PersonnelExportInput) -> bytes:
    people = {person["id"]: person for person in data["employees"]}
    ids = [str(id) for id in payload.employee_ids]
    columns = {col["id"]: col for col in data["source_columns"]}
    if any(id not in people for id in ids) or any(
        id not in columns for group in payload.columns for id in group
    ):
        raise HTTPException(404, "Сотрудник или столбец не найден")
    selected = [[columns[id] for id in group] for group in payload.columns]
    dormitories = {d["id"]: d["name"] for d in data["dormitories"]}
    headers = ["ФИО", "Табельный номер", "Проживание", "Период вахты", "Статус", "Телефон"]
    headers.extend(f"{group[0]['source_name']} · {group[0]['name']}" for group in selected)
    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    sheet.title = "Сотрудники"

    def append(values: Sequence[str | float]) -> None:
        sheet.append([None] * len(values))
        for index, value in enumerate(values, 1):
            cell = sheet.cell(sheet.max_row, index)
            cell.value = (
                ILLEGAL_CHARACTERS_RE.sub("", value)[:32767] if isinstance(value, str) else value
            )
            # ФИО, телефоны, табельные номера и пользовательский текст — литералы.
            if isinstance(value, str):
                cell.data_type = "s"
            cell.alignment = Alignment(vertical="top", wrap_text=True)

    append([payload.name])
    sheet.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(headers))
    sheet.cell(1, 1).font = Font(size=16, bold=True, color="27313D")
    sheet.row_dimensions[1].height = 30
    append(headers)
    for cell in sheet[2]:
        cell.font = Font(bold=True, color="27313D")
        cell.fill = PatternFill("solid", fgColor="DCEEE4")
    for id in ids:
        person = people[id]
        current = person["current"]
        residence = "\n".join(
            f"{dormitories.get(source['dormitory_id'], '')} · "
            f"{source['values'].get('hostel_name') or 'Место не указано'}"
            for source in current
        )
        periods = "\n".join(
            f"{source['values'].get('shift_start') or '—'} — "
            f"{source['values'].get('shift_end') or '—'}"
            for source in current
        )
        row: list[str | float] = [
            person["full_name"] or "ФИО не указано",
            person["personnel_number"] or "",
            residence or "Сейчас не проживает",
            periods,
            "Проживает" if current else "Вне общежитий",
            person["phone"] or "",
        ]
        for group in selected:
            values: list[str] = []
            for source in person["sources"]:
                for col in group:
                    if (col["dormitory_id"], col["table_key"]) != (
                        source["dormitory_id"],
                        source["table_key"],
                    ):
                        continue
                    source_values = source["values"]
                    raw = (
                        source_values.get(col["builtin_key"])
                        if col["builtin_key"]
                        else (source_values.get("custom_values") or {}).get(str(col["id"]))
                    )
                    value = text(raw)
                    if col["kind"] == "select":
                        value = next(
                            (option["label"] for option in col["options"] if option["id"] == value),
                            value,
                        )
                    if value and value not in values:
                        values.append(value)
            number: Decimal | None = None
            if group[0]["kind"] == "number" and len(values) == 1:
                try:
                    candidate = Decimal(values[0].replace(",", "."))
                    if candidate.is_finite() and abs(candidate) <= Decimal("1e300"):
                        number = candidate
                except InvalidOperation:
                    pass
            row.append(float(number) if number is not None else " · ".join(values))
        append(row)
    sheet.freeze_panes = "A3"
    sheet.auto_filter.ref = f"A2:{get_column_letter(len(headers))}{sheet.max_row}"
    sheet.sheet_view.showGridLines = False
    for index in range(1, len(headers) + 1):
        sheet.column_dimensions[get_column_letter(index)].width = 34 if index in (1, 3, 4) else 24
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()

"""Excel по текущей схеме таблицы. Проверка файла целиком предшествует записи."""

import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from io import BytesIO
from typing import Any
from zipfile import ZipFile
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from openpyxl import Workbook, load_workbook
from openpyxl.comments import Comment
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.cell_fill import FillResolver, choose_record
from app.custom_tab_options import options_for
from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.dormitory_history import DormitoryDataEvent
from app.models.hostel import Hostel, HostelCell
from app.models.inflow import PersonnelInflow
from app.models.outflow import PersonnelOutflow
from app.models.report import ReportCell, ReportRow
from app.models.resident import Resident
from app.models.table_column import ArchiveEntry, TableColumn
from app.outflow_fields import sync_outflow_cell
from app.personnel import record_changed
from app.place_values import active_in_month, place_day_values
from app.places_import import FIELD_LABELS
from app.resident_identity import ENTRY_ROLES, compatible, entry_fields
from app.schemas.inflow import UpdateInflowRequest
from app.schemas.outflow import UpdateOutflowRequest
from app.schemas.payment import UpdatePaymentRequest
from app.schemas.resident import UpdateResidentRequest
from app.section_state import SECTIONS, require_section
from app.table_data import (
    TABLE_MODELS,
    Record,
    ensure_columns,
    get_custom_tab,
    normalize_value,
    record_value,
    records_for,
    require_writable_table,
)

MAX_BYTES = 20 * 1024 * 1024
MAX_ROWS = 10_000
MAX_COLUMNS = 512
MAX_CELLS = 500_000
TEMPLATE_ERROR = (
    "Нужно заполнить данные строго по шаблону. "
    "Скачайте актуальный шаблон этой вкладки и перенесите в него данные."
)
SHEETS = ["Данные", "Инструкция", "_Схема"]


@dataclass
class ExchangeColumn:
    name: str
    kind: str = "text"
    column: TableColumn | None = None
    day: date | None = None


@dataclass
class ExchangeTable:
    db: Session
    dormitory: Dormitory
    key: str
    name: str
    columns: list[ExchangeColumn]
    schema: dict[str, Any]
    tab: CustomTab | None = None
    # У календарных отчётов строки и подписи фиксированы, меняются только пустые ячейки.
    grid: list[tuple[Any, list[Any]]] | None = None
    resolver: FillResolver | None = None
    entry_columns: dict[str, int] = field(default_factory=dict)

    def fingerprint(self) -> str:
        return hashlib.sha256(
            json.dumps(self.schema, ensure_ascii=False, sort_keys=True, default=str).encode()
        ).hexdigest()


def exchange_options(dorm: Dormitory, key: str, tab: CustomTab | None) -> dict[str, bool]:
    if tab:
        options = options_for(tab)
        return {"import_enabled": options.import_enabled, "export_enabled": options.export_enabled}
    return {
        "import_enabled": True,
        "export_enabled": True,
        **(dorm.exchange_options or {}).get(key, {}),
    }


def prepare_table(
    db: Session, dorm: Dormitory, key: str, start: date | None, end: date | None, *, importing: bool
) -> ExchangeTable:
    tab = None
    if key.startswith("custom_") and key[7:].isdecimal():
        tab = get_custom_tab(db, dorm.id, int(key[7:]), require_active=importing)
        if tab.kind != "archive" and not tab.table_created:
            raise HTTPException(409, "Сначала создайте таблицу во вкладке")
    elif key not in SECTIONS or key in {"movement", "payments"}:
        raise HTTPException(404, "Таблица не найдена")
    else:
        require_section(db, dorm.id, key, writable=importing)
    if not exchange_options(dorm, key, tab)["import_enabled" if importing else "export_enabled"]:
        raise HTTPException(
            409,
            "Импорт отключён в настройках вкладки"
            if importing
            else "Экспорт отключён в настройках вкладки",
        )
    if importing:
        require_writable_table(db, dorm.id, key)
    if (start is None) != (end is None) or (
        start
        and end
        and (start > end or (end - start).days > 365 or start.year < 2 or end.year > 9998)
    ):
        raise HTTPException(422, "Выберите период от 1 до 366 дней")
    calendar = bool(tab and options_for(tab).table_format == "calendar")
    if (key in {"report", "places"} or calendar) and (start is None or end is None):
        raise HTTPException(422, "Выберите период для шаблона")
    table = ExchangeTable(
        db,
        dorm,
        key,
        tab.name if tab else SECTIONS[key],
        [],
        {"version": 1, "dormitory": dorm.id, "table": key},
        tab=tab,
    )
    if tab and tab.kind == "archive":
        table.columns = [ExchangeColumn(name) for name in ("Дата", "Действие", "Автор")]
        return table
    if key == "report":
        rows = list(
            db.scalars(
                select(ReportRow)
                .where(ReportRow.dormitory_id == dorm.id)
                .order_by(ReportRow.position, ReportRow.id)
            )
        )
        table.columns = [ExchangeColumn("Показатель")]
        table.grid = [(row, [row.name]) for row in rows]
        table.schema["rows"] = [
            {"id": row.id, "name": row.name, "formula": row.formula, "link": row.link}
            for row in rows
        ]
    elif key == "places":
        assert start and end
        if start.replace(day=1) != end.replace(day=1):
            raise HTTPException(422, "Для размещения персонала выберите один месяц")
        hostels = [
            hostel
            for hostel in db.scalars(
                select(Hostel).where(Hostel.dormitory_id == dorm.id).order_by(Hostel.id)
            )
            if active_in_month(hostel, start.replace(day=1))
        ]
        table.columns = [ExchangeColumn("Хостел"), ExchangeColumn("Показатель")]
        table.grid = [
            ((hostel, metric), [hostel.name, label])
            for hostel in hostels
            for metric, label in FIELD_LABELS.items()
        ]
        table.schema["hostels"] = [{"id": hostel.id, "name": hostel.name} for hostel in hostels]
    else:
        columns = [
            col
            for col in ensure_columns(db, dorm.id, key)
            if not col.archived and col.kind != "action"
        ]
        table.columns = [ExchangeColumn(col.name, col.kind, col) for col in columns]
        table.resolver = FillResolver(db, dorm.id)
        table.schema["columns"] = [
            {
                "id": col.id,
                "name": col.name,
                "kind": col.kind,
                "options": col.options,
                "fill": col.fill,
            }
            for col in columns
        ]
        if key == "residents":
            table.entry_columns = entry_fields(db, dorm.id, columns)
            defaults = {
                col.builtin_key: col.id
                for col in columns
                if col.builtin_key in ENTRY_ROLES and compatible(col, col.builtin_key)
            }
            # Обычные шаблоны сохраняют прежний формат. Изменённое назначение
            # пользовательских столбцов входит в подпись актуального шаблона.
            if table.entry_columns != defaults:
                table.schema["identity_columns"] = table.entry_columns
            by_id = {col.id: col for col in columns}
            if importing and any(
                column_id not in by_id or not compatible(by_id[column_id], role)
                for role, column_id in table.entry_columns.items()
            ):
                raise HTTPException(
                    409,
                    "Сначала выберите действующие столбцы ФИО и телефона в окне добавления строки",
                )
        if tab:
            options = options_for(tab)
            table.schema["format"] = options.table_format
            table.schema["date_column_id"] = options.date_column_id
    if key in {"report", "places"} or calendar:
        assert start and end
        table.schema["period"] = [start.isoformat(), end.isoformat()]
        table.columns += [
            ExchangeColumn(
                day.strftime("%d.%m.%Y"),
                "number" if key in {"report", "places"} else "text",
                day=day,
            )
            for day in (start + timedelta(days=i) for i in range((end - start).days + 1))
        ]
    if not table.columns:
        raise HTTPException(409, "Добавьте хотя бы один столбец данных")
    if len(table.columns) > MAX_COLUMNS:
        raise HTTPException(422, f"В Excel поддерживается до {MAX_COLUMNS} столбцов")
    return table


def display_value(table: ExchangeTable, row: Record, col: ExchangeColumn) -> Any:
    assert col.column
    value = record_value(row, col.column, table.resolver)
    if col.kind == "select":
        return next((opt["label"] for opt in col.column.options if opt["id"] == value), value)
    if col.kind == "hostel":
        hostel = table.db.get(Hostel, value) if value else None
        return hostel.name if hostel and hostel.dormitory_id == table.dormitory.id else None
    if col.kind == "checkbox" and value is not None:
        return "Да" if value else "Нет"
    return value


def export_rows(
    table: ExchangeTable, start: date | None, end: date | None, user: Any
) -> list[list[Any]]:
    db, key, dorm = table.db, table.key, table.dormitory
    if table.tab and table.tab.kind == "archive":
        query = select(DormitoryDataEvent).where(
            DormitoryDataEvent.dormitory_id == dorm.id,
            DormitoryDataEvent.organization_id == dorm.organization_id,
        )
        if start and end:
            zone = ZoneInfo("Europe/Moscow")
            query = query.where(
                DormitoryDataEvent.created_at
                >= datetime.combine(start, time.min, zone).astimezone(UTC),
                DormitoryDataEvent.created_at
                < datetime.combine(end + timedelta(days=1), time.min, zone).astimezone(UTC),
            )
        return [
            [
                (
                    row.created_at.replace(tzinfo=UTC)
                    if row.created_at.tzinfo is None
                    else row.created_at
                )
                .astimezone(ZoneInfo("Europe/Moscow"))
                .strftime("%d.%m.%Y %H:%M:%S"),
                row.action,
                row.actor_name,
            ]
            for row in db.scalars(
                query.order_by(DormitoryDataEvent.created_at.desc(), DormitoryDataEvent.id.desc())
            )
        ]
    days = [col.day for col in table.columns if col.day]
    if key == "report":
        from app.api.reports import read_report

        assert start and end
        report = read_report(dorm.id, user, db, start, end, dorm)
        return [
            [
                row.name,
                *[row.errors.get(day.isoformat(), row.values.get(day.isoformat())) for day in days],
            ]
            for row in report.rows
        ]
    if key == "places":
        assert table.grid is not None
        hostels = {item[0][0].id: item[0][0] for item in table.grid}
        raw: dict[tuple[int, date], dict[str, int]] = {}
        for cell in db.scalars(
            select(HostelCell).where(
                HostelCell.hostel_id.in_(hostels), HostelCell.report_date.in_(days)
            )
        ):
            raw.setdefault((cell.hostel_id, cell.report_date), {})[cell.field] = cell.value
        # Расчётные показатели тоже попадают в экспорт, как на экране.
        labels: dict[str, str] = {
            **{str(metric): label for metric, label in FIELD_LABELS.items()},
            "residents_total": "Итого проживает М+Ж",
            "paid_total": "Итого оплачено М+Ж",
            "free_m": "Свободных мест М",
            "free_f": "Свободных мест Ж",
            "free_total": "Свободных мест М+Ж",
        }
        return [
            [
                hostel.name,
                label,
                *[place_day_values(raw.get((hostel.id, day), {})).get(metric) for day in days],
            ]
            for hostel in hostels.values()
            for metric, label in labels.items()
        ]
    rows = records_for(db, dorm.id, key)
    result = []
    for row in rows:
        result.append(
            [
                row.calendar_values.get(col.day.isoformat())
                if col.day and isinstance(row, CustomTabEntry)
                else display_value(table, row, col)
                for col in table.columns
            ]
        )
    return result


def write_cell(sheet: Any, row: int, column: int, value: Any) -> None:
    cell = sheet.cell(row, column, value)
    # Любой пользовательский текст, включая =..., остаётся текстом Excel.
    if isinstance(value, str):
        cell.data_type = "s"


def make_workbook(
    table: ExchangeTable, *, template: bool, rows: list[list[Any]] | None = None
) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    sheet.title = SHEETS[0]
    sheet.freeze_panes = "A2"
    for i, col in enumerate(table.columns, 1):
        write_cell(sheet, 1, i, col.name)
        cell = sheet.cell(1, i)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="264D43")
        sheet.column_dimensions[get_column_letter(i)].width = min(42, max(16, len(col.name) + 4))
        kind = {
            "text": "Текст",
            "number": "Число",
            "date": "Дата: ГГГГ-ММ-ДД или ДД.ММ.ГГГГ",
            "checkbox": "Да или Нет",
            "hostel": "Точное название хостела",
            "select": "Вариант списка",
        }.get(col.kind, col.kind)
        if col.column and col.column.fill:
            kind = (
                "Выбор записи по точному значению"
                if col.column.fill.get("mode") == "pick"
                else "Подставляется автоматически. Оставьте пустым."
            )
        if col.column and col.kind == "select":
            kind += ": " + "; ".join(
                str(opt["label"]) for opt in col.column.options if not opt["archived"]
            )
        cell.comment = Comment(kind, "Общежития")
        if template:
            for row_index in range(2, min(MAX_ROWS + 2, 202)):
                sheet.cell(row_index, i).number_format = (
                    "0.############" if col.kind == "number" else "@"
                )
    body = (
        [labels for _, labels in table.grid]
        if template and table.grid is not None
        else (rows or [])
    )
    for row_index, values in enumerate(body, 2):
        for col_index, value in enumerate(values, 1):
            write_cell(sheet, row_index, col_index, value)
    sheet.auto_filter.ref = f"A1:{get_column_letter(len(table.columns))}{max(1, len(body) + 1)}"
    if template:
        instruction = workbook.create_sheet(SHEETS[1])
        lines = [
            ["Как заполнить шаблон", table.name],
            [
                "1",
                "Заполняйте лист «Данные». Не меняйте названия, порядок "
                "и количество столбцов и листов.",
            ],
            [
                "2",
                "После изменения столбцов скачайте новый шаблон. "
                "Этот файл подходит только для исходной вкладки.",
            ],
            [
                "3",
                "Обычная таблица: каждая заполненная строка добавится к существующим. "
                "Пустые строки пропускаются.",
            ],
            [
                "4",
                "Отчёт и размещение: не меняйте подписи строк; заполняются только пустые ячейки. "
                "Сохранённые значения не заменяются.",
            ],
            [
                "5",
                "Формулы Excel запрещены. Даты: ГГГГ-ММ-ДД или ДД.ММ.ГГГГ. "
                "Чекбокс: Да/Нет. Списки: точные названия вариантов.",
            ],
            [
                "6",
                "Связанные значения подставляются автоматически: оставьте их пустыми. "
                "В столбцах выбора записи используйте точное уникальное значение источника.",
            ],
            [
                "7",
                "При любой ошибке весь файл отклоняется: "
                "исправьте указанные строки и загрузите его снова.",
            ],
        ]
        for index, col in enumerate(table.columns, 1):
            comment = sheet.cell(1, index).comment
            assert comment is not None
            lines.append([col.name, comment.text])
        for row_index, values in enumerate(lines, 1):
            for col_index, value in enumerate(values, 1):
                write_cell(instruction, row_index, col_index, value)
        instruction.column_dimensions["A"].width = 32
        instruction.column_dimensions["B"].width = 115
        meta = workbook.create_sheet(SHEETS[2])
        meta["A1"] = "dormitory-table-template-v1"
        meta["A2"] = table.fingerprint()
        meta.sheet_state = "veryHidden"
    stream = BytesIO()
    workbook.save(stream)
    workbook.close()
    return stream.getvalue()


def read_template(content: bytes, table: ExchangeTable) -> list[tuple[int, list[Any]]]:
    if not content or len(content) > MAX_BYTES:
        raise HTTPException(422, "Выберите файл .xlsx размером до 20 МБ")
    try:
        with ZipFile(BytesIO(content)) as archive:
            if (
                sum(item.file_size for item in archive.infolist()) > 100 * 1024 * 1024
                or len(archive.infolist()) > 2000
            ):
                raise ValueError
        workbook = load_workbook(
            BytesIO(content), read_only=True, data_only=False, keep_links=False
        )
    except Exception as exc:
        raise HTTPException(422, TEMPLATE_ERROR) from exc
    try:
        if workbook.sheetnames != SHEETS:
            raise HTTPException(422, TEMPLATE_ERROR)
        meta = workbook[SHEETS[2]]
        if (
            meta["A1"].value != "dormitory-table-template-v1"
            or meta["A2"].value != table.fingerprint()
        ):
            raise HTTPException(422, TEMPLATE_ERROR)
        sheet = workbook[SHEETS[0]]
        if (
            sheet.max_row is None
            or sheet.max_column is None
            or sheet.max_row > MAX_ROWS + 1
            or sheet.max_column != len(table.columns)
            or sheet.max_row * sheet.max_column > MAX_CELLS
        ):
            raise HTTPException(
                422, f"{TEMPLATE_ERROR} Не более {MAX_ROWS} строк и {MAX_CELLS} ячеек."
            )
        iterator = sheet.iter_rows()
        header = next(iterator)
        if [cell.value for cell in header] != [col.name for col in table.columns] or any(
            cell.data_type == "f" for cell in header
        ):
            raise HTTPException(422, TEMPLATE_ERROR)
        result = []
        for row_index, cells in enumerate(iterator, 2):
            if any(cell.data_type in {"f", "e"} for cell in cells):
                raise HTTPException(
                    422, f"{TEMPLATE_ERROR} Строка {row_index}: формулы и ошибки Excel недопустимы."
                )
            result.append((row_index, [cell.value for cell in cells]))
        return result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, TEMPLATE_ERROR) from exc
    finally:
        workbook.close()


def parse_value(table: ExchangeTable, col: ExchangeColumn, value: Any) -> Any:
    if value is None or value == "":
        return None
    column = col.column
    if col.kind == "checkbox":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.strip().casefold() in {"да", "нет"}:
            return value.strip().casefold() == "да"
        raise HTTPException(422, "Для чекбокса укажите Да или Нет")
    if col.kind == "date":
        if isinstance(value, datetime):
            if value.time() != time.min:
                raise HTTPException(422, "Укажите дату без времени")
            return value.date().isoformat()
        if isinstance(value, date):
            return value.isoformat()
        if isinstance(value, str):
            for fmt in ("%Y-%m-%d", "%d.%m.%Y"):
                try:
                    return datetime.strptime(value.strip(), fmt).date().isoformat()
                except ValueError:
                    continue
        raise HTTPException(422, "Укажите дату в формате ГГГГ-ММ-ДД или ДД.ММ.ГГГГ")
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise HTTPException(422, "Недопустимый тип значения")
    if col.kind == "number":
        return normalize_value(column or TableColumn(kind="number"), value)
    value = str(value).strip()
    if len(value) > (2000 if col.day else 5000) or "\x00" in value:
        raise HTTPException(422, "Текст слишком длинный или содержит недопустимый символ")
    if not value:
        return None
    if col.kind == "select" and column:
        matches = [opt for opt in column.options if opt["label"] == value and not opt["archived"]]
        if len(matches) != 1:
            raise HTTPException(422, "Выберите точное название действующего варианта списка")
        return matches[0]["id"]
    if col.kind == "hostel":
        hostels = list(
            table.db.scalars(
                select(Hostel).where(
                    Hostel.dormitory_id == table.dormitory.id, Hostel.name == value
                )
            )
        )
        month = datetime.now(ZoneInfo("Europe/Moscow")).date().replace(day=1)
        hostels = [hostel for hostel in hostels if active_in_month(hostel, month)]
        if len(hostels) != 1:
            raise HTTPException(
                422, "Укажите точное уникальное название хостела, действующего в текущем месяце"
            )
        return hostels[0].id
    return value


@dataclass
class ImportedRow:
    values: dict[str, Any] = field(default_factory=dict)
    builtin: dict[str, Any] = field(default_factory=dict)
    calendar: dict[str, str] = field(default_factory=dict)
    selections: list[tuple[TableColumn, str]] = field(default_factory=list)


def validate_rows(table: ExchangeTable, rows: list[tuple[int, list[Any]]]) -> list[ImportedRow]:
    result = []
    validators: dict[str, type[BaseModel]] = {
        "residents": UpdateResidentRequest,
        "inflow": UpdateInflowRequest,
        "outflow": UpdateOutflowRequest,
        "advance": UpdatePaymentRequest,
        "settlement": UpdatePaymentRequest,
    }
    for index, values in rows:
        if all(value is None or value == "" for value in values):
            continue
        parsed = ImportedRow()
        for col, raw in zip(table.columns, values, strict=True):
            try:
                if col.column and col.column.fill:
                    if raw is None or raw == "":
                        continue
                    fill = col.column.fill
                    if fill["mode"] != "pick":
                        raise HTTPException(
                            422, "Значение подставляется автоматически. Оставьте ячейку пустой"
                        )
                    assert table.resolver
                    requested = parse_value(table, col, raw)
                    matches = []
                    for identifier in table.resolver.source_records(fill["source"]):
                        candidate = table.resolver.read(fill["source"], identifier, fill["field"])
                        if candidate is not None and str(candidate) == str(requested):
                            matches.append(identifier)
                    if len(matches) != 1:
                        raise HTTPException(
                            422, "Значение должно однозначно совпадать с записью источника"
                        )
                    parsed.selections.append((col.column, matches[0]))
                    continue
                value = parse_value(table, col, raw)
                if col.day:
                    if value is not None:
                        parsed.calendar[col.day.isoformat()] = str(value)
                elif col.column and col.column.builtin_key:
                    parsed.builtin[col.column.builtin_key] = value
                elif col.column:
                    parsed.values[str(col.column.id)] = value
            except HTTPException as exc:
                raise HTTPException(
                    422, f"{TEMPLATE_ERROR} Строка {index}, столбец «{col.name}»: {exc.detail}"
                ) from exc
        if table.key in validators:
            if table.key == "residents":
                by_id = {col.column.id: col for col in table.columns if col.column}
                for role, column_id in table.entry_columns.items():
                    assigned = by_id[column_id]
                    assert assigned.column is not None
                    if assigned.column.builtin_key:
                        continue
                    key = str(column_id)
                    value = parsed.values.get(key)
                    builtin = parsed.builtin.get(role)
                    if value is not None and builtin is not None and value != builtin:
                        raise HTTPException(
                            422,
                            f"Строка {index}, столбец «{assigned.name}»: "
                            "указаны разные значения одного поля. "
                            f"Заполните назначенный столбец. {TEMPLATE_ERROR}",
                        )
                    if value is None:
                        value = builtin
                    if value is not None:
                        parsed.builtin[role] = value
                        parsed.values[key] = value
            try:
                parsed.builtin = (
                    validators[table.key]
                    .model_validate(parsed.builtin)
                    .model_dump(exclude_unset=True)
                )
            except ValidationError as exc:
                error = exc.errors(include_input=False)[0]
                field_name = str(error["loc"][0])
                selected_id = table.entry_columns.get(field_name)
                name = next(
                    (
                        col.name
                        for col in table.columns
                        if col.column and col.column.id == selected_id
                    ),
                    None,
                ) or next(
                    (
                        col.name
                        for col in table.columns
                        if col.column and col.column.builtin_key == field_name
                    ),
                    field_name,
                )
                raise HTTPException(
                    422, f"{TEMPLATE_ERROR} Строка {index}, столбец «{name}»: {error['msg']}"
                ) from exc
            if table.key == "residents":
                for role, column_id in table.entry_columns.items():
                    if str(column_id) in parsed.values and role in parsed.builtin:
                        parsed.values[str(column_id)] = parsed.builtin[role]
        if (
            parsed.builtin.get("shift_start")
            and parsed.builtin.get("shift_end")
            and parsed.builtin["shift_start"] > parsed.builtin["shift_end"]
        ):
            raise HTTPException(422, f"Строка {index}: конец вахты раньше начала. {TEMPLATE_ERROR}")
        if (
            parsed.calendar
            or parsed.selections
            or any(
                value is not None for value in [*parsed.values.values(), *parsed.builtin.values()]
            )
        ):
            result.append(parsed)
    return result


def append_rows(table: ExchangeTable, parsed: list[ImportedRow], actor_id: int) -> list[int]:
    created = []
    for item in parsed:
        kwargs: dict[str, Any] = {
            "dormitory_id": table.dormitory.id,
            "custom_values": item.values,
            **item.builtin,
        }
        if table.tab:
            row: Record = CustomTabEntry(
                **kwargs,
                tab_id=table.tab.id,
                calendar_values=item.calendar,
                fill_selections={},
                fill_copies={},
            )
        else:
            if table.key in {"advance", "settlement"}:
                kwargs["kind"] = table.key
            row = TABLE_MODELS[table.key](**kwargs)
        table.db.add(row)
        if isinstance(row, PersonnelOutflow):
            for col in table.columns:
                column = col.column
                if column and not column.builtin_key and str(column.id) in item.values:
                    item.values[str(column.id)] = sync_outflow_cell(
                        table.db, row, column, item.values[str(column.id)]
                    )
            row.custom_values = dict(item.values)
        table.db.flush()
        if isinstance(row, CustomTabEntry):
            for column, record_id in item.selections:
                choose_record(table.db, row, column, record_id)
        if isinstance(
            row, (Resident, PersonnelInflow, PersonnelOutflow, CustomTabEntry, ArchiveEntry)
        ):
            record_changed(table.db, row, actor_id)
        created.append(row.id)
    return created


def import_grid(table: ExchangeTable, rows: list[tuple[int, list[Any]]]) -> int:
    assert table.grid is not None
    # Форматирование в конце шаблона не создаёт дополнительные строки данных.
    rows = [
        (index, values)
        for index, values in rows
        if any(value is not None and value != "" for value in values)
    ]
    if len(rows) != len(table.grid):
        raise HTTPException(422, TEMPLATE_ERROR)
    pending: list[Any] = []
    for (index, values), (target, labels) in zip(rows, table.grid, strict=True):
        if values[: len(labels)] != labels:
            raise HTTPException(
                422, f"{TEMPLATE_ERROR} Строка {index}: изменена подпись показателя."
            )
        for col, raw in zip(table.columns[len(labels) :], values[len(labels) :], strict=True):
            if raw is None or raw == "":
                continue
            assert col.day
            try:
                value = parse_value(table, col, raw)
                if value is None:
                    continue
                if table.key == "report":
                    if target.formula or target.link:
                        raise HTTPException(
                            422, "Расчётную строку заполнять нельзя. Оставьте ячейку пустой"
                        )
                    existing: ReportCell | HostelCell | None = table.db.scalar(
                        select(ReportCell).where(
                            ReportCell.row_id == target.id, ReportCell.report_date == col.day
                        )
                    )
                    if len(value) > 200:
                        raise HTTPException(422, "Значение не длиннее 200 символов")
                    new_cell: Any = ReportCell(row_id=target.id, report_date=col.day, value=value)
                else:
                    number = Decimal(value)
                    if number != number.to_integral_value() or not 0 <= number <= 1_000_000_000:
                        raise HTTPException(422, "Укажите целое число от 0 до 1 000 000 000")
                    hostel, metric = target
                    existing = table.db.scalar(
                        select(HostelCell).where(
                            HostelCell.hostel_id == hostel.id,
                            HostelCell.report_date == col.day,
                            HostelCell.field == metric,
                        )
                    )
                    new_cell = HostelCell(
                        hostel_id=hostel.id, report_date=col.day, field=metric, value=int(number)
                    )
                if existing is not None:
                    raise HTTPException(
                        422,
                        "Ячейка уже заполнена. Импорт добавляет данные "
                        "и не заменяет сохранённые значения",
                    )
                pending.append(new_cell)
            except HTTPException as exc:
                raise HTTPException(
                    422, f"{TEMPLATE_ERROR} Строка {index}, столбец «{col.name}»: {exc.detail}"
                ) from exc
    table.db.add_all(pending)
    return len(pending)

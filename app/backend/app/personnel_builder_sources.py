"""Источники конструктора: только данные организации текущей сессии."""

from datetime import date, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.access import scoped_dormitories
from app.api.reports import read_report
from app.arrival_plans import active_arrivals
from app.cell_fill import FillResolver
from app.models.custom_tab import CustomTab
from app.models.hostel import Hostel, HostelCell
from app.models.report import ReportRow
from app.models.table_column import TableColumn
from app.models.user import User
from app.personnel import workspace
from app.place_values import active_in_month, place_day_values
from app.table_data import record_value, records_for

METRICS = {
    "residents_total": "Проживает всего",
    "residents_m": "Проживает М",
    "residents_f": "Проживает Ж",
    "paid_total": "Оплачено мест",
    "paid_m": "Оплачено М",
    "paid_f": "Оплачено Ж",
    "free_total": "Свободно мест",
    "free_m": "Свободно М",
    "free_f": "Свободно Ж",
}
STANDARD = {
    "$employee": ("Сотрудник (связь по карточке)", "employee"),
    "full_name": ("Сотрудник / ФИО", "text"),
    "personnel_number": ("Табельный номер", "text"),
    "phone": ("Телефон", "text"),
    "residence_status": ("Статус проживания", "select"),
    "dormitory": ("Общежитие проживания", "select"),
    "hostel_name": ("Место проживания", "text"),
    "shift_start": ("Начало вахты", "date"),
    "shift_end": ("Окончание вахты", "date"),
}
TABLE_NAMES = {
    "residents": "Проживающие",
    "inflow": "Приток",
    "outflow": "Отток",
    "advance": "На аванс",
    "settlement": "На расчёт",
    "archive": "Архив",
}


def normalized(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return " ".join(str(value if value is not None else "").casefold().replace("ё", "е").split())


class Sources:
    def __init__(self, db: Session, user: User, organization_id: int):
        self.db, self.user, self.organization_id = db, user, organization_id
        self.dorms = {d.id: d for d in scoped_dormitories(db, organization_id)}
        self.columns = list(
            db.scalars(
                select(TableColumn)
                .where(TableColumn.dormitory_id.in_(self.dorms))
                .order_by(TableColumn.position, TableColumn.id)
            )
        )
        self.tabs = list(
            db.scalars(select(CustomTab).where(CustomTab.dormitory_id.in_(self.dorms)))
        )
        self.report_rows = list(
            db.scalars(select(ReportRow).where(ReportRow.dormitory_id.in_(self.dorms)))
        )
        self.hostels = list(db.scalars(select(Hostel).where(Hostel.dormitory_id.in_(self.dorms))))
        self._personnel: dict[str, Any] | None = None
        self._records: dict[tuple[str, str, str], list[dict[str, list[Any]]]] = {}
        self._catalog: list[dict[str, Any]] | None = None

    @property
    def personnel(self) -> dict[str, Any]:
        if self._personnel is None:
            self._personnel = workspace(self.db, self.user, list(self.dorms))
        return self._personnel

    def catalog(self) -> list[dict[str, Any]]:
        if self._catalog is not None:
            return self._catalog
        fields = [
            {"id": key, "name": value[0], "kind": value[1]} for key, value in STANDARD.items()
        ]
        for column in self.personnel.get("source_columns", []):
            field_key = column["builtin_key"] or normalized(column["name"])
            key = f"source:{column['table_key']}:{field_key}:{column['kind']}"
            if not any(field["id"] == key for field in fields):
                fields.append(
                    {
                        "id": key,
                        "name": f"{column['source_name']} · {column['name']}",
                        "kind": column["kind"],
                    }
                )
        result: list[dict[str, Any]] = [
            {"id": "people", "name": "Реестр сотрудников", "kind": "people", "fields": fields},
            {
                "id": "arrivals",
                "name": "План заездов",
                "kind": "arrivals",
                "fields": [
                    {
                        "id": "dormitory",
                        "name": "Общежитие",
                        "kind": "select",
                        "options": [d.name for d in self.dorms.values()],
                    },
                    {"id": "date", "name": "Дата заезда", "kind": "date"},
                    {"id": "count", "name": "Количество человек", "kind": "number"},
                ],
            },
        ]
        for dorm_id, dorm in self.dorms.items():
            for key in dict.fromkeys(
                c.table_key for c in self.columns if c.dormitory_id == dorm_id
            ):
                columns = [
                    c
                    for c in self.columns
                    if c.dormitory_id == dorm_id
                    and c.table_key == key
                    and not c.archived
                    and c.kind not in ("action", "hostel")
                ]
                tab = next(
                    (t for t in self.tabs if t.dormitory_id == dorm_id and t.table_key == key), None
                )
                if tab and (
                    not tab.table_created
                    or tab.kind == "archive"
                    or getattr(tab, "status", "active") == "deleted"
                ):
                    continue
                result.append(
                    {
                        "id": f"dorm:{dorm_id}:{key}",
                        "name": f"{tab.name if tab else TABLE_NAMES.get(key, key)} — {dorm.name}",
                        "kind": "table",
                        "fields": [
                            *(
                                {
                                    "id": str(c.id),
                                    "name": c.name,
                                    "kind": c.kind,
                                    "options": [o["label"] for o in c.options],
                                }
                                for c in columns
                            ),
                            {"id": "$created_at", "name": "Дата создания", "kind": "date"},
                        ],
                    }
                )
                if tab and tab.options.get("table_format") == "calendar":
                    result[-1]["kind"] = "calendar"
                    result[-1]["fields"] = [
                        {"id": "$date", "name": "Дата", "kind": "date"},
                        {"id": "$value", "name": "Значение за день", "kind": "number"},
                        *result[-1]["fields"],
                    ]
                    result[-1]["rows"] = [
                        {
                            "id": str(row.id),
                            "name": str(
                                row.custom_values.get(str(columns[0].id), "") if columns else ""
                            )[:255]
                            or f"Строка {row.id}",
                        }
                        for row in records_for(self.db, dorm_id, key)
                    ]
            result.append(
                {
                    "id": f"report:{dorm_id}",
                    "name": f"Общий отчёт — {dorm.name}",
                    "kind": "report",
                    "fields": [
                        {"id": "$date", "name": "Дата", "kind": "date"},
                        {"id": "$value", "name": "Значение строки", "kind": "number"},
                    ],
                    "rows": [
                        {"id": str(row.id), "name": row.name}
                        for row in self.report_rows
                        if row.dormitory_id == dorm_id
                    ],
                }
            )
            result.append(
                {
                    "id": f"places:{dorm_id}",
                    "name": f"Размещение персонала — {dorm.name}",
                    "kind": "places",
                    "fields": [
                        {"id": "$date", "name": "Дата", "kind": "date"},
                        {
                            "id": "$hostel",
                            "name": "Хостел",
                            "kind": "select",
                            "options": [h.name for h in self.hostels if h.dormitory_id == dorm_id],
                        },
                        *(
                            {"id": key, "name": name, "kind": "number"}
                            for key, name in METRICS.items()
                        ),
                    ],
                }
            )
        self._catalog = result
        return result

    def people_records(self) -> list[dict[str, list[Any]]]:
        result = []
        for person in self.personnel["employees"]:
            current = person["current"]
            values: dict[str, list[Any]] = {
                "$employee": [person["id"], *person["member_ids"]],
                "residence_status": ["Проживает" if current else "Вне общежитий"],
                "dormitory": [self.dorms[s["dormitory_id"]].name for s in current],
            }
            for key in ("full_name", "personnel_number", "phone"):
                values[key] = list(
                    dict.fromkeys(
                        [
                            value
                            for value in [person[key], *person["variants"].get(key, [])]
                            if value
                        ]
                    )
                )
            for key in ("hostel_name", "shift_start", "shift_end"):
                values[key] = list(
                    dict.fromkeys(s["values"].get(key) for s in current if s["values"].get(key))
                )
            for field in self.personnel.get("source_columns", []):
                field_key = field["builtin_key"] or normalized(field["name"])
                key = f"source:{field['table_key']}:{field_key}:{field['kind']}"
                for source in person["sources"]:
                    if (
                        source["dormitory_id"] != field["dormitory_id"]
                        or source["table_key"] != field["table_key"]
                    ):
                        continue
                    raw = (
                        source["values"].get(field["builtin_key"])
                        if field["builtin_key"]
                        else source["values"].get("custom_values", {}).get(str(field["id"]))
                    )
                    if field["kind"] == "select":
                        raw = next((o["label"] for o in field["options"] if o["id"] == raw), raw)
                    if raw is not None and raw != "" and raw not in values.get(key, []):
                        values.setdefault(key, []).append(raw)
            result.append(values)
        return result

    def records(self, source_id: str, start: date, end: date) -> list[dict[str, list[Any]]]:
        cache_key = (source_id, start.isoformat(), end.isoformat())
        if cache_key in self._records:
            return self._records[cache_key]
        result: list[dict[str, list[Any]]] = []
        if source_id == "people":
            result = self.people_records()
        elif source_id == "arrivals":
            for plan in active_arrivals(
                self.db, list(self.dorms), date(1900, 1, 1), date(2200, 1, 1)
            ):
                result.append(
                    {
                        "dormitory": [self.dorms[plan["dormitory_id"]].name],
                        "date": [str(plan["date"])],
                        "count": [plan["count"]],
                    }
                )
        else:
            parts = source_id.split(":")
            dorm_id = int(parts[1])
            dorm = self.dorms[dorm_id]
            if parts[0] == "dorm":
                key = parts[2]
                resolver = FillResolver(self.db, dorm_id)
                columns = [
                    c
                    for c in self.columns
                    if c.dormitory_id == dorm_id
                    and c.table_key == key
                    and not c.archived
                    and c.kind not in ("action", "hostel")
                ]
                for row in records_for(self.db, dorm_id, key):
                    values: dict[str, list[Any]] = {}
                    for column in columns:
                        try:
                            raw = record_value(row, column, resolver)
                        except (HTTPException, ValueError) as exc:
                            values.setdefault("$errors", [{}])[0][str(column.id)] = (
                                str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
                            )
                            values[str(column.id)] = []
                            continue
                        if column.kind == "select":
                            raw = next(
                                (
                                    option["label"]
                                    for option in column.options
                                    if option["id"] == raw
                                ),
                                raw,
                            )
                        values[str(column.id)] = [raw]
                    values["$created_at"] = [
                        row.created_at.replace(tzinfo=row.created_at.tzinfo or ZoneInfo("UTC"))
                        .astimezone(ZoneInfo("Europe/Moscow"))
                        .date()
                        .isoformat()
                    ]
                    tab = next(
                        (t for t in self.tabs if t.dormitory_id == dorm_id and t.table_key == key),
                        None,
                    )
                    if tab and tab.options.get("table_format") == "calendar":
                        for offset in range((end - start).days + 1):
                            day_key = (start + timedelta(days=offset)).isoformat()
                            result.append(
                                {
                                    **values,
                                    "$row_id": [str(row.id)],
                                    "$date": [day_key],
                                    "$value": [
                                        getattr(row, "calendar_values", {}).get(day_key, "")
                                    ],
                                }
                            )
                    else:
                        result.append(values)
            elif parts[0] == "report":
                report = read_report(dorm_id, self.user, self.db, start, end, dorm)
                for report_row in report.rows:
                    for offset in range((end - start).days + 1):
                        day_key = (start + timedelta(days=offset)).isoformat()
                        result.append(
                            {
                                "$row_id": [str(report_row.id)],
                                "$date": [day_key],
                                "$value": [report_row.values.get(day_key, "0")],
                                "$error": [report_row.errors.get(day_key, "")],
                            }
                        )
            elif parts[0] == "places":
                hostels = [h for h in self.hostels if h.dormitory_id == dorm_id]
                cells = list(
                    self.db.scalars(
                        select(HostelCell).where(
                            HostelCell.hostel_id.in_([h.id for h in hostels]),
                            HostelCell.report_date >= start,
                            HostelCell.report_date <= end,
                        )
                    )
                )
                for offset in range((end - start).days + 1):
                    day = start + timedelta(days=offset)
                    for hostel in hostels:
                        if not active_in_month(hostel, day.replace(day=1)):
                            continue
                        metrics = place_day_values(
                            {
                                c.field: c.value
                                for c in cells
                                if c.hostel_id == hostel.id and c.report_date == day
                            }
                        )
                        result.append(
                            {
                                "$date": [day.isoformat()],
                                "$hostel": [hostel.name],
                                **{key: [metrics.get(key, 0)] for key in METRICS},
                            }
                        )
        self._records[cache_key] = result
        return result

    def templates(self) -> list[dict[str, Any]]:
        result = []
        for tab in self.tabs:
            if not tab.table_created or tab.kind == "archive":
                continue
            result.append(
                {
                    "id": f"template-{tab.dormitory_id}-{tab.id}",
                    "name": tab.name,
                    "description": "",
                    "kind": "table",
                    "builtin": False,
                    "hidden": False,
                    "archived": False,
                    "parentId": None,
                    "isGroup": False,
                    "tableOptions": tab.options or {},
                    "dateColumnId": str(tab.options["date_column_id"])
                    if tab.options and tab.options.get("date_column_id")
                    else None,
                    "criteria": {
                        "filter": "all",
                        "dormitory": None,
                        "days": 7,
                        "query": "",
                        "scope": [],
                        "column_filters": [],
                    },
                    "fields": [],
                    "columns": [
                        {
                            "id": str(c.id),
                            "name": c.name,
                            "kind": c.kind,
                            "options": [o["label"] for o in c.options if not o.get("archived")],
                            "required": False,
                            "archived": c.archived,
                        }
                        for c in self.columns
                        if c.dormitory_id == tab.dormitory_id
                        and c.table_key == tab.table_key
                        and c.kind not in ("action", "hostel")
                    ],
                    "rows": [],
                    "blocks": [],
                    "actions": {
                        "search": True,
                        "filters": True,
                        "export": True,
                        "add": True,
                        "remove": True,
                    },
                    "templateLabel": f"{tab.name} — {self.dorms[tab.dormitory_id].name}",
                }
            )
        return result

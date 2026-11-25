"""Связывание людей с исходными строками. Совпадения никогда не объединяются автоматически."""

import hashlib
import json
import re
from collections import defaultdict
from collections.abc import Callable, Collection, Iterable, Sequence
from contextlib import suppress
from dataclasses import dataclass, replace
from datetime import date, datetime
from difflib import SequenceMatcher
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import Date, DateTime, func, select, text
from sqlalchemy.orm import Session

from app.arrival_plans import active_arrivals
from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.hostel import Hostel
from app.models.inflow import PersonnelInflow
from app.models.outflow import PersonnelOutflow
from app.models.personnel import (
    Employee,
    EmployeeAlias,
    EmployeeEvent,
    EmployeeMerge,
    EmployeeNote,
    EmployeePlan,
    PersonnelBinding,
    PersonnelPreferences,
)
from app.models.resident import Resident
from app.models.table_column import ArchiveEntry, TableColumn
from app.models.user import User
from app.personnel_page import DEFAULT_BLOCKS, ListCriteria
from app.personnel_query import (
    SelectionCache,
    block_previews,
    candidates,
    counts_by_filter,
    person_page,
)
from app.schemas.personnel import IdentityChoice, IdentityFields
from app.sql_diagnostics import stage

Row = Resident | PersonnelInflow | PersonnelOutflow | CustomTabEntry | ArchiveEntry
SOURCE_MODELS: tuple[type[Row], ...] = (
    Resident,
    PersonnelInflow,
    PersonnelOutflow,
    CustomTabEntry,
    ArchiveEntry,
)
IDENTITY_FIELDS = ("full_name", "personnel_number", "phone")
SOURCE_NAMES = {
    "residents": "Проживающие",
    "inflow": "Приток",
    "outflow": "Отток",
    "archive": "Архив",
}


def today() -> date:
    return datetime.now(ZoneInfo("Europe/Moscow")).date()


def identity_lock(db: Session) -> None:
    # Общий замок сериализует окончательную проверку и создание, включая разные общежития.
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(723190031)"))


def normalized(field: str, value: str | None) -> str:
    value = value or ""
    if field == "phone":
        digits = re.sub(r"\D", "", value)
        return "7" + digits[1:] if len(digits) == 11 and digits.startswith("8") else digits
    return " ".join(re.sub(r"[^\w\s]", " ", value.casefold().replace("ё", "е")).split())


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


def root_map(db: Session) -> tuple[dict[str, Employee], dict[str, str]]:
    employees = {item.id: item for item in db.scalars(select(Employee))}
    roots: dict[str, str] = {}
    for employee_id in employees:
        current = employee_id
        seen: set[str] = set()
        while employees[current].merged_into_id:
            if current in seen:
                raise HTTPException(409, "Обнаружена некорректная связь карточек")
            seen.add(current)
            target = employees[current].merged_into_id
            if target not in employees:
                raise HTTPException(409, "Связанная карточка не найдена")
            current = target
        roots[employee_id] = current
    return employees, roots


def get_employee(db: Session, employee_id: str) -> Employee:
    employees, roots = root_map(db)
    if employee_id not in employees:
        raise HTTPException(404, "Карточка сотрудника не найдена")
    return employees[roots[employee_id]]


def group_ids(db: Session, employee_id: str) -> list[str]:
    employees, roots = root_map(db)
    if employee_id not in employees:
        raise HTTPException(404, "Карточка сотрудника не найдена")
    return [id for id, root in roots.items() if root == roots[employee_id]]


def group_identities(
    employees: dict[str, Employee], roots: dict[str, str]
) -> dict[str, dict[str, Any]]:
    result = {
        root: {field: getattr(employees[root], field) for field in IDENTITY_FIELDS}
        for root in set(roots.values())
    }
    for item in employees.values():
        for field in IDENTITY_FIELDS:
            if not result[roots[item.id]][field] and getattr(item, field):
                result[roots[item.id]][field] = getattr(item, field)
    return result


# Справочник «какая модель — какой ключ таблицы». Ключ у модели постоянный; своё
# имя только у пользовательской вкладки, и оно зависит от строки, а не от модели.
# Это единственное место, где описан ключ модели: `source_key`, `all_sources` и
# `source_spec` берут его отсюда.
SOURCE_KEYS: dict[type[Row], str] = {
    Resident: "residents",
    PersonnelInflow: "inflow",
    PersonnelOutflow: "outflow",
    ArchiveEntry: "archive",
}
# Модели-источники вне справочника: их таблица зовётся `custom_<id>`, и имя
# зависит от строки. Инвариант проверяется при импорте модуля, а не в проде:
# шестая модель, забытая в `SOURCE_KEYS`, иначе отдала бы 500 на
# `GET /api/personnel` и на экспорте — на первом же запросе, а не на импорте.
CUSTOM_KEYED: tuple[type[Row], ...] = (CustomTabEntry,)


def check_source_keys(
    registry: dict[type[Row], str] | None = None,
    models: tuple[type[Row], ...] = SOURCE_MODELS,
    custom: tuple[type[Row], ...] = CUSTOM_KEYED,
) -> None:
    """Проверить, что справочник ключей описывает все модели-источники.

    Вне справочника может быть только модель с ключом `custom_<id>` (строки
    пользовательской вкладки). Если шестую модель добавят в `SOURCE_MODELS` и
    забудут в `SOURCE_KEYS`, `all_sources` упала бы на первом же запросе, и
    `GET /api/personnel` с экспортом отдали бы 500. Поэтому проверка вызывается
    при импорте модуля: ломается импорт, а не прод.
    """
    missing = set(models) - set(SOURCE_KEYS if registry is None else registry) - set(custom)
    if missing:
        raise RuntimeError(
            "SOURCE_KEYS не описывает модели-источники: "
            + ", ".join(sorted(model.__name__ for model in missing))
            + "; добавьте ключ в SOURCE_KEYS или модель в CUSTOM_KEYED"
        )


check_source_keys()


def source_key(row: Row) -> str:
    """Ключ таблицы-источника строки: постоянный или `custom_<id>` вкладки."""
    key = SOURCE_KEYS.get(type(row))
    if key is not None:
        return key
    # Вне справочника остаётся только строка пользовательской вкладки — это
    # обеспечивает проверка инварианта выше.
    assert isinstance(row, CustomTabEntry)
    return f"custom_{row.tab_id}"


@dataclass(frozen=True)
class SourceSpec:
    """Разбор колонок модели-источника — один раз на модель, а не на каждую строку.

    `keys` — ключи колонок в порядке объявления таблицы (ровно тот порядок, в
    котором прежний код обходил `row.__table__.columns`); `temporal` — какие из
    них приводятся к ISO-строке; `employee_at` — позиция `employee_id` в строке
    выборки: она исключается из значений ответа. `table_key` — ключ таблицы, у
    пользовательской вкладки его нет (`custom_<id>`, см. `source_key`).
    """

    keys: tuple[str, ...]
    temporal: tuple[str, ...]
    employee_at: int
    table_key: str | None
    columns: tuple[Any, ...]


_SPECS: dict[type[Row], SourceSpec] = {}


def source_spec(model: type[Row]) -> SourceSpec:
    """Спецификация колонок модели. Стоимость — один раз на модель за процесс."""
    spec = _SPECS.get(model)
    if spec is None:
        columns = tuple(model.__table__.columns)
        spec = SourceSpec(
            keys=tuple(column.key for column in columns),
            temporal=tuple(
                column.key for column in columns if isinstance(column.type, (Date, DateTime))
            ),
            employee_at=next(
                index for index, column in enumerate(columns) if column.key == "employee_id"
            ),
            table_key=SOURCE_KEYS.get(model),
            columns=columns,
        )
        _SPECS[model] = spec
    return spec


def stringify_temporal(values: dict[str, Any], spec: SourceSpec) -> None:
    """Привести `date`/`datetime` к строке на месте — по спецификации модели.

    Раньше каждую строку-источник прогонял `json.loads(json.dumps(...))` только
    затем, чтобы превратить даты в строки. Это стоило прохода сериализации и
    разбора на каждую строку (`#237`); признак «колонка — дата или время» теперь
    известен из типа колонки и считается один раз на модель. Значения остальных
    колонок не трогаются, ответ остаётся побайтово тем же.
    """
    for key in spec.temporal:
        value = values[key]
        if value is not None:
            values[key] = value.isoformat()


def annotate(
    db: Session,
    values: dict[str, Any],
    key: str,
    lookup: dict[str, Any] | None = None,
) -> None:
    """Дописать к значениям строки то, чего нет в её колонках.

    Один помощник на два пути: ответ ручки (`all_sources`) и снимок истории,
    который пишет `record_changed` через `row_values`. Наложения обязаны совпадать
    у обоих — иначе одна и та же строка придёт в разных формах, а сравнение
    `previous.snapshot == values` начнёт сравнивать их впустую (#237).

    `lookup` — уже загруженные справочники области; с ним помощник не делает ни
    одного запроса, без него недостающие значения читаются из базы.
    """
    dormitory_id = values["dormitory_id"]
    dormitory = (
        lookup["dormitories"].get(dormitory_id)
        if lookup is not None
        else db.get(Dormitory, dormitory_id)
    )
    values["dormitory_name"] = dormitory.name if dormitory else "Удалённое общежитие"
    values["client_name"] = dormitory.client_name if dormitory else ""
    # Хостел узнаётся по значению, а не по типу строки: `hostel_id` есть только у
    # `Resident`, и это закреплено тестом, а не комментарием.
    hostel_id = values.get("hostel_id")
    if hostel_id:
        hostel = (
            lookup["hostels"].get(hostel_id) if lookup is not None else db.get(Hostel, hostel_id)
        )
        values["hostel_name"] = hostel.name if hostel else None
    binding = (
        lookup["bindings"].get((dormitory_id, key))
        if lookup is not None
        else db.scalar(
            select(PersonnelBinding).where(
                PersonnelBinding.dormitory_id == dormitory_id, PersonnelBinding.table_key == key
            )
        )
    )
    if binding:
        custom = values.get("custom_values") or {}
        for field, column_id in binding.fields.items():
            value = custom.get(str(column_id))
            if value is not None:
                values[field] = str(value)


def row_values(db: Session, row: Row, lookup: dict[str, Any] | None = None) -> dict[str, Any]:
    """Значения строки-источника для ответа и для снимка истории.

    Дата и время приводятся к строке явно, а не проходом `json.dumps`/`json.loads`
    по всей строке: проход сериализовал и заново разбирал каждое значение ради
    `date`/`datetime`-колонок, и на 20 000 строк это была измеримая доля времени
    ответа `GET /api/personnel` (#237). Остальные значения не трогаются — ответ
    остаётся побайтово тем же.
    """
    spec = source_spec(type(row))
    values: dict[str, Any] = {key: getattr(row, key) for key in spec.keys}
    del values["employee_id"]
    stringify_temporal(values, spec)
    annotate(db, values, source_key(row), lookup)
    return values


def add_aliases(db: Session, employee_id: str, values: dict[str, Any]) -> None:
    existing = {
        (a.field, a.value)
        for a in db.scalars(select(EmployeeAlias).where(EmployeeAlias.employee_id == employee_id))
    }
    for field in IDENTITY_FIELDS:
        raw = str(values.get(field) or "").strip()
        if len(raw) > {"full_name": 255, "personnel_number": 40, "phone": 30}[field]:
            continue
        value = normalized(field, raw)
        if value and (field, value) not in existing:
            db.add(EmployeeAlias(employee_id=employee_id, field=field, value=value, raw_value=raw))
            existing.add((field, value))
    db.flush()


def event(
    db: Session,
    employee_id: str,
    kind: str,
    title: str,
    actor_id: int | None,
    *,
    dormitory_id: int | None = None,
    source_table: str | None = None,
    source_id: int | None = None,
    snapshot: dict[str, Any] | None = None,
    happened_on: date | None = None,
) -> None:
    db.add(
        EmployeeEvent(
            employee_id=employee_id,
            kind=kind,
            title=title,
            actor_id=actor_id,
            dormitory_id=dormitory_id,
            source_table=source_table,
            source_id=source_id,
            snapshot=snapshot or {},
            happened_on=happened_on or today(),
        )
    )


def record_changed(
    db: Session,
    row: Row,
    actor_id: int | None,
    *,
    kind: str | None = None,
    title: str | None = None,
) -> None:
    """Вызывается в той же транзакции, что исходное изменение, до удаления строки."""
    identity_lock(db)
    db.flush()
    values = row_values(db, row)
    valid_identity = {
        field: values.get(field)
        if len(str(values.get(field) or ""))
        <= {"full_name": 255, "personnel_number": 40, "phone": 30}[field]
        else None
        for field in IDENTITY_FIELDS
    }
    key = source_key(row)
    tab = db.get(CustomTab, row.tab_id) if isinstance(row, CustomTabEntry) else None
    label = tab.name if tab else SOURCE_NAMES.get(key, key)
    values["source_name"] = label
    previous = next(
        (
            entry
            for entry in db.scalars(
                select(EmployeeEvent)
                .where(EmployeeEvent.source_table == key, EmployeeEvent.source_id == row.id)
                .order_by(EmployeeEvent.id.desc())
            )
            if "custom_values" in entry.snapshot
        ),
        None,
    )
    if not row.employee_id:
        if isinstance(row, (CustomTabEntry, ArchiveEntry)) and not any(
            values.get(field) for field in IDENTITY_FIELDS
        ):
            return
        business = {
            key: value
            for key, value in values.items()
            if key
            not in (
                "id",
                "dormitory_id",
                "created_at",
                "dormitory_name",
                "client_name",
                "tab_id",
                "source_name",
            )
        }
        if not any(business.values()):
            return
        employee = Employee(**valid_identity, identity_status="pending")
        db.add(employee)
        db.flush()
        row.employee_id = employee.id
    employee = get_employee(db, row.employee_id)
    sole_source = (
        employee.id == row.employee_id
        and len(group_ids(db, employee.id)) == 1
        and sum(
            db.scalar(
                select(func.count()).select_from(model).where(model.employee_id == employee.id)
            )
            or 0
            for model in (Resident, PersonnelInflow, PersonnelOutflow, CustomTabEntry, ArchiveEntry)
        )
        == 1
    )
    for field in IDENTITY_FIELDS:
        if (
            employee.id == row.employee_id
            and not getattr(employee, field)
            and valid_identity.get(field)
        ) or (
            sole_source
            and previous
            and field in values
            and getattr(employee, field) == previous.snapshot.get(field)
        ):
            setattr(employee, field, valid_identity[field])
    add_aliases(db, row.employee_id, values)
    if not kind and previous and previous.snapshot == values:
        return
    first = previous is None
    event_kind = kind or (
        "outflow"
        if key == "outflow" and first
        else "arrival"
        if key in ("residents", "inflow") and first
        else "source"
    )
    happened = None
    if first:
        raw_date = values.get(
            "departure_date"
            if key == "outflow"
            else "settlement_date"
            if key == "inflow"
            else "shift_start"
        )
        if raw_date:
            with suppress(ValueError):
                happened = date.fromisoformat(raw_date)
    event(
        db,
        row.employee_id,
        event_kind,
        title or f"{label} · {'добавлена запись' if first else 'обновлены данные'}",
        actor_id,
        dormitory_id=row.dormitory_id,
        source_table=key,
        source_id=row.id,
        snapshot=values,
        happened_on=happened,
    )
    db.flush()


def fulfill_arrival(db: Session, resident: Resident, actor_id: int) -> None:
    if not resident.employee_id:
        return
    ids = group_ids(db, resident.employee_id)
    for plan in db.scalars(
        select(EmployeePlan).where(
            EmployeePlan.employee_id.in_(ids),
            EmployeePlan.kind == "arrival",
            EmployeePlan.dormitory_id == resident.dormitory_id,
            EmployeePlan.date <= today(),
        )
    ):
        event(
            db,
            plan.employee_id,
            "plan",
            "План заезда выполнен · оформлено проживание",
            actor_id,
            dormitory_id=resident.dormitory_id,
            snapshot={
                "date": plan.date.isoformat(),
                "end": plan.end.isoformat() if plan.end else None,
            },
        )
        db.delete(plan)


@dataclass(frozen=True)
class SourceRecord:
    """Строка-источник, уже превращённая в значения ответа.

    Раньше `all_sources` отдавал пару «ORM-объект + его значения». Объект нужен
    был только чтобы прочитать три поля (`employee_id`, `id`, `dormitory_id`) и
    тип строки, а стоил материализации 20 000 ORM-объектов и `getattr` по каждой
    колонке. Здесь эти три поля вынесены рядом со значениями: строки-источники
    читаются запросом по колонкам (issue #237).
    """

    table_key: str
    row_id: Any
    dormitory_id: int
    employee_id: str | None
    values: dict[str, Any]


def all_sources(
    db: Session,
    dormitory_ids: list[int],
    dormitories: list[Any] | None = None,
    *,
    employee_ids: Collection[str] | None = None,
) -> list[SourceRecord]:
    """Строки-источники только по перечисленным общежитиям.

    Область (`dormitory_ids`) разрешает вызывающий слой: принадлежность данных
    организации считается по корню — общежитию, — а не по каждой дочерней строке.

    `dormitories` — уже загруженный справочник общежитий области: `workspace`
    читает его сам (он отдаёт его в ответ), и второй `SELECT` по той же таблице
    был лишним выполнением в каждом запросе. Не передан — читается здесь же.

    `employee_ids` сужает выборку до карточек страницы (#251): `None` — строки
    всей области, пустое множество — ни одной.

    Читаются колонки, а не ORM-объекты: на объёме стенда (20 000 строк) одно
    создание объектов стоило дольше, чем весь остальной запрос (`#237`).
    """
    if employee_ids is not None and not employee_ids:
        return []
    if dormitories is None:
        dormitories = list(db.scalars(select(Dormitory).where(Dormitory.id.in_(dormitory_ids))))
    lookup: dict[str, Any] = {
        "dormitories": {item.id: item for item in dormitories},
        "hostels": {
            item.id: item
            for item in db.execute(
                select(Hostel.id, Hostel.name).where(Hostel.dormitory_id.in_(dormitory_ids))
            )
        },
        "bindings": {
            (item.dormitory_id, item.table_key): item
            for item in db.scalars(
                select(PersonnelBinding).where(PersonnelBinding.dormitory_id.in_(dormitory_ids))
            )
        },
    }
    result: list[SourceRecord] = []
    for model in SOURCE_MODELS:
        spec = source_spec(model)
        condition = [model.employee_id.is_not(None), model.dormitory_id.in_(dormitory_ids)]
        if employee_ids is not None:
            # Ограничение страницы (#251): читаются строки только отобранных
            # карточек, а не всей области.
            condition.append(model.employee_id.in_(employee_ids))
        rows = db.execute(select(*spec.columns).where(*condition))
        for row in rows:
            employee_id = row[spec.employee_at]
            # Порядок ключей — порядок колонок таблицы, как и раньше: он виден в
            # JSON ответа, поэтому собирается тот же самый dict.
            values: dict[str, Any] = dict(zip(spec.keys, row, strict=False))
            del values["employee_id"]
            stringify_temporal(values, spec)
            key = spec.table_key or f"custom_{values['tab_id']}"
            annotate(db, values, key, lookup)
            result.append(
                SourceRecord(
                    table_key=key,
                    row_id=values["id"],
                    dormitory_id=values["dormitory_id"],
                    employee_id=employee_id,
                    values=values,
                )
            )
    return result


def employee_in_scope(db: Session, employee_id: str, dormitory_ids: list[int]) -> Employee:
    """Карточка сотрудника в пределах области. Иначе — `404`, как за несуществующую.

    Карточка сотрудника общая для нескольких общежитий, поэтому своей
    организации у неё нет: видимой она считается, пока у неё есть строка или
    событие в общежитиях области.
    """
    employee = get_employee(db, employee_id)
    ids = group_ids(db, employee_id)
    has_source = any(
        db.scalar(
            select(model.id)
            .where(model.employee_id.in_(ids), model.dormitory_id.in_(dormitory_ids))
            .limit(1)
        )
        is not None
        for model in SOURCE_MODELS
    )
    if (
        has_source
        or db.scalar(
            select(EmployeeEvent.id)
            .where(
                EmployeeEvent.employee_id.in_(ids),
                EmployeeEvent.dormitory_id.in_(dormitory_ids),
            )
            .limit(1)
        )
        is not None
    ):
        return employee
    raise HTTPException(404, "Карточка сотрудника не найдена")


def identity_index(
    db: Session, dormitory_ids: list[int]
) -> tuple[dict[str, Employee], dict[str, str], dict[str, dict[str, set[str]]]]:
    """Индекс личностей в пределах области: чужие карточки не участвуют в подборе."""
    employees, roots = root_map(db)
    active = {
        roots[id]
        for id in db.scalars(
            select(EmployeeEvent.employee_id)
            .where(EmployeeEvent.dormitory_id.in_(dormitory_ids))
            .distinct()
        )
    }
    for model in SOURCE_MODELS:
        active.update(
            roots[id or ""]
            for id in db.scalars(
                select(model.employee_id)
                .where(
                    model.employee_id.is_not(None),
                    model.dormitory_id.in_(dormitory_ids),
                )
                .distinct()
            )
        )
    aliases: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for alias in db.scalars(select(EmployeeAlias)):
        if roots[alias.employee_id] in active:
            aliases[roots[alias.employee_id]][alias.field].add(alias.value)
    for item in employees.values():
        if roots[item.id] not in active:
            continue
        for field in IDENTITY_FIELDS:
            if value := normalized(field, getattr(item, field)):
                aliases[roots[item.id]][field].add(value)
    return employees, roots, aliases


def score_match(
    left: dict[str, set[str]], right: dict[str, set[str]]
) -> tuple[int, list[str], list[str]]:
    score = 0
    evidence: list[str] = []
    differences: list[str] = []
    labels = {"personnel_number": "Табельный номер", "phone": "Телефон", "full_name": "ФИО"}
    for field, weight in (("personnel_number", 50), ("phone", 55), ("full_name", 35)):
        a, b = left.get(field, set()), right.get(field, set())
        if a & b:
            score += weight
            evidence.append(f"Совпадает {labels[field].lower()}")
        elif a and b:
            differences.append(f"Различается {labels[field].lower()}")
    if not (left.get("full_name", set()) & right.get("full_name", set())):
        names = [
            (a, b) for a in left.get("full_name", set()) for b in right.get("full_name", set())
        ]
        if any(
            a.split()[0] == b.split()[0] or SequenceMatcher(None, a, b).ratio() >= 0.82
            for a, b in names
        ):
            score += 15
            evidence.append("Похожее ФИО или совпадает фамилия")
    return score, evidence, differences


def check_identity(db: Session, fields: IdentityFields, dormitory_ids: list[int]) -> dict[str, Any]:
    employees, roots, aliases = identity_index(db, dormitory_ids)
    query = {
        field: {value} if (value := normalized(field, getattr(fields, field))) else set()
        for field in IDENTITY_FIELDS
    }
    identities = group_identities(employees, roots)
    candidates: list[dict[str, Any]] = []
    sources = all_sources(db, dormitory_ids)
    for employee_id in sorted(aliases):
        score, evidence, differences = score_match(query, aliases[employee_id])
        if score == 0:
            continue
        employee = employees[employee_id]
        locations = sorted(
            {
                source.values["dormitory_name"]
                for source in sources
                if roots.get(source.employee_id or "") == employee_id
            }
        )
        candidates.append(
            {
                "id": employee.id,
                **identities[employee_id],
                "identity_status": employee.identity_status,
                "dormitories": locations,
                "score": score,
                "evidence": evidence,
                "differences": differences,
            }
        )
    candidates.sort(key=lambda item: (-item["score"], item["full_name"] or "", item["id"]))
    token = digest(
        {
            "fields": fields.model_dump(),
            "candidates": candidates,
            "values": {
                item["id"]: {field: sorted(values) for field, values in aliases[item["id"]].items()}
                for item in candidates
            },
        }
    )
    return {"candidates": candidates, "check_token": token}


def choose_identity(db: Session, choice: IdentityChoice, dormitory_ids: list[int]) -> Employee:
    identity_lock(db)
    fields = IdentityFields(**{field: getattr(choice, field) for field in IDENTITY_FIELDS})
    checked = check_identity(db, fields, dormitory_ids)
    if checked["check_token"] != choice.check_token:
        raise HTTPException(
            409, "Список совпадений изменился. Повторите проверку перед сохранением"
        )
    if choice.mode == "existing":
        return get_employee(db, str(choice.employee_id))
    employee = Employee(
        **fields.model_dump(), identity_status="confirmed" if choice.mode == "new" else "pending"
    )
    db.add(employee)
    db.flush()
    add_aliases(db, employee.id, fields.model_dump())
    return employee


@dataclass(frozen=True)
class WorkspaceContext:
    """Данные поверхности, общие для карточек, столбцов и превью блоков."""

    dormitory_ids: list[int]
    employees: dict[str, Employee]
    roots: dict[str, str]
    identities: dict[str, dict[str, Any]]
    dormitories: list[Any]
    tabs: dict[str, str]
    members: frozenset[str] | None = None
    """Чьи карточки собирать: `None` — всех корней области (#251).

    Страница людей собирает карточки только для отобранных строк, поэтому
    ограничение живёт в контексте, а не третьим аргументом `employee_cards`:
    сигнатура `employee_cards(db, context)` остаётся прежней.
    """


def workspace_context(db: Session, dormitory_ids: list[int]) -> WorkspaceContext:
    """Люди, корни слияний, общежития области и вкладки — один раз на запрос."""
    employees, roots = root_map(db)
    return WorkspaceContext(
        dormitory_ids=list(dormitory_ids),
        employees=employees,
        roots=roots,
        identities=group_identities(employees, roots),
        dormitories=list(
            db.execute(
                select(Dormitory.id, Dormitory.name, Dormitory.client_name, Dormitory.is_archived)
                .where(Dormitory.id.in_(dormitory_ids))
                .order_by(Dormitory.name, Dormitory.id)
            )
        ),
        tabs={f"custom_{tab.id}": tab.name for tab in db.scalars(select(CustomTab))},
    )


def employee_cards(db: Session, context: WorkspaceContext) -> list[dict[str, Any]]:
    """Карточки людей области: источники, проживание, история и варианты ФИО.

    Этапы размечены для события `slow_sql_request` (#237): по ним видно, сколько
    времени уходит на загрузку строк-источников, журнал и сборку карточек.

    `context.members` ограничивает выборку корнями отобранной страницы (#251):
    тогда строки-источники читаются только для них, а не для всей области.
    Первые шаги (состав групп и варианты ФИО) тоже сужены этим множеством.
    """
    wanted = context.members
    # Корневые карточки и их состав — одним проходом по `roots`. Прежний вариант
    # перебирал `roots` целиком внутри цикла по карточкам: O(карточек × карточек).
    members: dict[str, list[str]] = defaultdict(list)
    for member, root in context.roots.items():
        if wanted is None or root in wanted:
            members[root].append(member)
    targets = set(members)
    # Строки-источники читаются по всем участникам отобранных групп, а не только
    # по корням: у присоединённой карточки свои строки, и карточка группы обязана
    # их показать (#251).
    group: set[str] | None = None
    if wanted is not None:
        group = {member for ids in members.values() for member in ids}
    sources: dict[str, list[dict[str, Any]]] = defaultdict(list)
    with stage("sources"):
        for source in all_sources(
            db, context.dormitory_ids, context.dormitories, employee_ids=group
        ):
            sources[context.roots[source.employee_id or ""]].append(
                {
                    "table_key": source.table_key,
                    "row_id": source.row_id,
                    "dormitory_id": source.dormitory_id,
                    "source_name": context.tabs.get(
                        source.table_key, SOURCE_NAMES.get(source.table_key, source.table_key)
                    ),
                    "values": source.values,
                }
            )
    history_dorms: dict[str, set[int]] = defaultdict(set)
    history_ids: set[str] = set()
    with stage("events"):
        # Журнал раньше читался построчно: по строке на каждое событие человека.
        # Здесь из SQL приходят только различные пары «человек — общежитие», а
        # множество людей и их общежития собираются из них (#251).
        for employee_id, dormitory_id in db.execute(
            select(EmployeeEvent.employee_id, EmployeeEvent.dormitory_id)
            .where(EmployeeEvent.dormitory_id.in_(context.dormitory_ids))
            .distinct()
        ):
            root = context.roots[employee_id]
            history_ids.add(root)
            if dormitory_id:
                history_dorms[root].add(dormitory_id)
    variants: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    with stage("aliases"):
        alias_ids = [member for target in targets for member in members[target]]
        aliases = select(EmployeeAlias)
        if wanted is not None:
            aliases = aliases.where(EmployeeAlias.employee_id.in_(alias_ids))
        for alias in db.scalars(aliases):
            variants[context.roots[alias.employee_id]][alias.field].add(alias.raw_value)
    result = []
    with stage("assemble"):
        for id in sorted(targets):
            item = context.employees[id]
            rows = sources[id]
            if not rows and id not in history_ids:
                continue
            current = [source for source in rows if source["table_key"] == "residents"]
            result.append(
                {
                    "id": id,
                    **context.identities[id],
                    "identity_status": item.identity_status,
                    "member_ids": sorted(members[id]),
                    "sources": rows,
                    "current": current,
                    "history_dormitory_ids": sorted(history_dorms[id]),
                    "variants": {field: sorted(values) for field, values in variants[id].items()},
                }
            )
    return result


def dormitory_list(context: WorkspaceContext) -> list[dict[str, Any]]:
    return [
        {"id": d.id, "name": d.name, "client_name": d.client_name, "is_archived": d.is_archived}
        for d in context.dormitories
    ]


def source_columns_response(db: Session, context: WorkspaceContext) -> list[dict[str, Any]]:
    """Столбцы исходных таблиц области — они же поля условий страницы (#247)."""
    return [
        {
            "id": column.id,
            "dormitory_id": column.dormitory_id,
            "table_key": column.table_key,
            "source_name": context.tabs.get(column.table_key, SOURCE_NAMES.get(column.table_key)),
            "name": column.name,
            "kind": column.kind,
            "builtin_key": column.builtin_key,
            "options": column.options,
        }
        for column in db.scalars(
            select(TableColumn)
            .where(
                TableColumn.archived.is_(False),
                TableColumn.kind != "action",
                TableColumn.dormitory_id.in_(context.dormitory_ids),
            )
            .order_by(TableColumn.dormitory_id, TableColumn.table_key, TableColumn.position)
        )
        if column.table_key in SOURCE_NAMES or column.table_key in context.tabs
    ]


def limited_context(context: WorkspaceContext, ids: Iterable[str]) -> WorkspaceContext:
    """Копия контекста, ограниченная корнями отобранной страницы (#251)."""
    return replace(context, members=frozenset(ids))


def cards_by_ids(
    db: Session, context: WorkspaceContext, ids: Iterable[str]
) -> list[dict[str, Any]]:
    """Карточки только для перечисленных корней — в порядке `ids`.

    `employee_cards` отдаёт карточки по возрастанию `id`; страница и превью
    блоков показывают свой порядок (`sort_name`, а для `ending` — конец вахты),
    поэтому результат переставляется здесь.
    """
    wanted = [id for id in ids if id in context.employees]
    if not wanted:
        return []
    cards = employee_cards(db, limited_context(context, wanted))
    by_id = {card["id"]: card for card in cards}
    return [by_id[id] for id in wanted if id in by_id]


def sources_loader(
    db: Session, context: WorkspaceContext
) -> Callable[[Sequence[int], set[str]], list[SourceRecord]]:
    """Загрузчик строк-источников для условий по столбцам (#251).

    Отдаётся `app.personnel_query` вызывающим слоем: этот модуль зависит от
    `all_sources`, а модуль отбора — нет, поэтому цикл модулей не заводится.
    """

    def load(dormitory_ids: Sequence[int], employee_ids: set[str]) -> list[SourceRecord]:
        return all_sources(db, list(dormitory_ids), context.dormitories, employee_ids=employee_ids)

    return load


def page_selection(
    db: Session,
    context: WorkspaceContext,
    criteria: ListCriteria,
    *,
    day: date,
    number: int,
    per_page: int,
    dormitories: list[dict[str, Any]],
    source_columns: list[dict[str, Any]],
) -> tuple[list[str], int]:
    """Корни запрошенной страницы и общее число людей списка (#251)."""
    found = candidates(
        db,
        roots=context.roots,
        identities=context.identities,
        tabs=context.tabs,
        dormitory_ids=context.dormitory_ids,
        criteria=criteria,
        day=day,
        dormitories=dormitories,
        source_columns=source_columns,
        load_sources=sources_loader(db, context),
    )
    return person_page(
        db, candidates=found, employees=context.employees, number=number, per_page=per_page
    )


def workspace(
    db: Session,
    user: User,
    dormitory_ids: list[int],
    *,
    include_employees: bool = True,
    include_previews: bool = False,
    preview_dormitory: int | None = None,
    days: int = 5,
) -> dict[str, Any]:
    """Рабочая поверхность персонала в пределах области — общежитий организации.

    `include_employees=False` (`?employees=none`) отдаёт ту же рамку без карточек:
    ответ больше не растёт вместе с числом сотрудников, а страницу людей приносит
    `GET /api/personnel/employees`. Превью блоков (`include_previews`) и сводка
    (`counts`) считаются здесь же — их источники те же карточки, поэтому второй
    сборки не нужно. `days` задаёт срок вахты для счётчика «Завершают вахту».

    В ответе только типы JSON: даты идут строками `YYYY-MM-DD`, чтобы не гонять
    тело через `jsonable_encoder` (см. `app.api.personnel.json_response`).

    Этапы размечены для события `slow_sql_request` (#237): по ним видно, сколько
    времени уходит на загрузку строк-источников, журнал, сборку карточек, планы и
    заезды. Разметка ничего не меняет в вычислениях — только измеряет.

    С #251 превью блоков и сводка считаются отбором в SQL, а не по полному
    массиву карточек: при `?employees=none` карточки не собираются вообще, а
    счётчик блока равен `total` списка с теми же условиями.
    """
    context = workspace_context(db, dormitory_ids)
    cards = employee_cards(db, context) if include_employees else []

    def person(id: str) -> str:
        return context.roots[id]

    preferences = db.get(PersonnelPreferences, user.id)
    with stage("plans"):
        plans = [
            {
                "id": p.id,
                "employee_id": person(p.employee_id),
                "kind": p.kind,
                "date": p.date.isoformat(),
                "end": p.end.isoformat() if p.end else None,
                "dormitory_id": p.dormitory_id,
                "confirmed": p.confirmed,
                "comment": p.comment,
            }
            for p in db.scalars(
                select(EmployeePlan)
                .where(EmployeePlan.dormitory_id.in_(dormitory_ids))
                .order_by(EmployeePlan.date, EmployeePlan.id)
            )
        ]
    with stage("arrivals"):
        arrivals = active_arrivals(db, dormitory_ids)
    columns = source_columns_response(db, context)
    dormitories = dormitory_list(context)
    settings = (
        {"revision": preferences.revision, **preferences.settings}
        if preferences
        else {"revision": 0, "blocks": None, "lists": []}
    )
    response: dict[str, Any] = {
        "today": today().isoformat(),
        "dormitories": dormitories,
        "employees": cards if include_employees else [],
        "source_columns": columns,
        "arrival_plans": arrivals,
        "plans": plans,
        "preferences": settings,
    }
    if include_previews:
        day = today()
        # Отбор у блоков и сводки общий: область, срок вахты, поиск и условия
        # столбцов у них совпадают, отличается только фильтр срока. Без кеша
        # каждый блок заново читал строки-источники, журнал и вахты (#251).
        selection = SelectionCache(
            db=db,
            roots=context.roots,
            identities=context.identities,
            tabs=context.tabs,
            dormitory_ids=context.dormitory_ids,
            day=day,
            dormitories=dormitories,
            source_columns=columns,
            load_sources=sources_loader(db, context),
        )
        with stage("block_previews"):
            response["block_previews"] = block_previews(
                db,
                selection=selection,
                employees=context.employees,
                lists=settings.get("lists") or [],
                blocks=settings.get("blocks"),
                day=day,
                dormitory=preview_dormitory,
                dormitories=dormitories,
                arrivals=arrivals,
                cards_for=lambda ids: cards_by_ids(db, context, ids),
                default_blocks=DEFAULT_BLOCKS,
            )
        # Сводка поверхности: раньше эти три числа считались в браузере по всему
        # массиву карточек, а при `employees=none` массива нет. С #251 числа
        # считает отбор в SQL: у всех трёх фильтров он общий, меняется только срок.
        with stage("counts"):
            response["counts"] = counts_by_filter(
                candidates=selection.get(ListCriteria(dormitory=preview_dormitory, days=days))
            )
    return response


def employee_detail(db: Session, employee_id: str) -> dict[str, Any]:
    ids = group_ids(db, employee_id)
    names = {user.id: user.full_name for user in db.scalars(select(User))}
    events = list(
        db.scalars(
            select(EmployeeEvent)
            .where(EmployeeEvent.employee_id.in_(ids))
            .order_by(EmployeeEvent.happened_on.desc(), EmployeeEvent.id.desc())
        )
    )
    notes = list(
        db.scalars(
            select(EmployeeNote)
            .where(EmployeeNote.employee_id.in_(ids))
            .order_by(EmployeeNote.created_at.desc(), EmployeeNote.id.desc())
        )
    )
    merges = list(
        db.scalars(
            select(EmployeeMerge)
            .where((EmployeeMerge.source_id.in_(ids)) | (EmployeeMerge.target_id.in_(ids)))
            .order_by(EmployeeMerge.created_at.desc())
        )
    )
    return {
        "employee_id": get_employee(db, employee_id).id,
        "events": [
            {
                "id": e.id,
                "kind": e.kind,
                "title": e.title,
                "date": e.happened_on,
                "created_at": e.created_at,
                "actor": names.get(e.actor_id or 0, "Система"),
                "dormitory_id": e.dormitory_id,
                "source_table": e.source_table,
                "source_id": e.source_id,
                "snapshot": e.snapshot,
            }
            for e in events
        ],
        "notes": [
            {
                "id": n.id,
                "text": n.text,
                "author": names.get(n.author_id or 0, "Удалённый пользователь"),
                "created_at": n.created_at,
            }
            for n in notes
        ],
        "merges": [
            {
                "id": m.id,
                "source_id": m.source_id,
                "target_id": m.target_id,
                "reason": m.reason,
                "actor": names.get(m.actor_id or 0, "Система"),
                "created_at": m.created_at,
                "undone_at": m.undone_at,
            }
            for m in merges
        ],
    }

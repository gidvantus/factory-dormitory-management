"""Настройки организации, проверка значений и совместимость старых заездов."""

import re
from datetime import date, time
from decimal import Decimal, InvalidOperation
from typing import Any, cast
from uuid import NAMESPACE_URL, uuid5

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models.arrival_plan import ArrivalPlan, ArrivalSettings
from app.models.dormitory import Dormitory
from app.models.organization import Organization
from app.schemas.arrival_settings import ArrivalField, ArrivalSettingsInput
from app.schemas.personnel import ArrivalInput


def defaults() -> dict[str, Any]:
    definitions = [
        ("shifts", "Кол-во смен", "number", "person", []),
        ("transfer", "Трансфер заказан", "checkbox", "arrival", []),
        ("workdate", "Дата выхода на работу", "date", "person", []),
        ("transport", "Транспорт", "select", "arrival", ["Автобус", "Поезд", "Самостоятельно"]),
        ("comment", "Комментарий", "textarea", "arrival", []),
    ]
    return {
        "fields": [
            {
                "id": id,
                "label": label,
                "type": kind,
                "scope": scope,
                "options": options,
                "required": False,
                "inForm": True,
            }
            for id, label, kind, scope, options in definitions
        ],
        "display": {
            "order": ["transfer", "transport", "names", "shifts", "workdate", "comment"],
            "visible": ["shifts", "transfer", "transport", "names", "workdate"],
            "summary": True,
            "hideEmpty": True,
            "compact": False,
            "namesLimit": 3,
        },
    }


def filled(value: Any) -> bool:
    return value is not None and value != "" and (not isinstance(value, str) or bool(value.strip()))


def effective_people(plan: ArrivalPlan) -> list[dict[str, Any]]:
    result = []
    for index in range(plan.count):
        if plan.people is not None and index < len(plan.people):
            result.append(plan.people[index])
        else:
            name = plan.names[index] if plan.people is None and index < len(plan.names) else ""
            result.append(
                {
                    "id": str(uuid5(NAMESPACE_URL, f"arrival:{plan.id}:{index}")),
                    "full_name": name,
                    "custom_values": {},
                }
            )
    return result


def active_people(plan: ArrivalPlan) -> list[dict[str, Any]]:
    moved = {visit.person_id for visit in plan.visits if visit.status == "moved"}
    return [person for person in effective_people(plan) if person["id"] not in moved]


def collect_values(groups: list[dict[str, Any]]) -> dict[str, list[Any]]:
    result: dict[str, list[Any]] = {}
    for values in groups:
        if not isinstance(values, dict):
            continue
        for id, value in values.items():
            if filled(value):
                result.setdefault(id, []).append(value)
    return result


def used_values(plans: list[ArrivalPlan]) -> dict[str, list[Any]]:
    groups: list[dict[str, Any]] = []
    for plan in plans:
        groups.extend(
            [
                plan.custom_values or {},
                *(person.get("custom_values", {}) for person in (plan.people or [])),
            ]
        )
    return collect_values(groups)


def used_values_by_rows(db: Session, organization_id: int) -> dict[str, list[str]]:
    rows = db.execute(
        select(ArrivalPlan.custom_values, ArrivalPlan.people)
        .join(Dormitory)
        .where(Dormitory.organization_id == organization_id)
    )
    groups: list[dict[str, Any]] = []
    for custom_values, people in rows:
        plan_custom_values = cast(dict[str, Any], custom_values)
        people_values = cast(list[dict[str, Any]] | None, people)
        groups.extend(
            [
                plan_custom_values or {},
                *(person.get("custom_values", {}) for person in (people_values or [])),
            ]
        )
    # Повторяем контракт jsonb_each_text и UNION: текстовые значения без дублей.
    return {
        id: sorted(
            {str(value).lower() if isinstance(value, bool) else str(value) for value in values}
        )
        for id, values in collect_values(groups).items()
    }


def used_values_by_sql(db: Session, organization_id: int) -> dict[str, list[str]]:
    rows = db.execute(
        text(
            """
            SELECT kv.key, kv.value
            FROM arrival_plans AS plan
            JOIN dormitories AS dormitory ON dormitory.id = plan.dormitory_id
            CROSS JOIN LATERAL jsonb_each_text(plan.custom_values::jsonb) AS kv(key, value)
            WHERE dormitory.organization_id = :organization_id
              AND jsonb_typeof(plan.custom_values::jsonb) = 'object'
              AND kv.value IS NOT NULL AND btrim(kv.value) <> ''
            UNION
            SELECT kv.key, kv.value
            FROM arrival_plans AS plan
            JOIN dormitories AS dormitory ON dormitory.id = plan.dormitory_id
            CROSS JOIN LATERAL jsonb_array_elements(plan.people::jsonb) AS person(value)
            CROSS JOIN LATERAL jsonb_each_text((person.value -> 'custom_values')::jsonb)
                AS kv(key, value)
            WHERE dormitory.organization_id = :organization_id
              AND plan.people IS NOT NULL
              AND jsonb_typeof(plan.people::jsonb) = 'array'
              AND jsonb_typeof(person.value -> 'custom_values') = 'object'
              AND kv.value IS NOT NULL AND btrim(kv.value) <> ''
            """
        ),
        {"organization_id": organization_id},
    )
    result: dict[str, list[str]] = {}
    for id, value in rows:
        result.setdefault(cast(str, id), []).append(cast(str, value))
    return {id: sorted(values) for id, values in result.items()}


def organization_used_values(db: Session, organization_id: int) -> dict[str, list[str]]:
    # Юнит-тесты работают на SQLite, где функций PostgreSQL jsonb_* нет.
    if db.get_bind().dialect.name == "postgresql":
        return used_values_by_sql(db, organization_id)
    return used_values_by_rows(db, organization_id)


def settings_response(db: Session, organization_id: int) -> dict[str, Any]:
    row = db.get(ArrivalSettings, organization_id)
    return {
        "revision": row.revision if row else 0,
        **(row.settings if row else defaults()),
        "archived_fields": list((row.retired_fields or {}).values()) if row else [],
        "used_fields": sorted(organization_used_values(db, organization_id)),
    }


def lock_configuration(db: Session, organization_id: int) -> ArrivalSettings | None:
    # Одна блокировка организации сериализует первую запись настроек и правки заездов.
    db.scalar(select(Organization).where(Organization.id == organization_id).with_for_update())
    return db.scalar(
        select(ArrivalSettings)
        .where(ArrivalSettings.organization_id == organization_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def save_settings(
    db: Session, organization_id: int, payload: ArrivalSettingsInput
) -> dict[str, Any]:
    row = lock_configuration(db, organization_id)
    if payload.revision != (row.revision if row else 0):
        raise HTTPException(409, "Настройки уже изменены. Закройте окно и обновите страницу.")
    previous = row.settings if row else defaults()
    retired = dict(row.retired_fields or {}) if row else {}
    old_fields = {**retired, **{field["id"]: field for field in previous["fields"]}}
    used = organization_used_values(db, organization_id)
    for field in payload.fields:
        old = old_fields.get(field.id)
        if not old or field.id not in used:
            continue
        if old["type"] != field.type or old["scope"] != field.scope:
            raise HTTPException(
                409,
                f"Поле «{field.label}» содержит значения. "
                "Добавьте новое поле другого типа или размещения.",
            )
        if field.type == "select" and any(value not in field.options for value in used[field.id]):
            raise HTTPException(409, f"Нельзя убрать используемый вариант поля «{field.label}».")
    active = {field.id for field in payload.fields}
    for field in previous["fields"]:
        if field["id"] not in active:
            retired[field["id"]] = {**field, "required": False, "inForm": False}
    for id in active:
        retired.pop(id, None)
    if len(retired) > 200:
        raise HTTPException(422, "Достигнут предел сохранённых полей плана заездов.")
    if row is None:
        row = ArrivalSettings(organization_id=organization_id, revision=0)
        db.add(row)
    row.settings = payload.model_dump(mode="json", exclude={"revision"})
    row.retired_fields = retired
    row.revision += 1
    db.commit()
    return settings_response(db, organization_id)


def validate_values(values: dict[str, Any], fields: dict[str, ArrivalField], scope: str) -> None:
    for id, value in values.items():
        field = fields.get(id)
        if field is None or field.scope != scope:
            raise HTTPException(422, "Неизвестное поле или неверное размещение. Обновите страницу.")
        if not filled(value):
            continue
        valid = isinstance(value, str) and len(value) <= 4000 and "\x00" not in value
        if field.type == "checkbox":
            valid = isinstance(value, bool)
        elif valid:
            try:
                if field.type == "number":
                    valid = len(value) <= 64 and Decimal(value).is_finite()
                elif field.type == "date":
                    valid = bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value))
                    date.fromisoformat(value)
                elif field.type == "time":
                    valid = bool(re.fullmatch(r"\d{2}:\d{2}(:\d{2})?", value))
                    time.fromisoformat(value)
                elif field.type == "select":
                    valid = value in field.options
                elif field.type == "text":
                    valid = len(value) <= 1000
            except (ValueError, InvalidOperation):
                valid = False
        if not valid:
            raise HTTPException(422, f"Проверьте значение поля «{field.label}».")
    for field in fields.values():
        if field.scope == scope and field.required and field.inForm:
            value = values.get(field.id)
            if not filled(value) or (field.type == "checkbox" and value is not True):
                raise HTTPException(422, f"Заполните обязательное поле «{field.label}».")


def plan_values(
    payload: ArrivalInput, plan: ArrivalPlan, config: ArrivalSettings | None
) -> dict[str, Any]:
    revision = config.revision if config else 0
    if payload.people is not None and payload.settings_revision != revision:
        raise HTTPException(409, "Поля заезда уже изменены. Закройте окно и обновите страницу.")
    configuration = config.settings if config else defaults()
    retired = config.retired_fields or {} if config else {}
    fields = {
        field["id"]: ArrivalField.model_validate(field)
        for field in [*retired.values(), *configuration["fields"]]
    }
    people: list[dict[str, Any]]
    if payload.people is None:
        if used_values([plan]):
            raise HTTPException(
                409, "Запись содержит дополнительные поля. Обновите страницу перед изменением."
            )
        # Для нового количества сохраняются позиционные пустые строки и стабильные ID.
        people = [
            {
                "id": str(uuid5(NAMESPACE_URL, f"arrival:{plan.id}:{index}")),
                "full_name": payload.names[index] if index < len(payload.names) else "",
                "custom_values": {},
            }
            for index in range(payload.count)
        ]
    else:
        people = [person.model_dump(mode="json") for person in payload.people]
    validate_values(payload.custom_values, fields, "arrival")
    total = sum(len(str(value)) for value in payload.custom_values.values())
    for index, person in enumerate(people):
        try:
            validate_values(person["custom_values"], fields, "person")
        except HTTPException as exc:
            raise HTTPException(exc.status_code, f"Человек № {index + 1}: {exc.detail}") from exc
        total += len(person["full_name"]) + sum(
            len(str(value)) for value in person["custom_values"].values()
        )
    if total > 4_000_000:
        raise HTTPException(422, "Слишком большой объём дополнительных сведений заезда.")
    return {
        "dormitory_id": payload.dormitory_id,
        "date": payload.date,
        "count": payload.count,
        "names": [person["full_name"] for person in people if person["full_name"]],
        "people": people,
        "custom_values": payload.custom_values,
    }

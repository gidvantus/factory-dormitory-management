"""Эквивалентность чтения использованных полей заездов на PostgreSQL (#243)."""

from datetime import date
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import delete, select

from app import db as db_module
from app.arrival_settings import (
    collect_values,
    used_values,
    used_values_by_rows,
    used_values_by_sql,
)
from app.models.arrival_plan import ArrivalPlan
from app.models.dormitory import Dormitory
from app.models.organization import Organization


def test_collect_values_skips_broken_groups() -> None:
    groups: list[Any] = [{"false": False, "zero": 0}, None, ["broken"]]

    assert collect_values(groups) == {"false": [False], "zero": [0]}


@pytest.mark.dbtest
def test_sql_and_rows_return_the_same_used_values() -> None:
    """JSONB-текст и портативная выборка совпадают на заполненных и битых данных."""
    marker = uuid4().hex
    with db_module.SessionLocal() as db:
        organization = Organization(name=f"used-fields-{marker}")
        db.add(organization)
        db.flush()
        dormitory = Dormitory(
            organization_id=organization.id,
            name=f"Общежитие {marker}",
            client_name="Тест",
        )
        db.add(dormitory)
        db.flush()
        plans = [
            ArrivalPlan(
                dormitory_id=dormitory.id,
                date=date(2026, 1, 1),
                count=1,
                names=[],
                custom_values={
                    "false": False,
                    "zero": 0,
                    "numeric": "12",
                    "spaces": "   ",
                    "empty": "",
                    "null": None,
                    "duplicate": "same",
                },
                people=[
                    {"full_name": "Первый", "custom_values": {"duplicate": "same"}},
                    {"full_name": "Без дополнительных полей"},
                    {"full_name": "Битые поля", "custom_values": None},
                ],
            ),
            ArrivalPlan(
                dormitory_id=dormitory.id,
                date=date(2026, 1, 2),
                count=1,
                names=[],
                custom_values={"without_people": "yes"},
                people=None,
            ),
            ArrivalPlan(
                dormitory_id=dormitory.id,
                date=date(2026, 1, 3),
                count=1,
                names=[],
                custom_values={"empty_people": "yes"},
                people=[],
            ),
            ArrivalPlan(
                dormitory_id=dormitory.id,
                date=date(2026, 1, 4),
                count=1,
                names=[],
                custom_values={},
                people=[{"full_name": "Без полей"}],
            ),
        ]
        db.add_all(plans)
        db.commit()
        try:
            stored = list(
                db.scalars(
                    select(ArrivalPlan)
                    .where(ArrivalPlan.dormitory_id == dormitory.id)
                    .order_by(ArrivalPlan.date)
                )
            )
            by_rows = used_values_by_rows(db, organization.id)
            by_sql = used_values_by_sql(db, organization.id)

            assert by_rows == by_sql
            assert by_sql == {
                "false": ["false"],
                "zero": ["0"],
                "numeric": ["12"],
                "duplicate": ["same"],
                "without_people": ["yes"],
                "empty_people": ["yes"],
            }
            assert all(isinstance(value, str) for values in by_sql.values() for value in values)

            legacy = used_values(stored)
            assert legacy["false"] == [False]
            assert legacy["zero"] == [0]
            assert legacy["duplicate"] == ["same", "same"]
            assert set(legacy) == set(by_sql)
        finally:
            db.execute(delete(ArrivalPlan).where(ArrivalPlan.dormitory_id == dormitory.id))
            db.execute(delete(Dormitory).where(Dormitory.id == dormitory.id))
            db.execute(delete(Organization).where(Organization.id == organization.id))
            db.commit()

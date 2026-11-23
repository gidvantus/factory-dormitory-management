"""Стоимость `GET /api/personnel` на объёме стенда — с разбивкой по этапам (#237).

Прогон идёт только на стенде: `python -m pytest -q -m dbtest` внутри контейнера
`api`, где `DATABASE_URL` указывает на живой PostgreSQL. В юнит-прогоне теста нет
(`addopts` в `pyproject.toml` снимает метку `dbtest`): на SQLite времена не
показывают ничего, а объём в десятки тысяч строк там только замедлил бы прогон.

Тест отвечает на вопрос постановки: сколько времени обработчик тратит вне базы и
из чего это время состоит. Он печатает разбивку по этапам и SQL-время, поэтому
запускается с `-s` — цифры видны в выводе. Утверждения касаются состава ответа и
наличия этапов, а не миллисекунд: время в CI плавает.

Строки, которые тест заводит, он же и уносит: стенд — настоящая база.
Объём задаётся переменными окружения `PERF_EMPLOYEES` и `PERF_ROWS`, чтобы
прогон можно было повторить на меньшем объёме.
"""

import json
import os
import time
from datetime import UTC, date, datetime
from uuid import uuid4

import pytest
from sqlalchemy import delete, insert, select
from sqlalchemy.orm import Session

from app import db as db_module
from app import personnel_page, sql_diagnostics
from app.arrival_settings import settings_response
from app.models.arrival_plan import ArrivalPlan
from app.models.dormitory import Dormitory
from app.models.organization import Organization
from app.models.personnel import Employee, EmployeeEvent, EmployeePlan
from app.models.resident import Resident
from app.models.user import User
from app.personnel import (
    dormitory_list,
    employee_cards,
    today,
    workspace,
    workspace_context,
)

# Объём по умолчанию — крупная организация: две тысячи карточек и двадцать тысяч
# строк-источников. Это тот же порядок, на котором снимался профиль в #237.
EMPLOYEES = int(os.environ.get("PERF_EMPLOYEES", "2000"))
ROWS = int(os.environ.get("PERF_ROWS", "20000"))
# Журнал на десятую часть строк: он тоже читается целиком по области.
EVENTS = max(ROWS // 10, 1)
PLANS = max(EMPLOYEES // 10, 1)
# Фиксированный момент создания: строки теста не должны выглядеть свежими.
CREATED_AT = datetime(2026, 1, 1, 9, 30, tzinfo=UTC)
CHUNK = 1000


def build_stand(db: Session) -> tuple[int, int, str]:
    """Завести организацию, общежитие и объём строк. Возвращает ключи для уборки."""
    marker = uuid4().hex[:8]
    organization = Organization(name=f"Нагрузка {marker}")
    db.add(organization)
    db.flush()
    user = User(
        email=f"perf-{marker}@example.com",
        full_name="Нагрузка Тест",
        password_hash="x",
    )
    db.add(user)
    db.flush()
    dormitory = Dormitory(
        organization_id=organization.id,
        created_by_id=user.id,
        name=f"Общежитие {marker}",
        client_name="Стройкомплект",
    )
    db.add(dormitory)
    db.flush()

    employee_ids = [f"perf-{marker}-{index:05d}" for index in range(EMPLOYEES)]
    for start in range(0, EMPLOYEES, CHUNK):
        db.execute(
            insert(Employee),
            [
                {
                    "id": employee_id,
                    "full_name": f"Семёнов Иван Иванович {index}",
                    "personnel_number": f"Т-{index}",
                    "phone": f"+7 912 {index:07d}"[:20],
                    "identity_status": "confirmed",
                    "created_at": CREATED_AT,
                }
                for index, employee_id in enumerate(
                    employee_ids[start : start + CHUNK], start=start
                )
            ],
        )
    # Строки-источники: поровну на все карточки, чтобы сборка ответа не была
    # вырожденной (у одной карточки всё, у остальных ничего).
    for start in range(0, ROWS, CHUNK):
        db.execute(
            insert(Resident),
            [
                {
                    "dormitory_id": dormitory.id,
                    "employee_id": employee_ids[index % EMPLOYEES],
                    "full_name": f"Проживающий {index}",
                    "personnel_number": f"Т-{index}",
                    "phone": "+7 912 000 00 00",
                    "created_at": CREATED_AT,
                }
                for index in range(start, min(start + CHUNK, ROWS))
            ],
        )
    for start in range(0, EVENTS, CHUNK):
        db.execute(
            insert(EmployeeEvent),
            [
                {
                    "employee_id": employee_ids[index % EMPLOYEES],
                    "dormitory_id": dormitory.id,
                    "kind": "identity",
                    "title": "Карточка подтверждена",
                    "happened_on": date(2026, 1, 5),
                    "created_at": CREATED_AT,
                }
                for index in range(start, min(start + CHUNK, EVENTS))
            ],
        )
    for start in range(0, PLANS, CHUNK):
        db.execute(
            insert(EmployeePlan),
            [
                {
                    "id": f"perf-plan-{marker}-{index:05d}",
                    "employee_id": employee_ids[index % EMPLOYEES],
                    "dormitory_id": dormitory.id,
                    "kind": "arrival",
                    "date": date(2026, 2, 1),
                    "end": date(2026, 2, 10),
                    "confirmed": True,
                }
                for index in range(start, min(start + CHUNK, PLANS))
            ],
        )
    db.execute(
        insert(ArrivalPlan),
        [
            {
                "id": f"perf-arrival-{marker}-{index:02d}",
                "dormitory_id": dormitory.id,
                "date": date(2026, 2, 1 + index),
                "count": 1,
                "names": ["Заезд Один"],
                "people": [
                    {
                        "id": f"perf-arrival-person-{marker}-{index:02d}",
                        "full_name": "Заезд Один",
                        "custom_values": {},
                    }
                ],
                "custom_values": {},
            }
            for index in range(5)
        ],
    )
    db.commit()
    return dormitory.id, organization.id, marker


def clean_stand(db: Session, dormitory_id: int, organization_id: int, marker: str) -> None:
    """Убрать ровно то, что завёл тест: по своим ключам, не по всей таблице."""
    db.execute(delete(ArrivalPlan).where(ArrivalPlan.dormitory_id == dormitory_id))
    db.execute(delete(EmployeePlan).where(EmployeePlan.dormitory_id == dormitory_id))
    db.execute(delete(EmployeeEvent).where(EmployeeEvent.dormitory_id == dormitory_id))
    db.execute(delete(Resident).where(Resident.dormitory_id == dormitory_id))
    db.execute(delete(Employee).where(Employee.id.like(f"perf-{marker}-%")))
    db.execute(delete(Dormitory).where(Dormitory.id == dormitory_id))
    db.execute(delete(User).where(User.email == f"perf-{marker}@example.com"))
    db.execute(delete(Organization).where(Organization.id == organization_id))
    db.commit()


def report(title: str, elapsed_ms: float, request_sql: sql_diagnostics.RequestSql) -> None:
    """Печатать разбивку — это и есть результат замера, а не побочный эффект."""
    print(f"\n{title}: {elapsed_ms:.0f} мс")
    print(f"  SQL: {request_sql.total_ms:.0f} мс в {request_sql.count} выполнениях")
    print(f"  доля SQL: {request_sql.total_ms / elapsed_ms:.1%}")
    for name, duration_ms in sql_diagnostics.stages_breakdown(request_sql).items():
        print(f"  этап {name}: {duration_ms:.0f} мс")


@pytest.mark.dbtest
def test_workspace_cost_is_accounted_for_by_stages() -> None:
    """Весь объём работы обработчика виден по этапам, ответ собирается целиком."""
    with db_module.SessionLocal() as db:
        dormitory_id, organization_id, marker = build_stand(db)
        user = db.scalar(select(User).where(User.email == f"perf-{marker}@example.com"))
        assert user is not None
        try:
            token = sql_diagnostics.start_request("perf-workspace")
            started = time.perf_counter()
            try:
                data = workspace(db, user, [dormitory_id])
            finally:
                elapsed_ms = (time.perf_counter() - started) * 1000
                request_sql = sql_diagnostics.current()
                sql_diagnostics.finish_request(token)
            assert request_sql is not None
            report("workspace", elapsed_ms, request_sql)

            assert len(data["employees"]) == EMPLOYEES
            assert sum(len(card["sources"]) for card in data["employees"]) == ROWS
            assert set(request_sql.stages_ms) == {
                "sources",
                "events",
                "assemble",
                "plans",
                "arrivals",
            }
            # Этапы покрывают почти всё время Python: непокрытый остаток — это
            # загрузка справочников и предпочтений, она мала по определению.
            assert sum(request_sql.stages_ms.values()) <= elapsed_ms

            settings_token = sql_diagnostics.start_request("perf-settings")
            started = time.perf_counter()
            try:
                settings_response(db, organization_id)
            finally:
                settings_elapsed = (time.perf_counter() - started) * 1000
                settings_sql = sql_diagnostics.current()
                sql_diagnostics.finish_request(settings_token)
            assert settings_sql is not None
            report("settings", settings_elapsed, settings_sql)
        finally:
            clean_stand(db, dormitory_id, organization_id, marker)


@pytest.mark.dbtest
def test_page_cost_and_body_size_on_the_same_volume() -> None:
    """Страница по 20 карточек вместо всех: время и объём тела (#247).

    Числа печатаются, утверждения касаются состава ответа и доли тела: страница
    не должна расти вместе с организацией, а полная поверхность — оставаться
    прежней. Объём тела сравнивается с полным ответом, а не с фиксированными
    килобайтами: на этом объёме у карточки десять строк-источников, и она тяжелее
    реальной. Сравнение времени вариантов видно в `report`.
    """
    with db_module.SessionLocal() as db:
        dormitory_id, organization_id, marker = build_stand(db)
        user = db.scalar(select(User).where(User.email == f"perf-{marker}@example.com"))
        assert user is not None
        try:
            today_iso = today().isoformat()
            token = sql_diagnostics.start_request("perf-page")
            started = time.perf_counter()
            try:
                context = workspace_context(db, [dormitory_id])
                cards = employee_cards(db, context)
                items, total = personnel_page.page(
                    cards,
                    personnel_page.ListCriteria(),
                    today_iso,
                    dormitory_list(context),
                    [],
                    1,
                    20,
                )
                body = json.dumps(
                    {
                        "items": items,
                        "total": total,
                        "page": 1,
                        "per_page": 20,
                        "pages": -(-total // 20),
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            finally:
                page_elapsed = (time.perf_counter() - started) * 1000
                page_sql = sql_diagnostics.current()
                sql_diagnostics.finish_request(token)
            assert page_sql is not None
            report("page (20 карточек)", page_elapsed, page_sql)

            token = sql_diagnostics.start_request("perf-frame")
            started = time.perf_counter()
            try:
                frame = workspace(
                    db, user, [dormitory_id], include_employees=False, include_previews=True
                )
                frame_body = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
            finally:
                frame_elapsed = (time.perf_counter() - started) * 1000
                frame_sql = sql_diagnostics.current()
                sql_diagnostics.finish_request(token)
            assert frame_sql is not None
            report("workspace employees=none", frame_elapsed, frame_sql)

            token = sql_diagnostics.start_request("perf-full")
            started = time.perf_counter()
            try:
                full = workspace(db, user, [dormitory_id])
                full_body = json.dumps(full, ensure_ascii=False, separators=(",", ":"))
            finally:
                full_elapsed = (time.perf_counter() - started) * 1000
                full_sql = sql_diagnostics.current()
                sql_diagnostics.finish_request(token)
            assert full_sql is not None
            report("workspace employees=full", full_elapsed, full_sql)
            full_size = len(full_body.encode())
            page_size = len(body.encode())
            frame_size = len(frame_body.encode())
            print(f"\n  тело полной поверхности: {full_size / 1024:.0f} КБ")
            print(f"  тело страницы: {page_size / 1024:.0f} КБ")
            print(f"  тело рамки без карточек: {frame_size / 1024:.0f} КБ")

            assert total == EMPLOYEES
            assert len(items) == 20
            # Главное требование постановки: страница не растёт с числом людей.
            # Тело страницы — доля полного тела, а не фиксированные 50 КБ: на этом
            # объёме у человека десять строк-источников, и карточка тяжелее реальной.
            assert page_size * 50 <= full_size, (page_size, full_size)
            assert frame_size * 10 <= full_size, (frame_size, full_size)
            assert frame["employees"] == [] and len(frame["block_previews"]) == 4
            assert set(frame_sql.stages_ms) >= {
                "sources",
                "events",
                "assemble",
                "plans",
                "arrivals",
                "block_previews",
            }
        finally:
            clean_stand(db, dormitory_id, organization_id, marker)

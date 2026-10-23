"""Привязка существующих корневых объектов к организации на настоящей PostgreSQL.

Прогон идёт только на стенде: `pytest -m dbtest` внутри контейнера `api`, где
`DATABASE_URL` указывает на живой PostgreSQL, а схема — на голове дерева ревизий.
В юнит-прогоне (SQLite) тест не участвует: `addopts` в `pyproject.toml` снимает
метку `dbtest`, а `UPDATE ... FROM` SQLite всё равно не умеет.

Зачем тест. Backfill ревизии `0045_organization_root_objects` — единственная
необратимая запись этой задачи: строку, которую привязать не удалось, больше не
увидит никто (`organization_id IS NULL` = объект не виден никому). Проверяется
поведение, а не текст: три строки с разными авторами — автор с организацией,
автор без организации, отсутствующий автор. Первая обязана получить организацию,
две другие — остаться `NULL`.

SQL берётся из самого модуля ревизии (`BACKFILL_SQL`), а не переписывается здесь:
переписанное правило разошлось бы с миграцией, и опечатка в join прошла бы мимо
проверки. DDL миграции тестом не покрывается — его проверяет
`alembic upgrade/downgrade` на стенде.

Строки и пользователей, которых заводит тест, он же и уносит: база стенда
настоящая, и мусорить в ней нечем.
"""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType
from uuid import uuid4

import pytest
from sqlalchemy import text

from app import db as db_module

MIGRATION_PATH = (
    Path(__file__).resolve().parents[1] / "alembic/versions/0045_organization_root_objects.py"
)

INSERT_ORGANIZATION_SQL = text("INSERT INTO organizations (name) VALUES (:name) RETURNING id")
INSERT_USER_SQL = text(
    """
    INSERT INTO users (email, full_name, password_hash, is_active, active_organization_id)
    VALUES (:email, 'Тест привязки', 'not-a-real-hash', false, :organization_id)
    RETURNING id
    """
)
INSERT_TEMPLATE_SQL = text(
    "INSERT INTO report_templates (name, created_by_id) VALUES (:name, :created_by_id) RETURNING id"
)
SELECT_ORGANIZATION_SQL = text(
    "SELECT organization_id FROM report_templates WHERE id = :template_id"
)
DELETE_TEMPLATE_SQL = text("DELETE FROM report_templates WHERE id = :template_id")
DELETE_USER_SQL = text("DELETE FROM users WHERE id = :user_id")
DELETE_ORGANIZATION_SQL = text("DELETE FROM organizations WHERE id = :organization_id")


def backfill_sql() -> str:
    """Тот же `UPDATE`, что выполняет миграция, — из её модуля, не из теста."""
    spec = spec_from_file_location("organization_root_migration", MIGRATION_PATH)
    assert spec and spec.loader
    migration: ModuleType = module_from_spec(spec)
    spec.loader.exec_module(migration)
    sql: str = migration.BACKFILL_SQL.format(table="report_templates")
    return sql


@pytest.mark.dbtest
def test_backfill_binds_author_organization_and_leaves_the_rest_invisible() -> None:
    """Организацию получает только строка автора, у которого она есть."""
    marker = uuid4().hex
    templates: list[int] = []
    users: list[int] = []
    organization_id: int | None = None

    with db_module.SessionLocal() as db:
        try:
            organization_id = db.scalar(INSERT_ORGANIZATION_SQL, {"name": f"backfill-{marker}"})
            assert organization_id is not None
            author_id = db.scalar(
                INSERT_USER_SQL,
                {
                    "email": f"backfill-author-{marker}@example.com",
                    "organization_id": organization_id,
                },
            )
            without_organization_id = db.scalar(
                INSERT_USER_SQL,
                {
                    "email": f"backfill-orphan-{marker}@example.com",
                    "organization_id": None,
                },
            )
            assert author_id is not None and without_organization_id is not None
            users = [author_id, without_organization_id]

            with_author = db.scalar(
                INSERT_TEMPLATE_SQL,
                {"name": f"with-author-{marker}", "created_by_id": author_id},
            )
            without_organization = db.scalar(
                INSERT_TEMPLATE_SQL,
                {
                    "name": f"without-organization-{marker}",
                    "created_by_id": without_organization_id,
                },
            )
            without_author = db.scalar(
                INSERT_TEMPLATE_SQL,
                {"name": f"without-author-{marker}", "created_by_id": None},
            )
            assert (
                with_author is not None
                and without_organization is not None
                and without_author is not None
            )
            templates = [with_author, without_organization, without_author]

            db.execute(text(backfill_sql()))

            assert (
                db.scalar(SELECT_ORGANIZATION_SQL, {"template_id": with_author}) == organization_id
            )
            # Автор без организации и отсутствующий автор: строки не привязаны
            # и остаются невидимыми — это правило `NULL`, а не потеря в join.
            assert db.scalar(SELECT_ORGANIZATION_SQL, {"template_id": without_organization}) is None
            assert db.scalar(SELECT_ORGANIZATION_SQL, {"template_id": without_author}) is None
        finally:
            for template_id in templates:
                db.execute(DELETE_TEMPLATE_SQL, {"template_id": template_id})
            for user_id in users:
                db.execute(DELETE_USER_SQL, {"user_id": user_id})
            if organization_id is not None:
                db.execute(DELETE_ORGANIZATION_SQL, {"organization_id": organization_id})
            db.commit()

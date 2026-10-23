"""Раскладка дашборда по организациям: перенос синглтона и backfill блоков.

Две проверки разной природы:

* **Правило копирования** (`scoped_layout`) и совпадение порядка по умолчанию с
  моделью — юнит-тесты: функция чистая, база ей не нужна.
* **Backfill блоков** — `dbtest` на настоящей PostgreSQL: `UPDATE ... FROM`
  SQLite не умеет, а именно этот `UPDATE` решает, увидит ли организация свои
  блоки. SQL берётся из модуля ревизии (`BACKFILL_SQL`), а не переписывается
  здесь: переписанное правило разошлось бы с миграцией, и опечатка в join
  прошла бы мимо проверки.

DDL ревизии тестом не покрывается — его проверяет `alembic upgrade/downgrade`
на стенде.
"""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType
from uuid import uuid4

import pytest
from alembic.script import ScriptDirectory
from sqlalchemy import text

from app import db as db_module
from app.models.dashboard_block import DEFAULT_DASHBOARD_ORDER

MIGRATION_PATH = (
    Path(__file__).resolve().parents[1] / "alembic/versions/0046_dashboard_per_organization.py"
)
REVISION = "0046_dashboard_per_organization"
PARENT = "0045_organization_root_objects"

INSERT_ORGANIZATION_SQL = text("INSERT INTO organizations (name) VALUES (:name) RETURNING id")
INSERT_USER_SQL = text(
    """
    INSERT INTO users (email, full_name, password_hash, is_active, active_organization_id)
    VALUES (:email, 'Тест блоков', 'not-a-real-hash', false, :organization_id)
    RETURNING id
    """
)
INSERT_BLOCK_SQL = text(
    "INSERT INTO dashboard_blocks (config, created_by_id) "
    "VALUES (CAST('{}' AS json), :created_by_id) RETURNING id"
)
SELECT_ORGANIZATION_SQL = text("SELECT organization_id FROM dashboard_blocks WHERE id = :block_id")
DELETE_BLOCK_SQL = text("DELETE FROM dashboard_blocks WHERE id = :block_id")
DELETE_USER_SQL = text("DELETE FROM users WHERE id = :user_id")
DELETE_ORGANIZATION_SQL = text("DELETE FROM organizations WHERE id = :organization_id")


def load_migration() -> ModuleType:
    spec = spec_from_file_location("dashboard_per_organization_migration", MIGRATION_PATH)
    assert spec and spec.loader
    migration: ModuleType = module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_migration_sits_on_top_of_the_previous_head() -> None:
    migration = load_migration()

    assert migration.revision == REVISION
    assert migration.down_revision == PARENT


def test_revision_tree_has_exactly_one_head() -> None:
    """Вторая голова означает `alembic upgrade head` с «Multiple head revisions»."""
    scripts = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic"))

    assert len(scripts.get_heads()) == 1


def test_default_order_matches_the_model() -> None:
    """Копия порядка в миграции не разошлась с `DEFAULT_DASHBOARD_ORDER`."""
    assert load_migration().DEFAULT_ORDER == DEFAULT_DASHBOARD_ORDER


def test_legacy_layout_is_copied_without_foreign_custom_keys() -> None:
    scoped_layout = load_migration().scoped_layout
    order = ["turnover", "residents", "custom:7", "attendance", "reports", "custom:9"]
    hidden = ["attendance", "custom:7", "custom:9"]

    # Организация владеет блоком 9: его ключ остаётся, ключ чужого блока 7 уходит.
    assert scoped_layout(order, hidden, ["custom:9"]) == (
        ["turnover", "residents", "attendance", "reports", "custom:9"],
        ["attendance", "custom:9"],
    )


def test_organization_without_blocks_gets_the_built_in_order() -> None:
    scoped_layout = load_migration().scoped_layout

    assert scoped_layout(DEFAULT_DASHBOARD_ORDER, [], []) == (DEFAULT_DASHBOARD_ORDER, [])


def test_own_blocks_missing_from_the_legacy_order_are_appended() -> None:
    scoped_layout = load_migration().scoped_layout

    order, hidden = scoped_layout(DEFAULT_DASHBOARD_ORDER, [], ["custom:3", "custom:5"])

    assert order == [*DEFAULT_DASHBOARD_ORDER, "custom:3", "custom:5"]
    assert hidden == []


@pytest.mark.dbtest
def test_backfill_binds_the_authors_organization_and_leaves_the_rest_invisible() -> None:
    """Организацию получает только блок автора, у которого она есть."""
    migration = load_migration()
    marker = uuid4().hex
    blocks: list[int] = []
    users: list[int] = []
    organization_id: int | None = None

    with db_module.SessionLocal() as db:
        try:
            organization_id = db.scalar(INSERT_ORGANIZATION_SQL, {"name": f"blocks-{marker}"})
            assert organization_id is not None
            author_id = db.scalar(
                INSERT_USER_SQL,
                {
                    "email": f"blocks-author-{marker}@example.com",
                    "organization_id": organization_id,
                },
            )
            without_organization_id = db.scalar(
                INSERT_USER_SQL,
                {"email": f"blocks-orphan-{marker}@example.com", "organization_id": None},
            )
            assert author_id is not None and without_organization_id is not None
            users = [author_id, without_organization_id]

            with_author = db.scalar(INSERT_BLOCK_SQL, {"created_by_id": author_id})
            without_organization = db.scalar(
                INSERT_BLOCK_SQL, {"created_by_id": without_organization_id}
            )
            without_author = db.scalar(INSERT_BLOCK_SQL, {"created_by_id": None})
            assert (
                with_author is not None
                and without_organization is not None
                and without_author is not None
            )
            blocks = [with_author, without_organization, without_author]

            db.execute(text(migration.BACKFILL_SQL))

            assert db.scalar(SELECT_ORGANIZATION_SQL, {"block_id": with_author}) == organization_id
            # Автор без организации и отсутствующий автор: блоки не привязаны
            # и остаются невидимыми — это правило `NULL`, а не потеря в join.
            assert db.scalar(SELECT_ORGANIZATION_SQL, {"block_id": without_organization}) is None
            assert db.scalar(SELECT_ORGANIZATION_SQL, {"block_id": without_author}) is None
        finally:
            for block_id in blocks:
                db.execute(DELETE_BLOCK_SQL, {"block_id": block_id})
            for user_id in users:
                db.execute(DELETE_USER_SQL, {"user_id": user_id})
            if organization_id is not None:
                db.execute(DELETE_ORGANIZATION_SQL, {"organization_id": organization_id})
            db.commit()

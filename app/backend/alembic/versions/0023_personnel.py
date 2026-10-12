"""Карточки сотрудников и связи с исходными таблицами; без автоматического объединения."""

import re
from datetime import date, datetime
from uuid import uuid4

import sqlalchemy as sa

from alembic import op

revision = "0023_personnel"
down_revision = "0022_statistics_reports"
branch_labels = None
depends_on = None


def employee_column(name="employee_id", **kwargs):
    return sa.Column(name, sa.String(36), sa.ForeignKey("employees.id"), **kwargs)


def user_column(name):
    return sa.Column(name, sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"))


def timestamp(name="created_at", nullable=False):
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        nullable=nullable,
        server_default=None if nullable else sa.func.now(),
    )


def upgrade() -> None:
    op.create_table(
        "employees",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("full_name", sa.String(255)),
        sa.Column("personnel_number", sa.String(40)),
        sa.Column("phone", sa.String(30)),
        sa.Column("identity_status", sa.String(16), nullable=False, server_default="pending"),
        employee_column("merged_into_id"),
        timestamp(),
    )
    op.create_index("ix_employees_merged_into_id", "employees", ["merged_into_id"])
    op.create_table(
        "employee_aliases",
        sa.Column("id", sa.Integer(), primary_key=True),
        employee_column(nullable=False),
        sa.Column("field", sa.String(24), nullable=False),
        sa.Column("value", sa.String(255), nullable=False),
        sa.Column("raw_value", sa.String(255), nullable=False),
        sa.UniqueConstraint("employee_id", "field", "value", name="uq_employee_alias"),
    )
    op.create_index("ix_employee_aliases_employee_id", "employee_aliases", ["employee_id"])
    op.create_index("ix_employee_aliases_value", "employee_aliases", ["value"])
    op.create_table(
        "employee_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        employee_column(nullable=False),
        sa.Column(
            "dormitory_id", sa.Integer(), sa.ForeignKey("dormitories.id", ondelete="SET NULL")
        ),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("source_table", sa.String(32)),
        sa.Column("source_id", sa.Integer()),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("happened_on", sa.Date(), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        user_column("actor_id"),
        timestamp(),
    )
    op.create_index("ix_employee_events_employee_id", "employee_events", ["employee_id"])
    op.create_index("ix_employee_events_dormitory_id", "employee_events", ["dormitory_id"])
    for table in (
        "residents",
        "personnel_inflow",
        "personnel_outflow",
        "custom_tab_entries",
        "archive_entries",
    ):
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("employee_id", sa.String(36), nullable=True))
            batch.create_foreign_key(f"fk_{table}_employee", "employees", ["employee_id"], ["id"])
            batch.create_index(f"ix_{table}_employee_id", ["employee_id"])
    op.create_table(
        "employee_tasks",
        sa.Column("id", sa.String(36), primary_key=True),
        employee_column(nullable=False),
        sa.Column("text", sa.String(300), nullable=False),
        sa.Column("due", sa.Date(), nullable=False),
        user_column("assignee_id"),
        sa.Column("done", sa.Boolean(), nullable=False, server_default=sa.false()),
        user_column("created_by_id"),
        timestamp(),
    )
    op.create_table(
        "employee_notes",
        sa.Column("id", sa.String(36), primary_key=True),
        employee_column(nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        user_column("author_id"),
        timestamp(),
    )
    op.create_table(
        "employee_plans",
        sa.Column("id", sa.String(36), primary_key=True),
        employee_column(nullable=False),
        sa.Column("kind", sa.String(12), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("end", sa.Date()),
        sa.Column("dormitory_id", sa.Integer(), sa.ForeignKey("dormitories.id"), nullable=False),
        sa.Column("confirmed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("comment", sa.Text(), nullable=False, server_default=""),
        user_column("created_by_id"),
        timestamp(),
    )
    for table in ("employee_tasks", "employee_notes", "employee_plans"):
        op.create_index(f"ix_{table}_employee_id", table, ["employee_id"])
    op.create_index("ix_employee_plans_date", "employee_plans", ["date"])
    op.create_index("ix_employee_plans_dormitory_id", "employee_plans", ["dormitory_id"])
    op.create_table(
        "employee_decisions",
        sa.Column(
            "resident_id",
            sa.Integer(),
            sa.ForeignKey("residents.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        employee_column(nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("date", sa.Date()),
        sa.Column("original_end", sa.Date()),
        sa.Column("comment", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "plan_id", sa.String(36), sa.ForeignKey("employee_plans.id", ondelete="SET NULL")
        ),
    )
    op.create_index("ix_employee_decisions_employee_id", "employee_decisions", ["employee_id"])
    op.create_table(
        "employee_merges",
        sa.Column("id", sa.String(36), primary_key=True),
        employee_column("source_id", nullable=False),
        employee_column("target_id", nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        user_column("actor_id"),
        timestamp(),
        timestamp("undone_at", nullable=True),
        user_column("undone_by_id"),
    )
    op.create_index("ix_employee_merges_source_id", "employee_merges", ["source_id"])
    op.create_index("ix_employee_merges_target_id", "employee_merges", ["target_id"])
    op.create_table(
        "employee_separations",
        sa.Column("pair", sa.String(73), primary_key=True),
        sa.Column("signature", sa.String(64), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        user_column("actor_id"),
    )
    op.create_table(
        "personnel_preferences",
        sa.Column(
            "user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("settings", sa.JSON(), nullable=False),
    )
    op.create_table(
        "personnel_bindings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "dormitory_id",
            sa.Integer(),
            sa.ForeignKey("dormitories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("table_key", sa.String(32), nullable=False),
        sa.Column("fields", sa.JSON(), nullable=False),
        sa.UniqueConstraint("dormitory_id", "table_key", name="uq_personnel_binding"),
    )
    op.create_index("ix_personnel_bindings_dormitory_id", "personnel_bindings", ["dormitory_id"])
    backfill()


def normalized(field, value):
    if field == "phone":
        digits = re.sub(r"\D", "", value)
        return "7" + digits[1:] if len(digits) == 11 and digits.startswith("8") else digits
    return " ".join(re.sub(r"[^\w\s]", " ", value.casefold().replace("ё", "е")).split())


def backfill():
    connection = op.get_bind()
    meta = sa.MetaData()
    employees = sa.Table("employees", meta, autoload_with=connection)
    aliases = sa.Table("employee_aliases", meta, autoload_with=connection)
    events = sa.Table("employee_events", meta, autoload_with=connection)
    dorm_table = sa.Table("dormitories", meta, autoload_with=connection)
    dorms = {row["id"]: row for row in connection.execute(sa.select(dorm_table)).mappings()}
    hostel_table = sa.Table("hostels", meta, autoload_with=connection)
    hostels = {row["id"]: row["name"] for row in connection.execute(sa.select(hostel_table)).mappings()}
    sources = (
        ("residents", "residents", "arrival", "shift_start"),
        ("personnel_inflow", "inflow", "arrival", "settlement_date"),
        ("personnel_outflow", "outflow", "outflow", "departure_date"),
    )
    for name, key, kind, date_field in sources:
        table = sa.Table(name, meta, autoload_with=connection)
        for row in connection.execute(sa.select(table)).mappings():
            identity = {
                field: row.get(field) for field in ("full_name", "personnel_number", "phone")
            }
            if not any(
                value
                for field, value in row.items()
                if field not in ("id", "dormitory_id", "created_at", "employee_id")
            ):
                continue
            employee_id = str(uuid4())
            connection.execute(
                employees.insert().values(id=employee_id, identity_status="pending", **identity)
            )
            connection.execute(
                table.update().where(table.c.id == row["id"]).values(employee_id=employee_id)
            )
            for field, raw in identity.items():
                if raw and (value := normalized(field, raw)):
                    connection.execute(
                        aliases.insert().values(
                            employee_id=employee_id, field=field, value=value, raw_value=raw
                        )
                    )
            snapshot = {
                field: value.isoformat() if isinstance(value, (date, datetime)) else value
                for field, value in row.items()
                if field != "employee_id"
            }
            dorm = dorms.get(row["dormitory_id"])
            snapshot["dormitory_name"] = dorm["name"] if dorm else "Удалённое общежитие"
            snapshot["client_name"] = dorm["client_name"] if dorm else ""
            snapshot["source_name"] = {"residents":"Проживающие","inflow":"Приток","outflow":"Отток"}[key]
            if name == "residents" and row.get("hostel_id"):
                snapshot["hostel_name"] = hostels.get(row["hostel_id"])
            happened = row[date_field] or row["created_at"].date()
            connection.execute(
                events.insert().values(
                    employee_id=employee_id,
                    dormitory_id=row["dormitory_id"],
                    kind=kind,
                    source_table=key,
                    source_id=row["id"],
                    title="Существующая запись · требуется проверка личности",
                    happened_on=happened,
                    snapshot=snapshot,
                )
            )


def downgrade() -> None:
    for table in (
        "personnel_bindings",
        "personnel_preferences",
        "employee_separations",
        "employee_merges",
        "employee_decisions",
        "employee_plans",
        "employee_notes",
        "employee_tasks",
    ):
        op.drop_table(table)
    for table in (
        "residents",
        "personnel_inflow",
        "personnel_outflow",
        "custom_tab_entries",
        "archive_entries",
    ):
        with op.batch_alter_table(table) as batch:
            batch.drop_index(f"ix_{table}_employee_id")
            batch.drop_constraint(f"fk_{table}_employee", type_="foreignkey")
            batch.drop_column("employee_id")
    op.drop_table("employee_events")
    op.drop_table("employee_aliases")
    op.drop_table("employees")

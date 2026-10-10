"""Организации и членство в них.

Владелец появляется в момент активации кабинета: пустая организация (без
названия и ИНН) плюс строка членства с ролью `owner`. Приглашённый сотрудник
добавляется в организацию приглашающего с ролью `admin`, `manager` или
`commandant` ещё до того, как задаст пароль. Роль хранится строкой с `CHECK`,
а не enum-типом Postgres: набор ролей ещё будет меняться, а ALTER TYPE
на enum тянет за собой отдельную возню с миграцией значений.

ИНН уникален, но nullable: пустая заготовка организации — нормальное состояние,
а в Postgres несколько `NULL` в уникальном индексе друг другу не мешают.
"""

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

# Роли участника организации. Порядок — как в `CHECK`: сначала те, что выдаются
# сейчас (`owner` — активацией кабинета, остальные — приглашением), последним
# идёт устаревшее `member`: оно остаётся в базе ради уже существующих строк,
# но новые приглашения его не выдают.
ORGANIZATION_ROLES = ("owner", "admin", "manager", "commandant", "member")

# Перечень значений для `CHECK` собирается из константы: список ролей должен
# быть записан в модели и в миграции одинаково.
ORGANIZATION_ROLES_SQL = ", ".join(f"'{role}'" for role in ORGANIZATION_ROLES)


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    inn: Mapped[str | None] = mapped_column(String(12), nullable=True, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class OrganizationMember(Base):
    """Связка «пользователь — организация» с ролью.

    Уникальность пары `(organization_id, user_id)` не даёт завести одному
    пользователю две роли в одной организации.
    """

    __tablename__ = "organization_members"
    __table_args__ = (
        UniqueConstraint("organization_id", "user_id", name="uq_organization_members_org_user"),
        CheckConstraint(
            f"role IN ({ORGANIZATION_ROLES_SQL})",
            name="ck_organization_members_role",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String(30), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

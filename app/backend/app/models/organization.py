"""Организации и членство в них.

Владелец появляется в момент активации кабинета: пустая организация (без
названия и ИНН) плюс строка членства с ролью `owner`. Приглашённый сотрудник
добавляется в организацию приглашающего с ролью `admin`, `manager` или
`commandant` ещё до того, как задаст пароль. Роль хранится строкой с `CHECK`,
а не enum-типом Postgres: набор ролей ещё будет меняться, а ALTER TYPE
на enum тянет за собой отдельную возню с миграцией значений.

ИНН уникален, но nullable: пустая заготовка организации — нормальное состояние,
а в Postgres несколько `NULL` в уникальном индексе друг другу не мешают.

**Тариф организации — это два слота.** `tariff_id` с `tariff_ends_at` — текущий
оплаченный период, `next_tariff_id` с `next_tariff_ends_at` — оплаченный вперёд.
Слотов ровно два: третий тариф не продаётся, пока не наступит будущий период.
Разделение на слоты даёт продление без второго источника срока — «начало
будущего периода» это и есть `tariff_ends_at` текущего, поэтому отдельного
`next_starts_at` здесь нет.

`tariff_ends_at` — **исключающая** граница, как `users.trial_ends_at`: в момент
`ends_at` тариф уже не действует. `NULL` в `tariff_ends_at` у заполненного
`tariff_id` означает бессрочный тариф: так его назначает администратор платформы
и так в базе лежат строки периода `once`.

`tariff_id` при этом — «последний оплаченный в этот слот», а не «действующий
сейчас»: если срок истёк и оплачен будущий период, действующим становится
будущий, и это вычисление (`app/subscription.py`), а не мутация на чтении.
Воркеров и планировщика в проекте нет, поэтому «наступивший» период переезжает
в текущий слот в ближайшей транзакции, которая пишет подписку (оплата счёта).

Ссылка на тариф (`tariff_id`, `next_tariff_id`) — это «купленный» тариф
организации: одна строка прайса на слот, `NULL` — слот ещё не оплачен. Внешний
ключ с `ON DELETE SET NULL`: удаление тарифа из прайса не должно ломать
организацию, она просто остаётся без тарифа в этом слоте, как и до выбора.
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
    # Реквизиты, заполняемые из DaData по ИНН. `kpp` у индивидуального
    # предпринимателя пустой — это нормальное состояние, а не пропуск.
    kpp: Mapped[str | None] = mapped_column(String(9), nullable=True)
    ogrn: Mapped[str | None] = mapped_column(String(15), nullable=True)
    address: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Выбранный организации тариф. Пока `NULL` — организация без тарифа.
    tariff_id: Mapped[int | None] = mapped_column(
        ForeignKey("tariffs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Конец текущего оплаченного периода (`NULL` — бессрочно). Граница
    # исключающая: в этот момент тариф уже не действует.
    tariff_ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Тариф, оплаченный вперёд: начинает действовать с `tariff_ends_at` текущего.
    next_tariff_id: Mapped[int | None] = mapped_column(
        ForeignKey("tariffs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    next_tariff_ends_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
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

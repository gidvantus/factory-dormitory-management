"""Диагностика принадлежности данных: что станет невидимым после изоляции.

Задача T4 эпика #78. Изоляция по организациям (`0043_dormitories_organization`,
`0045_organization_root_objects`) ничего не удаляет: объект без
`organization_id` просто перестаёт быть видимым — `NULL` в этой колонке значит
«не видно никому». Миграция `0043` падает громко, но только на общежитиях и
только своим перечнем `id`; объёма потерь — по проживающим, местам и корневым
объектам — из неё не видно. Здесь read-only команда, которая считает этот объём
**заранее**, на копии базы.

Запуск — `python -m app.diagnostics.ownership` в контейнере `api`:

    alembic upgrade head
    python -m app.diagnostics.ownership [--json]

Коды выхода: `0` — невидимых данных нет; `2` — есть; `1` — ошибка запуска, в том
числе база, к которой ещё не применена миграция изоляции (тогда вместо трейсбека
печатается «сначала примените миграцию: в таблице <таблица> нет колонки
organization_id»), и неверный ключ запуска (`argparse` сам выходит кодом `2`, а
`2` здесь значит «данные есть» — поэтому такой выход переводится в `1`).

**Видимость считается так же, как её считает кабинет.** `shared`-отчёт статистики
открыт всей организации, `personal` — только автору и только пока он в этой же
организации (`visible_reports` в `app/statistics_reports.py`). Личный отчёт
уволенного, перешедшего или не имеющего организации автора не открывает никто:
он идёт в раздел «станет невидимым» с названной причиной, а не в цифру «видно».

**Только чтение.** Ни одного `commit`, `flush`, `UPDATE`, `INSERT` или `DELETE`;
не вызываются функции, которые пишут (`take_snapshot`, `ensure_columns`,
`layout_row`). Сессия открывается и закрывается в `finally`, а тест
`tests/test_ownership_diagnostics.py` сравнивает снимок всех таблиц до и после
прогона.

**Отчёт только констатирует.** Команда не привязывает, не скрывает и не удаляет
данные: судьбу осиротевших строк решает владелец базы, а не код. Поэтому же
здесь нет ни одной ручки API — отчёт печатается оператору.
"""

import argparse
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import Select, func, inspect, or_, select
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.orm import Session

from app import db as db_module
from app.models.custom_tab import CustomTab
from app.models.dashboard_block import DashboardBlock
from app.models.dormitory import Dormitory
from app.models.dormitory_template import DormitoryTemplate
from app.models.hostel import Hostel, HostelCell
from app.models.organization import Organization
from app.models.report_template import ReportTemplate
from app.models.resident import Resident
from app.models.statistics_report import StatisticsReport
from app.models.user import User

# Коды выхода: их читает оператор и CI, поэтому это часть контракта команды.
EXIT_OK = 0
EXIT_ERROR = 1
EXIT_INVISIBLE = 2

# Текст на случай базы, к которой изоляция ещё не применена: команда обязана
# объяснить, что делать, а не падать трейсбеком на отсутствующей колонке.
MISSING_COLUMN = "сначала примените миграцию: в таблице {table} нет колонки organization_id"
MISSING_TABLE = "сначала примените миграцию: в базе нет таблицы {table}"

# Причины, по которым корневой объект остался без организации. Формулировки
# stable: по ним оператор решает, что делать, а тест их проверяет.
REASON_NO_AUTHOR = "автор не указан"
REASON_AUTHOR_DELETED = "автор удалён"
REASON_NO_ORGANIZATION = "у автора нет организации"
REASON_NOT_LINKED = "объект не привязан к организации автора"

# Личный отчёт видит только его автор и только внутри своей организации
# (`visible_reports` в `app/statistics_reports.py`). Если автора нет, он удалён,
# он без организации или уже в другой — отчёт не открывает никто, и в «видно» он
# не попадает: причина называется отдельно, чтобы владелец не считал его целым.
REASON_PERSONAL_NO_AUTHOR = "личный отчёт: автор не указан"
REASON_PERSONAL_AUTHOR_DELETED = "личный отчёт: автор удалён"
REASON_PERSONAL_NO_ORGANIZATION = "личный отчёт: у автора нет организации"
REASON_PERSONAL_FOREIGN_AUTHOR = "личный отчёт: автор в другой организации"

# Метрики видимости. Порядок задаёт порядок ключей в JSON и в строке отчёта.
DORMITORIES = "dormitories"
RESIDENTS = "residents"
HOSTEL_CELLS = "hostel_cells"
CUSTOM_TABS = "custom_tabs"
DORMITORY_TEMPLATES = "dormitory_templates"
REPORT_TEMPLATES = "report_templates"
STATISTICS_REPORTS_PERSONAL = "statistics_reports_personal"
STATISTICS_REPORTS_SHARED = "statistics_reports_shared"
DASHBOARD_BLOCKS = "dashboard_blocks"

METRICS = (
    DORMITORIES,
    RESIDENTS,
    HOSTEL_CELLS,
    CUSTOM_TABS,
    DORMITORY_TEMPLATES,
    REPORT_TEMPLATES,
    STATISTICS_REPORTS_PERSONAL,
    STATISTICS_REPORTS_SHARED,
    DASHBOARD_BLOCKS,
)

# Корневые объекты без корня-общежития: принадлежность задаётся их собственной
# колонкой `organization_id` (миграция `0045`). Таблица указана явно: она
# попадает в отчёт и в сообщение о неприменённой миграции.
#
# Разделение на два списка — не косметика: у этих таблиц имя и время создания
# лежат в своих колонках, а у блока дашборда имени нет вовсе (оно внутри
# `config`), поэтому выборка колонок у них разная.
NAMED_ROOT_TABLES: tuple[tuple[str, type[Any]], ...] = (
    ("dormitory_templates", DormitoryTemplate),
    ("report_templates", ReportTemplate),
    ("statistics_reports", StatisticsReport),
)

DASHBOARD_BLOCKS_TABLE = "dashboard_blocks"

ROOT_TABLES = (*NAMED_ROOT_TABLES, (DASHBOARD_BLOCKS_TABLE, DashboardBlock))

# Таблицы, без колонки `organization_id` в которых отчёт посчитать нельзя.
SCHEMA_TABLES = ("dormitories", *(table for table, _model in ROOT_TABLES))


class MigrationNotApplied(RuntimeError):
    """База без миграций изоляции: считать нечего, нужен `alembic upgrade head`."""


@dataclass(frozen=True)
class OrganizationReport:
    """Что видно одной организации: её общежития и корневые объекты."""

    id: int
    name: str | None
    counts: dict[str, int]


@dataclass(frozen=True)
class OrphanDormitory:
    """Общежитие без организации и объём данных внутри него."""

    id: int
    name: str
    created_by_id: int | None
    residents: int
    hostel_cells: int


@dataclass(frozen=True)
class OrphanRootObject:
    """Корневой объект без организации и причина, по которой так вышло."""

    table: str
    id: int
    name: str | None
    created_at: datetime | None
    created_by_id: int | None
    reason: str


@dataclass(frozen=True)
class DiagnosticReport:
    """Отчёт целиком: текст для оператора и та же структура для `--json`."""

    organizations: list[OrganizationReport]
    orphan_dormitories: list[OrphanDormitory]
    orphan_root_objects: list[OrphanRootObject]

    @property
    def has_invisible(self) -> bool:
        """Есть ли данные, которые изоляция сделает невидимыми."""
        return bool(self.orphan_dormitories or self.orphan_root_objects)

    @property
    def totals(self) -> dict[str, dict[str, int]]:
        """Итоговые числа: видимое и то, что станет невидимым."""
        return {
            "visible": {
                DORMITORIES: sum(item.counts[DORMITORIES] for item in self.organizations),
                RESIDENTS: sum(item.counts[RESIDENTS] for item in self.organizations),
            },
            "invisible": {
                DORMITORIES: len(self.orphan_dormitories),
                RESIDENTS: sum(item.residents for item in self.orphan_dormitories),
                "root_objects": len(self.orphan_root_objects),
            },
        }

    def summary(self) -> str:
        """Итоговая строка отчёта: те же числа, что в `totals`."""
        totals = self.totals
        visible = totals["visible"]
        invisible = totals["invisible"]
        return (
            f"видимо: {visible[DORMITORIES]} общежитий, {visible[RESIDENTS]} проживающих; "
            f"станет невидимым: {invisible[DORMITORIES]} общежитий, "
            f"{invisible[RESIDENTS]} проживающих, {invisible['root_objects']} корневых объектов"
        )

    def as_json(self) -> dict[str, Any]:
        """Тот же отчёт структурой: числа совпадают с текстом до последней цифры."""
        return {
            "organizations": [
                {"id": item.id, "name": item.name, "counts": dict(item.counts)}
                for item in self.organizations
            ],
            "invisible": {
                "dormitories": [
                    {
                        "id": item.id,
                        "name": item.name,
                        "created_by_id": item.created_by_id,
                        "residents": item.residents,
                        "hostel_cells": item.hostel_cells,
                    }
                    for item in self.orphan_dormitories
                ],
                "root_objects": [
                    {
                        "table": item.table,
                        "id": item.id,
                        "name": item.name,
                        "created_at": _moment_text(item.created_at),
                        "created_by_id": item.created_by_id,
                        "reason": item.reason,
                    }
                    for item in self.orphan_root_objects
                ],
            },
            "totals": self.totals,
        }

    def render_text(self) -> str:
        """Отчёт для человека: сначала что видно, потом что станет невидимым."""
        lines = ["Диагностика принадлежности данных (только чтение)", ""]
        lines.append(f"Организаций: {len(self.organizations)}")
        if self.organizations:
            lines.append("")
            lines.append("Видно каждой организации:")
            for organization in self.organizations:
                counts = organization.counts
                reports = counts[STATISTICS_REPORTS_PERSONAL] + counts[STATISTICS_REPORTS_SHARED]
                lines.append(f"  #{organization.id} {organization.name or 'без названия'}")
                lines.append(
                    f"    общежитий: {counts[DORMITORIES]}, проживающих: {counts[RESIDENTS]}, "
                    f"мест: {counts[HOSTEL_CELLS]}, вкладок: {counts[CUSTOM_TABS]}"
                )
                lines.append(
                    f"    шаблонов структуры: {counts[DORMITORY_TEMPLATES]}, "
                    f"шаблонов отчёта: {counts[REPORT_TEMPLATES]}, "
                    f"отчётов статистики: {reports} "
                    f"(personal: {counts[STATISTICS_REPORTS_PERSONAL]}, "
                    f"shared: {counts[STATISTICS_REPORTS_SHARED]}), "
                    f"блоков дашборда: {counts[DASHBOARD_BLOCKS]}"
                )
        lines.append("")
        lines.append("Станет невидимым после включения изоляции:")
        if not self.has_invisible:
            lines.append("  нет")
        if self.orphan_dormitories:
            lines.append(f"  Общежития без организации: {len(self.orphan_dormitories)}")
            for orphan in self.orphan_dormitories:
                lines.append(
                    f"    id={orphan.id} «{orphan.name}» "
                    f"(создал: {_author_text(orphan.created_by_id)}): "
                    f"проживающих {orphan.residents}, мест {orphan.hostel_cells}"
                )
        if self.orphan_root_objects:
            lines.append(
                f"  Корневые объекты, которые станут невидимыми: {len(self.orphan_root_objects)}"
            )
            for root_object in self.orphan_root_objects:
                title = root_object.name or "без названия"
                lines.append(
                    f"    {root_object.table} id={root_object.id} «{title}» "
                    f"(создан: {_moment_text(root_object.created_at)}, "
                    f"автор: {_author_text(root_object.created_by_id)}): {root_object.reason}"
                )
        lines.append("")
        lines.append(self.summary())
        return "\n".join(lines)


def empty_counts() -> dict[str, int]:
    """Нули по всем метрикам: организация без данных — обычное состояние."""
    return dict.fromkeys(METRICS, 0)


def _author_text(created_by_id: int | None) -> str:
    """Автор для текста отчёта: `id` или «не указан»."""
    return "не указан" if created_by_id is None else str(created_by_id)


def _moment_text(moment: datetime | None) -> str:
    """Момент создания для текста отчёта: у блока дашборда своей колонки нет."""
    if moment is None:
        return "время не указано"
    return moment.isoformat(timespec="seconds")


def _config_name(config: Any) -> str | None:
    """Имя блока дашборда: у него нет колонки `name`, имя лежит в `config`."""
    if isinstance(config, dict):
        title = config.get("name")
        if isinstance(title, str):
            return title
    return None


def _totals_by_key(session: Session, statement: Select[Any, Any]) -> dict[int, int]:
    """Сколько строк на каждый ключ группировки. `NULL`-ключ пропускается."""
    totals: dict[int, int] = {}
    for row in session.execute(statement):
        key = row[0]
        if key is not None:
            totals[int(key)] = int(row[1])
    return totals


def _counts_per_organization(session: Session) -> dict[int, dict[str, int]]:
    """Видимые данные по организациям — те же числа, что видит кабинет.

    Принадлежность дочерних таблиц наследуется от общежития: у проживающих,
    мест и вкладок своей колонки `organization_id` нет, поэтому они считаются
    через `JOIN` на `dormitories`, а не отдельной денормализацией.
    """
    counts: dict[int, dict[str, int]] = {}

    def add(metric: str, statement: Select[Any, Any]) -> None:
        for organization_id, total in _totals_by_key(session, statement).items():
            counts.setdefault(organization_id, empty_counts())[metric] += total

    add(
        DORMITORIES,
        select(Dormitory.organization_id, func.count(Dormitory.id))
        .where(Dormitory.organization_id.is_not(None))
        .group_by(Dormitory.organization_id),
    )
    add(
        RESIDENTS,
        select(Dormitory.organization_id, func.count(Resident.id))
        .select_from(Dormitory)
        .join(Resident, Resident.dormitory_id == Dormitory.id)
        .where(Dormitory.organization_id.is_not(None))
        .group_by(Dormitory.organization_id),
    )
    add(
        HOSTEL_CELLS,
        select(Dormitory.organization_id, func.count(HostelCell.id))
        .select_from(Dormitory)
        .join(Hostel, Hostel.dormitory_id == Dormitory.id)
        .join(HostelCell, HostelCell.hostel_id == Hostel.id)
        .where(Dormitory.organization_id.is_not(None))
        .group_by(Dormitory.organization_id),
    )
    add(
        CUSTOM_TABS,
        select(Dormitory.organization_id, func.count(CustomTab.id))
        .select_from(Dormitory)
        .join(CustomTab, CustomTab.dormitory_id == Dormitory.id)
        .where(Dormitory.organization_id.is_not(None))
        .group_by(Dormitory.organization_id),
    )
    for metric, model in (
        (DORMITORY_TEMPLATES, DormitoryTemplate),
        (REPORT_TEMPLATES, ReportTemplate),
        (DASHBOARD_BLOCKS, DashboardBlock),
    ):
        add(
            metric,
            select(model.organization_id, func.count(model.id))
            .where(model.organization_id.is_not(None))
            .group_by(model.organization_id),
        )
    # Видимость `personal`/`shared` действует **внутри** организации и её не
    # расширяет. `shared` открыт всей организации, `personal` — только автору и
    # только пока тот в этой же организации (`visible_reports` в
    # `app/statistics_reports.py`). Поэтому `personal` считается через join на
    # `users`: отчёт уволенного или перешедшего автора не открывает никто, и в
    # «видно» он попадать не должен — иначе цифра врёт ровно на объём тех
    # данных, ради которых команда и написана.
    add(
        STATISTICS_REPORTS_SHARED,
        select(StatisticsReport.organization_id, func.count(StatisticsReport.id))
        .where(
            StatisticsReport.organization_id.is_not(None),
            StatisticsReport.visibility == "shared",
        )
        .group_by(StatisticsReport.organization_id),
    )
    add(
        STATISTICS_REPORTS_PERSONAL,
        select(StatisticsReport.organization_id, func.count(StatisticsReport.id))
        .select_from(StatisticsReport)
        .outerjoin(User, User.id == StatisticsReport.created_by_id)
        .where(
            StatisticsReport.organization_id.is_not(None),
            StatisticsReport.visibility != "shared",
            User.active_organization_id == StatisticsReport.organization_id,
        )
        .group_by(StatisticsReport.organization_id),
    )
    return counts


def _orphan_dormitories(session: Session) -> list[OrphanDormitory]:
    """Общежития без организации с числом проживающих и мест в каждом."""
    rows = session.execute(
        select(Dormitory.id, Dormitory.name, Dormitory.created_by_id)
        .where(Dormitory.organization_id.is_(None))
        .order_by(Dormitory.id)
    ).all()
    if not rows:
        return []
    dormitory_ids = [int(row[0]) for row in rows]
    residents = _totals_by_key(
        session,
        select(Resident.dormitory_id, func.count(Resident.id))
        .where(Resident.dormitory_id.in_(dormitory_ids))
        .group_by(Resident.dormitory_id),
    )
    cells = _totals_by_key(
        session,
        select(Hostel.dormitory_id, func.count(HostelCell.id))
        .select_from(Hostel)
        .join(HostelCell, HostelCell.hostel_id == Hostel.id)
        .where(Hostel.dormitory_id.in_(dormitory_ids))
        .group_by(Hostel.dormitory_id),
    )
    return [
        OrphanDormitory(
            id=int(row[0]),
            name=str(row[1]),
            created_by_id=None if row[2] is None else int(row[2]),
            residents=residents.get(int(row[0]), 0),
            hostel_cells=cells.get(int(row[0]), 0),
        )
        for row in rows
    ]


def _author_reasons(session: Session, author_ids: set[int | None]) -> dict[int | None, str]:
    """Почему объект не удалось привязать к организации — по его автору.

    Причина считается по `users`: автор не указан (`NULL`), автора нет в базе
    (удалён) или у автора нет активной организации. Если автор есть и
    организация у него известна, а объект всё равно без организации, значит
    backfill `0045` не отработал — это отдельная причина, и она называется.
    """
    known = {author_id for author_id in author_ids if author_id is not None}
    users: dict[int, User] = {}
    if known:
        users = {user.id: user for user in session.scalars(select(User).where(User.id.in_(known)))}
    reasons: dict[int | None, str] = {None: REASON_NO_AUTHOR}
    for author_id in known:
        author = users.get(author_id)
        if author is None:
            reasons[author_id] = REASON_AUTHOR_DELETED
        elif author.active_organization_id is None:
            reasons[author_id] = REASON_NO_ORGANIZATION
        else:
            reasons[author_id] = REASON_NOT_LINKED
    return reasons


def _orphan_root_objects(session: Session) -> list[OrphanRootObject]:
    """Корневые объекты, которые станет невидимым, с причиной по каждому.

    Две группы: строки без организации (`organization_id IS NULL`, миграция
    `0045` их не привязала) и личные отчёты статистики, которые не открывает
    никто, — автор удалён, без организации или уже в другой. Вторые формально
    имеют `organization_id`, но кабинет их не покажет (`visible_reports`),
    поэтому «видно» их не считает.
    """
    found: list[OrphanRootObject] = []
    for table, model in NAMED_ROOT_TABLES:
        found.extend(_orphan_named_objects(session, table, model))
    found.extend(_orphan_dashboard_blocks(session))
    found.extend(_invisible_personal_reports(session))
    return found


def _orphan_named_objects(session: Session, table: str, model: type[Any]) -> list[OrphanRootObject]:
    """Объекты таблицы с колонкой `name`, у которых нет организации.

    Выбираются четыре колонки, а не сущность: у `statistics_reports` в строке
    лежит тело отчёта (`blocks`) и `description`, и на копии с тысячами
    осиротевших отчётов `select(model)` поднял бы в память десятки мегабайт ради
    `id` и `name`. Причина по автору считается тем же правилом, что и у остальных.
    """
    rows = session.execute(
        select(model.id, model.name, model.created_at, model.created_by_id)
        .where(model.organization_id.is_(None))
        .order_by(model.id)
    ).all()
    created_by_ids: set[int | None] = {None if row[3] is None else int(row[3]) for row in rows}
    reasons = _author_reasons(session, created_by_ids)
    return [
        OrphanRootObject(
            table=table,
            id=int(row[0]),
            name=str(row[1]),
            created_at=row[2],
            created_by_id=None if row[3] is None else int(row[3]),
            reason=reasons.get(None if row[3] is None else int(row[3]), REASON_NOT_LINKED),
        )
        for row in rows
    ]


def _orphan_dashboard_blocks(session: Session) -> list[OrphanRootObject]:
    """Блоки дашборда без организации: имени в колонках нет, оно в `config`."""
    rows = session.execute(
        select(DashboardBlock.id, DashboardBlock.created_by_id, DashboardBlock.config)
        .where(DashboardBlock.organization_id.is_(None))
        .order_by(DashboardBlock.id)
    ).all()
    created_by_ids: set[int | None] = {None if row[1] is None else int(row[1]) for row in rows}
    reasons = _author_reasons(session, created_by_ids)
    return [
        OrphanRootObject(
            table=DASHBOARD_BLOCKS_TABLE,
            id=int(row[0]),
            name=_config_name(row[2]),
            # Своей колонки времени создания у блока дашборда нет.
            created_at=None,
            created_by_id=None if row[1] is None else int(row[1]),
            reason=reasons.get(None if row[1] is None else int(row[1]), REASON_NOT_LINKED),
        )
        for row in rows
    ]


def _invisible_personal_reports(session: Session) -> list[OrphanRootObject]:
    """Личные отчёты статистики, которые не открывает ни один пользователь.

    `personal`-отчёт видит только автор и только внутри своей организации
    (`visible_reports`). Отчёт с чужим, удалённым или не имеющим организации
    автором не отдаётся никому, поэтому он идёт в раздел «станет невидимым» с
    названной причиной, а не в цифру «видно».
    """
    rows = session.execute(
        select(
            StatisticsReport.id.label("report_id"),
            StatisticsReport.name.label("report_name"),
            StatisticsReport.created_at.label("report_created_at"),
            StatisticsReport.created_by_id.label("report_created_by_id"),
            User.id.label("author_id"),
            User.active_organization_id.label("author_organization_id"),
        )
        .select_from(StatisticsReport)
        .outerjoin(User, User.id == StatisticsReport.created_by_id)
        .where(
            StatisticsReport.organization_id.is_not(None),
            StatisticsReport.visibility != "shared",
            or_(
                User.id.is_(None),
                User.active_organization_id.is_(None),
                User.active_organization_id != StatisticsReport.organization_id,
            ),
        )
        .order_by(StatisticsReport.id)
    ).all()
    return [
        OrphanRootObject(
            table="statistics_reports",
            id=int(row.report_id),
            name=str(row.report_name),
            created_at=row.report_created_at,
            created_by_id=(
                None if row.report_created_by_id is None else int(row.report_created_by_id)
            ),
            reason=_personal_report_reason(
                created_by_id=row.report_created_by_id,
                author_id=row.author_id,
                author_organization_id=row.author_organization_id,
            ),
        )
        for row in rows
    ]


def _personal_report_reason(
    *, created_by_id: int | None, author_id: int | None, author_organization_id: int | None
) -> str:
    """Почему личный отчёт не открывает никто."""
    if created_by_id is None:
        return REASON_PERSONAL_NO_AUTHOR
    if author_id is None:
        return REASON_PERSONAL_AUTHOR_DELETED
    if author_organization_id is None:
        return REASON_PERSONAL_NO_ORGANIZATION
    return REASON_PERSONAL_FOREIGN_AUTHOR


def require_organization_columns(bind: Engine | Connection) -> None:
    """Проверить, что изоляция применена: иначе считать нечего.

    Проверка идёт по `information_schema` (через инспектор SQLAlchemy), а не
    запросом, чтобы не падать на отсутствующей колонке: база без миграций —
    штатная ситуация на копии, а не сбой команды.
    """
    inspector = inspect(bind)
    for table in SCHEMA_TABLES:
        if not inspector.has_table(table):
            raise MigrationNotApplied(MISSING_TABLE.format(table=table))
        columns = {column["name"] for column in inspector.get_columns(table)}
        if "organization_id" not in columns:
            raise MigrationNotApplied(MISSING_COLUMN.format(table=table))


def build_report(session: Session) -> DiagnosticReport:
    """Собрать отчёт по базе. Только чтение, без единой записи."""
    require_organization_columns(session.get_bind())
    counts = _counts_per_organization(session)
    organizations = [
        OrganizationReport(
            id=organization.id,
            name=organization.name,
            counts=counts.get(organization.id, empty_counts()),
        )
        for organization in session.scalars(select(Organization).order_by(Organization.id))
    ]
    return DiagnosticReport(
        organizations=organizations,
        orphan_dormitories=_orphan_dormitories(session),
        orphan_root_objects=_orphan_root_objects(session),
    )


def build_parser() -> argparse.ArgumentParser:
    """Аргументы команды: по умолчанию текст для человека, `--json` — структура."""
    parser = argparse.ArgumentParser(
        prog="python -m app.diagnostics.ownership",
        description=(
            "Считает, сколько данных станет невидимым после включения изоляции "
            "по организациям. Ничего не меняет."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="напечатать тот же отчёт структурой JSON вместо текста",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Точка входа `python -m app.diagnostics.ownership`. Возвращает код выхода."""
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as error:
        # `argparse` на неизвестном ключе выходит сам, кодом `2`, а `2` у команды
        # значит «невидимые данные есть». Отчёт при этом не печатается, поэтому
        # оператор прочитал бы «потери найдены» без единой цифры: неверный ключ —
        # это ошибка запуска. `--help` выходит кодом `0` и остаётся `0`.
        return EXIT_ERROR if error.code else EXIT_OK
    session: Session | None = None
    try:
        session = db_module.SessionLocal()
        report = build_report(session)
        if args.json:
            print(json.dumps(report.as_json(), ensure_ascii=False, indent=2))
        else:
            print(report.render_text())
        return EXIT_INVISIBLE if report.has_invisible else EXIT_OK
    except MigrationNotApplied as error:
        print(str(error), file=sys.stderr)
        return EXIT_ERROR
    except Exception as error:  # команда не должна падать трейсбеком на копии базы
        print(f"Ошибка запуска диагностики: {type(error).__name__}: {error}", file=sys.stderr)
        return EXIT_ERROR
    finally:
        # Сессия закрывается всегда: незакоммиченную транзакцию откатывает
        # `close`, и в базу не попадает ничего.
        if session is not None:
            session.close()


if __name__ == "__main__":
    sys.exit(main())

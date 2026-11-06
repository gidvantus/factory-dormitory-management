"""Права организации на решения магазина улучшений.

Здесь вся предметная логика решений, без HTTP: период права и его конец,
владение правом, его выдача и продление, а также зависимость FastAPI, которой
закрыты ручки платной функции — по образцу `app/notifications.py`.

Право принадлежит организации, а не пользователю: купил владелец — пользуются
все участники. Отсюда один вопрос у всех проверок — «есть ли у этой организации
действующее право на это решение».

Период права берётся из строки каталога и превращается в `expires_at` в момент
оплаты. `expires_at IS NULL` означает бессрочное право (`period = 'once'`), а не
«срок не задан»: срок есть у всего, что продаётся на месяц, полгода или год.

Даты сравниваются в Python, а не в SQL, намеренно: на SQLite они приходят
наивными, на Postgres — с зоной, и одно приведение к UTC (`_as_utc`, как в
`app/trial.py`) делает сравнение верным на обеих базах. В SQL «сейчас»
остаётся только там, где запрос целиком строится базой — в отборе получателей
уведомлений (`app/notifications.py`).
"""

import calendar
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.solution import OrganizationSolution, Solution
from app.models.user import User
from app.schemas.user import ErrorResponse
from app.security import ACTIVATION_REQUIRED_DETAIL, ActiveUser

# Код решения «уведомления в Telegram»: по нему кабинет спрашивает право, и он
# же стоит в seed-строке каталога (`0035_solutions`).
TELEGRAM_NOTIFICATIONS = "telegram_notifications"

# Код решения «журнал действий»: тот же код держит seed-строка каталога
# (`0049_solution_journal`). Кабинет сверяет его с правом организации, чтобы
# показать или спрятать раздел «Журнал».
JOURNAL = "journal"

# Текст 403 «права нет». Он одинаков для ручек платной функции: по ответу не
# должно быть видно, чего именно не хватает, а человеку нужен один понятный
# следующий шаг — магазин улучшений.
SOLUTION_REQUIRED_DETAIL = "Решение не подключено. Оформите подписку в магазине улучшений"

# Период, дающий бессрочное право.
ONCE_PERIOD = "once"

# Сколько календарных месяцев прибавляет период. `once` здесь нет: он даёт
# бессрочное право, а не «ноль месяцев» — так же считается и срок тарифа
# (`app/subscription.py`), поэтому оба срока живут в одной арифметике.
MONTHS_BY_PERIOD = {"month": 1, "quarter": 3, "half_year": 6, "year": 12}

DbSession = Annotated[Session, Depends(get_db)]


def _as_utc(value: datetime) -> datetime:
    """SQLite отдаёт naive datetime: считаем его UTC, иначе сравнение падает."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _add_months(moment: datetime, months: int) -> datetime:
    """Прибавить календарные месяцы с усечением на конце месяца.

    31 января плюс месяц — 28 или 29 февраля, а не 3 марта: право не должно
    удлиняться из-за того, что в месяце меньше дней. `calendar.monthrange` даёт
    длину целевого месяца, поэтому високосный год учитывается сам.
    """
    total = moment.month - 1 + months
    year = moment.year + total // 12
    month = total % 12 + 1
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


def entitlement_expiry(period: str, granted_at: datetime) -> datetime | None:
    """Конец права по периоду: момент выдачи плюс период. `None` — бессрочно.

    Чистая функция: ни базы, ни «сейчас» внутри — момент выдачи передаётся
    явно, поэтому границы месяца проверяются без подмены часов.
    """
    if period == ONCE_PERIOD:
        return None
    months = MONTHS_BY_PERIOD.get(period)
    if months is None:
        # Незнакомый период: набор держит `CHECK` в таблице, но ронять оплату
        # из-за строки каталога нельзя — право выдаётся бессрочным, как за
        # `once`, и это видно в ответе каталога.
        return None
    return _add_months(_as_utc(granted_at), months)


def _is_live(expires_at: datetime | None, moment: datetime) -> bool:
    """Действует ли право: без срока — да, иначе — если срок ещё не прошёл."""
    return expires_at is None or _as_utc(expires_at) > moment


@dataclass(frozen=True)
class OrganizationRight:
    """Право организации на решение — как оно записано, вместе с `is_live`.

    `is_live` здесь, а не в ручке: правило конца права одно на весь проект
    (`_is_live`, и через него `entitlements`/`has_solution`), и вторая его копия в
    API разошлась бы с первой на первой же правке границы.
    """

    code: str
    name: str
    expires_at: datetime | None
    is_live: bool


def organization_rights(
    db: Session, organization_id: int, now: datetime | None = None
) -> list[OrganizationRight]:
    """**Все** права организации, включая истёкшие, в порядке каталога.

    Истёкшие строки не отфильтрованы намеренно: кабинет оператора — единственное
    место, где видно, что право было и кончилось. Магазин и проверки прав
    (`entitlements`, `has_solution`) читают только действующие — у них свой
    отбор, и он не меняется.

    Порядок — `solutions.position`, затем `solutions.id`: тот же, в каком решения
    видит покупатель.
    """
    moment = _as_utc(now) if now is not None else datetime.now(UTC)
    rows = db.execute(
        select(OrganizationSolution.expires_at, Solution.code, Solution.name)
        .join(Solution, Solution.id == OrganizationSolution.solution_id)
        .where(OrganizationSolution.organization_id == organization_id)
        .order_by(Solution.position, Solution.id)
    ).all()
    return [
        OrganizationRight(
            code=code,
            name=name,
            expires_at=_as_utc(expires_at) if expires_at is not None else None,
            is_live=_is_live(expires_at, moment),
        )
        for expires_at, code, name in rows
    ]


def deactivate_right(
    db: Session, organization_id: int, code: str, now: datetime | None = None
) -> OrganizationRight | None:
    """Снять активность права: `expires_at` = момент вызова. Коммитит вызывающий.

    Строка права не удаляется: «не действует» в проекте — это срок в прошлом, а не
    флаг и не отсутствие записи. Истёкшее право продолжает возвращаться из
    `organization_rights` с `is_live = false`, поэтому кабинет оператора видит, что
    расширение было, а проверки платной функции (`has_solution`) его уже не видят.

    `None` — у организации нет строки права на это `code`: ручка отвечает `404`,
    а не молчаливым «сняли нечего».
    """
    moment = _as_utc(now) if now is not None else datetime.now(UTC)
    row = db.execute(
        select(OrganizationSolution, Solution)
        .join(Solution, Solution.id == OrganizationSolution.solution_id)
        .where(
            OrganizationSolution.organization_id == organization_id,
            Solution.code == code,
        )
    ).first()
    if row is None:
        return None
    right, solution = row
    right.expires_at = moment
    db.flush()
    return OrganizationRight(
        code=solution.code,
        name=solution.name,
        expires_at=moment,
        # Только что записанный срок равен «сейчас», а граница исключающая:
        # право уже не действует.
        is_live=_is_live(moment, moment),
    )


def entitlements(db: Session, organization_id: int) -> dict[str, datetime | None]:
    """Действующие права организации: код решения → конец права (`None` — вечно).

    Один запрос на весь каталог: магазин показывает признак владения и срок по
    каждой строке, а решение спрашивает право точечно (`has_solution`).
    """
    moment = datetime.now(UTC)
    rows = db.execute(
        select(Solution.code, OrganizationSolution.expires_at)
        .join(Solution, Solution.id == OrganizationSolution.solution_id)
        .where(OrganizationSolution.organization_id == organization_id)
    ).all()
    return {code: expires_at for code, expires_at in rows if _is_live(expires_at, moment)}


def owned_codes(db: Session, organization_id: int) -> set[str]:
    """Коды решений, на которые у организации есть действующее право."""
    return set(entitlements(db, organization_id))


def has_solution(db: Session, organization_id: int, code: str) -> bool:
    """Есть ли у организации действующее право на решение с этим кодом."""
    return code in owned_codes(db, organization_id)


def grant(
    db: Session,
    organization_id: int,
    solution: Solution,
    *,
    invoice_id: int | None,
) -> None:
    """Выдать или продлить право. Коммитит вызывающий.

    Строка на пару «организация — решение» одна: продление правит её, а не
    заводит вторую. База отсчёта — `max(сейчас, текущий срок)`: неоплаченное
    время не сгорает, вторая покупка добавляет период к остатку. `granted_at`
    при продлении не сдвигается — это дата первой выдачи.

    Блокировку организации держит вызывающий (`_lock_organization` в
    `app/invoice_status.py`), поэтому две одновременные оплаты не разойдутся.
    """
    moment = datetime.now(UTC)
    record = db.scalar(
        select(OrganizationSolution).where(
            OrganizationSolution.organization_id == organization_id,
            OrganizationSolution.solution_id == solution.id,
        )
    )
    if record is None:
        db.add(
            OrganizationSolution(
                organization_id=organization_id,
                solution_id=solution.id,
                granted_at=moment,
                expires_at=entitlement_expiry(solution.period, moment),
                invoice_id=invoice_id,
            )
        )
    else:
        base = max(moment, _as_utc(record.expires_at)) if record.expires_at else moment
        record.expires_at = entitlement_expiry(solution.period, base)
        record.invoice_id = invoice_id
    db.flush()


def require_solution(code: str) -> Callable[..., User]:
    """Зависимость FastAPI: пользователь с действующим правом на решение.

    Порядок проверок обязателен: **сначала** `ActiveUser`. Кабинет не активирован
    — 403 про активацию, и только активированный без права получает 403 про
    магазин. Иначе неактивированный человек вместо ссылки на письмо увидел бы
    предложение что-то купить.

    Нет организации — тоже 403 про решение: право принадлежит организации, а
    организации без права у такого пользователя нет по определению.
    """

    def dependency(user: ActiveUser, db: DbSession) -> User:
        organization_id = user.active_organization_id
        if organization_id is None or not has_solution(db, organization_id, code):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=SOLUTION_REQUIRED_DETAIL,
            )
        return user

    return dependency


# Единое описание 403 ручек платной функции: у кода два разных текста, и оба
# здесь — как `SUBSCRIBED_USER_RESPONSES` в `app/access.py`.
SOLUTION_REQUIRED_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_403_FORBIDDEN: {
        "model": ErrorResponse,
        "description": (
            f"{ACTIVATION_REQUIRED_DETAIL} — кабинет не активирован; "
            f"{SOLUTION_REQUIRED_DETAIL} — решение не подключено"
        ),
    }
}

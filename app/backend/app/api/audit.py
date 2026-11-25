"""Чтение журнала действий: раздел «Журнал» в кабинете владельца организации.

Ручка только читает — строки журнала пишет middleware (`app.main`) и слушатель
коммита (`app.audit`), а здесь их нельзя ни создать, ни изменить. Отсюда и
правило модуля: **ни одного коммита**. Чтение, которое что-то сохраняет, оставляло
бы строку в журнале на каждый просмотр — и журнал заполнялся бы своими же
просмотрами.

Права: `JournalAccess` — владелец организации **с действующим правом** на решение
`journal` магазина улучшений. Сначала `OwnerMembership`, то есть только
`OWNER_ROLE`: `admin` правит организацию (`EDIT_ROLES`), но журнал — раздел уровня
владельца, там видно, кто что делал. Затем тариф и право: журнал продаётся
отдельным решением каталога (`app.solutions.JOURNAL`, seed
`0049_solution_journal`), а само право действует только при действующем тарифе
организации (`app.solutions.require_solution_access`). Порядок жёсткий —
активация → роль → тариф → право, иначе сотрудник без права увидел бы предложение
купить то, чего ему всё равно не откроют. Коды отказа поэтому различимы:

* **401** — нет сессии;
* **403** — кабинет не активирован, роль не `owner`, у организации нет
  действующего тарифа или нет права на решение `journal`;
* **404** — пользователь не привязан к организации;
* **422** — период длиннее `MAX_RANGE_DAYS`, начало позже конца, период целиком
  в будущем, дата вне календаря, неразборчивый курсор или `limit` вне 1..200.

Строки без организации (`organization_id IS NULL`) не отдаются никогда: это
вход, регистрация и восстановление пароля — события платформы, а не организации.

**Сутки периода — московские, а не UTC.** `created_at` хранится в UTC, но
человек выбирает в фильтре календарный день своей зоны, и «правка в 01:30 29.10»
обязана попасть в 29.10, а не в 28.10. Поэтому границы дня считаются по
`Europe/Moscow`, как в остальном продукте (`app.report_readiness.today_moscow`,
`app/api/table_columns.py` — границы периода архива, `app/dashboard_blocks.py` —
группировка по дням). Курсор и `created_at` в ответе при этом остаются в UTC:
сравнение в SQL идёт по моментам, а не по дням.

Порядок чтения — `created_at DESC, id DESC` по индексу
`ix_audit_events_created_at_id`, постранично по курсору (keyset, не `OFFSET`):
между двумя страницами в журнал дописываются новые строки, и `OFFSET` дал бы
дубли. Условие keyset написано через `or_`/`and_`, а не кортежем `(created_at,
id) < ...`: кортежное сравнение работает на PostgreSQL, но не на SQLite, где
идут юнит-тесты.

Диапазон по умолчанию — последние `DEFAULT_PERIOD_DAYS` дней, потолок —
`MAX_RANGE_DAYS`: таблица партиционирована по месяцам, и запрос без нижней
границы по `created_at` читал бы все партиции сразу.

`total` в ответе — сколько записей за период во всей ленте, а не на странице:
подвал ленты по макету говорит «За этот период — N записей», и по `{items}` это
число не восстановить. Считается только на первой странице (`cursor` не задан):
«Показать ещё» не должен платить за `COUNT` при каждом нажатии.
"""

from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.organization import (
    ORGANIZATION_EDIT_FORBIDDEN_DETAIL,
    ORGANIZATION_NOT_FOUND_DETAIL,
    OwnerMembership,
)
from app.db import get_db
from app.journal import (
    DEFAULT_LIMIT,
    INVALID_CURSOR_DETAIL,
    MAX_LIMIT,
    RANGE_IN_FUTURE_DETAIL,
    RANGE_INVERTED_DETAIL,
    RANGE_OUT_OF_CALENDAR_DETAIL,
    RANGE_TOO_LONG_DETAIL,
    audit_conditions,
    day_bounds,
    entry,
    journal_page,
    period_range,
)
from app.models.organization import OrganizationMember
from app.schemas.audit import JournalKind, JournalPage
from app.schemas.user import ErrorResponse
from app.security import ACTIVATION_REQUIRED_DETAIL
from app.solutions import JOURNAL, SOLUTION_REQUIRED_DETAIL, require_solution_access
from app.trial import TRIAL_EXPIRED_DETAIL

router = APIRouter(tags=["journal"])
DbSession = Annotated[Session, Depends(get_db)]

JOURNAL_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: {
        "model": ErrorResponse,
        "description": "Требуется авторизация",
    },
    status.HTTP_403_FORBIDDEN: {
        "model": ErrorResponse,
        "description": f"{ACTIVATION_REQUIRED_DETAIL} — кабинет не активирован; "
        f"{ORGANIZATION_EDIT_FORBIDDEN_DETAIL} — роль не владелец; "
        f"{TRIAL_EXPIRED_DETAIL} — нет действующего тарифа; "
        f"{SOLUTION_REQUIRED_DETAIL} — нет права на решение «Журнал действий»",
    },
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": ORGANIZATION_NOT_FOUND_DETAIL,
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": f"{RANGE_TOO_LONG_DETAIL}; {RANGE_INVERTED_DETAIL}; "
        f"{RANGE_IN_FUTURE_DETAIL}; {RANGE_OUT_OF_CALENDAR_DETAIL}; "
        f"{INVALID_CURSOR_DETAIL}; limit вне 1..{MAX_LIMIT}; вид действия не из "
        "security/data/noise",
    },
}


def require_journal_access(membership: OwnerMembership, db: DbSession) -> OrganizationMember:
    """Владелец организации с действующим тарифом и правом на решение «Журнал действий».

    Право берётся из того же механизма, что у «Уведомлений» (`app.solutions`), и
    проверяется **после** `OwnerMembership`: порядок отказов контрактный —
    активация (403), роль (403 «Недостаточно прав»), тариф (403 закрытого
    кабинета), право (403 про магазин). Выбор текста живёт в одном месте
    (`solutions.require_solution_access`), а не второй копией здесь.

    Сотрудник без права не должен видеть предложение купить то, что ему не
    откроют, а неактивированный кабинет — предложение что-то купить вместо ссылки
    на письмо. Без действующего тарифа журнал не работает вовсе: услуга живёт
    ровно столько, сколько тариф.
    """
    require_solution_access(db, membership.organization_id, JOURNAL)
    return membership


# Готово для `Depends`: результат — строка членства владельца, её и берёт роут.
JournalAccess = Annotated[OrganizationMember, Depends(require_journal_access)]


@router.get(
    "/journal",
    response_model=JournalPage,
    summary="Журнал действий организации",
    responses=JOURNAL_RESPONSES,
)
def read_journal(
    membership: JournalAccess,
    db: DbSession,
    kind: Annotated[JournalKind | None, Query()] = None,
    date_from: Annotated[date | None, Query()] = None,
    date_to: Annotated[date | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: Annotated[str | None, Query()] = None,
) -> JournalPage:
    """Записи журнала своей организации за период, свежие сверху.

    Читает только владелец организации с действующим правом на решение `journal`:
    без права ручка отвечает 403 про магазин улучшений, и это контракт с
    кабинетом — по нему экран показывает «Решение не подключено».

    Фильтры необязательны: без них отдаётся неделя по сегодня включительно
    (сегодня — московское). `kind` сужает по виду действия — вид считается при
    записи по маршруту, а не выводится из ответа здесь.
    """
    start, end = period_range(date_from, date_to)
    try:
        lower, upper = day_bounds(start, end)
    except OverflowError:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, RANGE_OUT_OF_CALENDAR_DETAIL
        ) from None

    conditions = audit_conditions(
        organization_id=membership.organization_id,
        kind=kind,
        lower=lower,
        upper=upper,
    )
    rows, next_cursor, total = journal_page(db, conditions=conditions, limit=limit, cursor=cursor)
    return JournalPage(items=[entry(row) for row in rows], next_cursor=next_cursor, total=total)

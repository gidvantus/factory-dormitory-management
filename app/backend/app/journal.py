"""?????? ??????? ????????: ??????? ???????, ????? ??? ?????????? ? ????????????? ?????.

???????? ??????: ???? ???????, ??????, ??????? ? ???????? ????? ?????, ? ?? ? ?????.
?????????? `GET /api/journal` (`app/api/audit.py`) ? ?????????????
`GET /api/platform/journal` (`app/api/platform_journal.py`) ?????? ???? ???????
`audit_events` ????? ???? ? ?? ?? ???????, ??????? ??????, ?????? ? `total` ? ???
????????? ?? ????????. ?????????? ?????? ???????: ? ??????? ??????? ?? ???????????,
? ????????? ??? ???.

????, ????? ??????? ? ?????? ?????? ?? ?????? ??? ???????? ?? ????????.
"""

from datetime import UTC, date, datetime, time, timedelta
from typing import cast
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status
from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.orm import Session

from app import audit as audit_rules
from app.models.audit import AuditEvent
from app.report_readiness import today_moscow
from app.schemas.audit import JournalEntry, JournalKind

# Календарь фильтра — московский: так день в журнале совпадает с днём, который
# человек видит на экране и в остальных разделах кабинета.
JOURNAL_ZONE = ZoneInfo("Europe/Moscow")

# Диапазон по умолчанию: неделя — столько владелец смотрит «что было на этой
# неделе». Потолок в три месяца — компромисс между «весь квартал видно» и
# «запрос не читает все месячные партиции».
DEFAULT_PERIOD_DAYS = 7
MAX_RANGE_DAYS = 90

# Объём ответа: `changes` и `request_body` лежат в каждой строке (до ~3 КБ), и
# 200 записей — это уже сотни килобайт. Менять без пересчёта объёма нельзя.
DEFAULT_LIMIT = 50
MAX_LIMIT = 200

RANGE_TOO_LONG_DETAIL = (
    f"Слишком длинный период: журнал отдаётся не больше чем за {MAX_RANGE_DAYS} дней"
)
RANGE_INVERTED_DETAIL = "Дата начала периода позже даты окончания"
# Период целиком впереди: записей за него ещё нет, и `end + 1 день` на краю
# календаря (`date_to=9999-12-31`) иначе уронил бы ручку в 500.
RANGE_IN_FUTURE_DETAIL = "Период в будущем: записей за него ещё нет"
# Даты у самого края календаря: их московская полночь не переводится в UTC
# (`date.min` уходит в год 0), и 500 вместо 422 здесь недопустим.
RANGE_OUT_OF_CALENDAR_DETAIL = "Дата периода вне поддерживаемого календарного диапазона"
INVALID_CURSOR_DETAIL = "Некорректный курсор страницы"

# Разделитель частей курсора. В ISO-моменте его быть не может, а `rpartition`
# разрезает по последнему — на случай будущих форматов даты с двоеточиями.
CURSOR_SEPARATOR = "|"


def as_utc(moment: datetime) -> datetime:
    """Момент с таймзоной: SQLite отдаёт наивные значения, PostgreSQL — с зоной.

    Контракт один и тот же на обеих базах: клиент получает время в UTC, а не
    строку, которую браузер достроит до местного времени.
    """
    if moment.tzinfo is None:
        return moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


def entry(row: AuditEvent) -> JournalEntry:
    """Строка журнала в ответ. Название действия берётся из готового справочника.

    `actor_name` отдаётся как есть — тем снимком, что записан в строке. Join на
    `users` здесь не делается намеренно: он подставил бы текущее ФИО, и смена
    фамилии переписала бы историю задним числом. У строк до ревизии
    `0044_audit_actor_name` и у запросов без сессии значение остаётся `None`.
    """
    return JournalEntry(
        id=row.id,
        created_at=as_utc(row.created_at),
        actor_id=row.actor_id,
        actor_name=row.actor_name,
        method=row.method,
        path=row.path,
        action=row.action,
        # Неизвестный код остаётся кодом: придумывать название нельзя — журнал
        # должен показывать то, что записано.
        action_title=audit_rules.action_title(row.action),
        # Колонка `VARCHAR(8)` держит те же три вида, что перечисляет
        # `JournalKind`: приведение говорит об этом типизатору, а не ослабляет
        # проверку — в журнал пишет только `audit_kind`.
        kind=cast(JournalKind, row.kind),
        status=row.status,
        duration_ms=row.duration_ms,
        ip=row.ip,
        user_agent=row.user_agent,
        request_id=row.request_id,
        path_params=row.path_params,
        request_body=row.request_body,
        changes=row.changes,
    )


def page_cursor(row: AuditEvent) -> str:
    """Курсор следующей страницы: момент и `id` последней отданной строки.

    Момент пишется с `Z`, а не с `+00:00`: клиент вправе собрать адрес склейкой
    строк (`?cursor=...`), а `+` в query-строке декодируется сервером в пробел —
    тогда вторая страница падала бы в 422 «Некорректный курсор страницы».
    `datetime.fromisoformat` разбирает `Z` начиная с Python 3.11.
    """
    return f"{as_utc(row.created_at).isoformat().replace('+00:00', 'Z')}{CURSOR_SEPARATOR}{row.id}"


def parse_cursor(cursor: str) -> tuple[datetime, int]:
    """Разобрать курсор. Мусор — 422, а не 500 и не пустая страница.

    Курсор приходит от клиента и не проверяется схемой, поэтому разбирается
    вручную. Наивный момент считается UTC: так его отдаёт SQLite-база тестов, и
    так же он сравнивается с колонкой.
    """
    created_raw, separator, id_raw = cursor.rpartition(CURSOR_SEPARATOR)
    if not separator or not id_raw.isdigit():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, INVALID_CURSOR_DETAIL)
    try:
        created_at = datetime.fromisoformat(created_raw)
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, INVALID_CURSOR_DETAIL) from None
    return as_utc(created_at), int(id_raw)


def day_bounds(start: date, end: date) -> tuple[datetime, datetime]:
    """Полуинтервал `[начало первого дня, начало следующего за последним дня)`.

    Дни календаря — московские: `created_at` хранится в UTC, а человек выбирает
    день своей зоны, поэтому полночь берётся в `Europe/Moscow` и переводится в
    UTC. Верхняя граница не включается, поэтому записи последнего дня периода
    видны целиком.

    `OverflowError` здесь возможен на датах у края календаря (московская полночь
    `date.max` плюс сутки, `date.min` минус часовой пояс); вызывающий превращает
    его в 422, а не в 500.
    """
    return (
        datetime.combine(start, time.min, JOURNAL_ZONE).astimezone(UTC),
        datetime.combine(end + timedelta(days=1), time.min, JOURNAL_ZONE).astimezone(UTC),
    )


def period_range(date_from: date | None, date_to: date | None) -> tuple[date, date]:
    """Период запроса в московском календаре. Ошибки ввода — 422.

    Что здесь отсекается и почему именно так:

    * **период целиком в будущем** — записей оттуда ещё нет; заодно это снимает
      `OverflowError` на `date_to=9999-12-31`, который иначе уходил наружу как
      500;
    * **дата вне календаря** — у `date.min` московская полночь уходит в год 0, а
      `date.max` + сутки не существует: 422 вместо падения;
    * **конец периода в будущем** обрезается до сегодняшнего дня: завтрашних
      записей нет, а окно в 90 дней считается по реальным данным.

    Порядок проверок важен: сначала «период целиком в будущем» (иначе начало
    позже конца выглядело бы ошибкой ввода, хотя причина в другом), потом
    «начало позже конца», потом потолок длины, и только затем обрезка конца.
    Так `date_from` в будущем при `date_to` в прошлом остаётся ошибкой ввода, а
    не пустым периодом.
    """
    today = today_moscow()
    end = date_to if date_to is not None else today
    if date_from is not None:
        start = date_from
    elif end < date.min + timedelta(days=DEFAULT_PERIOD_DAYS - 1):
        # Низкая граница недели по умолчанию вышла бы за `date.min`.
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, RANGE_OUT_OF_CALENDAR_DETAIL)
    else:
        start = end - timedelta(days=DEFAULT_PERIOD_DAYS - 1)
    if start > today:
        # Период целиком впереди: это точнее, чем «начало позже конца», и
        # заодно снимает `OverflowError` на `date_to=9999-12-31`.
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, RANGE_IN_FUTURE_DETAIL)
    if start > end:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, RANGE_INVERTED_DETAIL)
    if (end - start).days + 1 > MAX_RANGE_DAYS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, RANGE_TOO_LONG_DETAIL)
    return start, min(end, today)


def audit_conditions(
    *,
    organization_id: int | None,
    kind: JournalKind | None,
    lower: datetime,
    upper: datetime,
) -> list[ColumnElement[bool]]:
    """??????? ???????: ???? `[lower, upper)`, ??? ?, ??? ?????????????, ???????????.

    `organization_id is None` - ??????? ?? ??????????? ???, ?????? ??????????????
    ??????? (`organization_id IS NULL`) ???????? ? ???????. ?????????? ??????
    ???????? id ????? ???????????, ??????? ????? ?????? ??? ?? ?????.
    """
    conditions: list[ColumnElement[bool]] = [
        AuditEvent.created_at >= lower,
        AuditEvent.created_at < upper,
    ]
    if organization_id is not None:
        conditions.append(AuditEvent.organization_id == organization_id)
    if kind is not None:
        conditions.append(AuditEvent.kind == kind)
    return conditions


def journal_page(
    db: Session,
    *,
    conditions: list[ColumnElement[bool]],
    limit: int,
    cursor: str | None,
) -> tuple[list[AuditEvent], str | None, int | None]:
    """???????? ???????: ??????, ?????? ????????? ???????? ? `total`.

    ??????? `created_at DESC, id DESC`; ??????? `limit + 1` ?????, ?????? ????? ??????
    ??? ??????? ????????? ????????. `total` ????????? ?????? ??? ???????: ??
    ??????????? ????????? ?? `None`, ?????? ????? ????? ? ?????? ????????.
    """
    statement = select(AuditEvent).where(*conditions)
    if cursor is not None:
        created_at, cursor_id = parse_cursor(cursor)
        statement = statement.where(
            or_(
                AuditEvent.created_at < created_at,
                and_(AuditEvent.created_at == created_at, AuditEvent.id < cursor_id),
            )
        )
    rows = list(
        db.scalars(
            statement.order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc()).limit(limit + 1)
        )
    )
    next_cursor = page_cursor(rows[limit - 1]) if len(rows) > limit else None
    total = (
        None
        if cursor is not None
        else db.scalar(select(func.count()).select_from(AuditEvent).where(*conditions)) or 0
    )
    return rows[:limit], next_cursor, total

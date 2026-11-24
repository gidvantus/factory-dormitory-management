"""Кэш чтения на время одного запроса (issue #242).

Дашборд читает одни и те же данные по нескольку раз: отчёт — в самом
обработчике и в каждом блоке, строки таблиц — на каждый блок и общежитие,
размещение персонала — в блоке и во вложенном отчёте. Тяжёлых запросов там нет,
проблема в их числе, поэтому кэшируются сами чтения, а не ответ
`GET /api/dashboard`: второй путь расчёта формул не появляется.

Кэш лежит в `Session.info` и живёт ровно столько, сколько живёт сессия. В API
сессия одна на запрос (`app.db.get_db`), поэтому она не делится между потоками
и блокировка не нужна. В юнит-прогоне одна сессия переживает несколько
запросов, поэтому `after_commit`/`after_rollback` сбрасывают кэш: запись и
следующий за ней `commit` обязаны сделать прежнее чтение невидимым.

Объекты в кэше общие для всех читателей запроса. Менять их нельзя: изменение
увидят все, кто прочитал тот же ключ. Если нужна своя копия —
`model_copy(deep=True)`.

Ключ отчёта — общежитие, период и `exclude_places`, но не пользователь: в
`read_report` параметр назван `_user` и не используется. Пока это так, отчёт
одинаков для всех, кому он доступен. Если `_user` начнут читать, ключ придётся
дополнить пользователем — иначе кэш станет утечкой прав.

`ensure_columns` и `FillResolver` здесь не кэшируются: у них есть записи и
`flush`, и результат зависит от изменений внутри того же запроса. Раскладка
дашборда и справочник источников тоже читаются один раз за запрос и в кэш не
идут.

Кроме крупных чтений, кэшируются точечные, которые блоки запрашивают по
нескольку раз на одно и то же общежитие: столбец таблицы, список хостелов,
пользовательская вкладка и строка отчёта. Это тоже чистое чтение: `get_column`,
`get_custom_tab`, `select(Hostel)` и `db.get(ReportRow)` ничего не пишут, а
`after_commit`/`after_rollback` не дают кэшу пережить запись.
"""

from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING, cast

from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.models.custom_tab import CustomTab
from app.models.hostel import Hostel
from app.models.report import ReportRow
from app.models.table_column import TableColumn

if TYPE_CHECKING:
    from collections.abc import Iterable

    from app.hostel_rows import PlaceDay
    from app.models.dormitory import Dormitory
    from app.schemas.report import ReportResponse
    from app.table_data import Record

# Один ключ в `Session.info`: сброс целиком, а не по частям. Имя видно в тестах,
# поэтому оно названо явно.
INFO_KEY = "read_cache"


@dataclass
class _Cache:
    """Прочитанное за время запроса. Ключи — идентификаторы и даты, не объекты."""

    reports: dict[tuple[int, date, date, bool], "ReportResponse"] = field(default_factory=dict)
    records: dict[tuple[int, str], "list[Record]"] = field(default_factory=dict)
    places: dict[tuple[tuple[int, ...], date, date], "dict[tuple[int, date], PlaceDay]"] = field(
        default_factory=dict
    )
    columns: dict[tuple[int, str, int], TableColumn] = field(default_factory=dict)
    dormitory_hostels: dict[int, list[Hostel]] = field(default_factory=dict)
    tabs: dict[tuple[int, int], CustomTab] = field(default_factory=dict)
    report_rows: dict[tuple[int, int], ReportRow | None] = field(default_factory=dict)


def _cache(db: Session) -> _Cache:
    cache = db.info.get(INFO_KEY)
    if cache is None:
        cache = _Cache()
        db.info[INFO_KEY] = cache
    return cast(_Cache, cache)


def clear(db: Session) -> None:
    """Забыть всё прочитанное в этой сессии.

    Вызывается слушателями `after_commit`/`after_rollback`, а руками — только
    если код пишет в базу в обход обычного `commit` (таких мест в задаче нет).
    """
    db.info.pop(INFO_KEY, None)


@event.listens_for(Session, "after_commit")
@event.listens_for(Session, "after_rollback")
def _clear_after_write(session: Session) -> None:
    """Сбросить кэш после записи: следующие чтения обязаны увидеть новые данные."""
    clear(session)


def report(
    db: Session,
    dormitory_id: int,
    dormitory: "Dormitory",
    from_date: date,
    to_date: date,
    *,
    exclude_places: bool = False,
) -> "ReportResponse":
    """Общий отчёт за период — один раз на запрос для этого периода.

    `user` не передаётся: он не участвует в `read_report` (см. докстринг
    модуля). `dormitory` нужен только для сигнатуры самой ручки отчёта.
    """
    key = (dormitory_id, from_date, to_date, exclude_places)
    cache = _cache(db)
    if key not in cache.reports:
        from app.api.reports import read_report

        cache.reports[key] = read_report(
            dormitory_id,
            None,
            db,
            from_date,
            to_date,
            dormitory,
            exclude_places=exclude_places,
        )
    return cache.reports[key]


def records(db: Session, dormitory_id: int, table_key: str) -> "list[Record]":
    """Строки таблицы общежития — один раз на запрос, в порядке `id`."""
    key = (dormitory_id, table_key)
    cache = _cache(db)
    if key not in cache.records:
        from app.table_data import records_for

        cache.records[key] = records_for(db, dormitory_id, table_key)
    return cache.records[key]


def place_days(
    db: Session, hostels: "Iterable[Hostel]", start: date, end: date
) -> "dict[tuple[int, date], PlaceDay]":
    """Размещение персонала по дням за период — один раз на набор хостелов.

    Ключ — отсортированные `id` хостелов и период. Набор «все хостелы» и «один
    хостел» — разные ключи, поэтому блок с фильтром и общий блок не делят
    результат: у них разный состав строк.
    """
    selected = list(hostels)
    key = (tuple(sorted(hostel.id for hostel in selected)), start, end)
    cache = _cache(db)
    if key not in cache.places:
        from app.hostel_rows import read_place_days

        cache.places[key] = read_place_days(db, selected, start, end)
    return cache.places[key]


def column(db: Session, dormitory_id: int, table_key: str, column_id: int) -> TableColumn:
    """Столбец таблицы — один раз на запрос.

    `get_column` читает по первичному ключу и ничего не пишет, поэтому кэш
    безопасен. `ensure_columns` по-прежнему не кэшируется: он создаёт столбцы и
    делает `flush`.
    """
    key = (dormitory_id, table_key, column_id)
    cache = _cache(db)
    if key not in cache.columns:
        from app.table_data import get_column

        cache.columns[key] = get_column(db, dormitory_id, table_key, column_id)
    return cache.columns[key]


def hostels(db: Session, dormitory_id: int) -> list[Hostel]:
    """Хостелы общежития — один раз на запрос, в порядке базы.

    Список общий и только для чтения: фильтровать его нужно в новый список, а
    не `remove`/`sort` на месте.
    """
    cache = _cache(db)
    if dormitory_id not in cache.dormitory_hostels:
        cache.dormitory_hostels[dormitory_id] = list(
            db.scalars(select(Hostel).where(Hostel.dormitory_id == dormitory_id))
        )
    return cache.dormitory_hostels[dormitory_id]


def custom_tab(db: Session, dormitory_id: int, tab_id: int) -> CustomTab:
    """Пользовательская вкладка как ручная таблица — один раз на запрос.

    Обёртка над `get_custom_tab(..., require_table=True)`: именно так вкладку
    проверяют блоки дашборда и связи отчёта.
    """
    key = (dormitory_id, tab_id)
    cache = _cache(db)
    if key not in cache.tabs:
        from app.table_data import get_custom_tab

        cache.tabs[key] = get_custom_tab(db, dormitory_id, tab_id, require_table=True)
    return cache.tabs[key]


def report_row(db: Session, dormitory_id: int, row_id: int) -> ReportRow | None:
    """Строка общего отчёта — один раз на запрос.

    Может быть `None`: блок со ссылкой на удалённую строку должен получить тот
    же отказ, что и без кэша.
    """
    key = (dormitory_id, row_id)
    cache = _cache(db)
    if key not in cache.report_rows:
        cache.report_rows[key] = db.get(ReportRow, row_id)
    return cache.report_rows[key]

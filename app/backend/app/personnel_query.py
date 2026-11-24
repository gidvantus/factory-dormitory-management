"""Отбор страницы персонала и превью блоков в SQL (#251).

До #251 страница людей собиралась так: в память поднимались все карточки области
(4 874 сотрудника × строки-источники), а фильтры, порядок и срез страницы
считались в Python поверх полного массива. Стоимость запроса росла с числом
сотрудников, а не с размером страницы: `GET /api/personnel/employees` отдавал 20
строк за то же время, что и 100, и это время зависело от базы целиком.

Теперь порядок обратный: сначала SQL отбирает корни карточек (область, срок
вахты, поиск, условия по столбцам), затем сортирует их и отдаёт только id
страницы; карточки собираются лишь для отобранных строк. `total` — `len` этого
отбора, а не результат сборки всех карточек.

Что где решается:

* область, срок вахты и поиск — одним проходом по строкам-источникам и журналу
  (`employee_events`), без сборки карточек;
* сортировка — по показываемому имени карточки (`employees.sort_name`, а при
  пустом ФИО — «ФИО не указано») и `id`; для `filter=ending` первым ключом идёт
  ранний конец вахты, как у клиентского `ordered`;
* условия по столбцам остаются правилами из `app/personnel_page.py`: они решают
  по строке-источнику (одна таблица, одна строка), поэтому строки читаются только
  у кандидатов, а сравнение значений делает тот же проверенный код, что и раньше.
  Это единственная часть отбора не в SQL, и она включается только при заданных
  `column_filters`.

Модуль не импортирует `app.personnel`: тот импортирует его сам, а строки-источники
и карточки приходят вызывающим слоем (`load_sources`, `cards_for`), чтобы не
заводить цикл модулей.
"""

from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.personnel import Employee, EmployeeAlias, EmployeeEvent
from app.models.resident import Resident
from app.personnel_page import (
    DIGITS,
    PHONE_QUERY,
    ListCriteria,
    add_days,
    block_criteria,
    column_predicate,
    has_active_column_rules,
    normalize,
)

if TYPE_CHECKING:
    from app.personnel import SourceRecord

SourcesLoader = Callable[[Sequence[int], set[str]], list["SourceRecord"]]
"""Строки-источники по общежитиям области и множеству карточек: `all_sources`."""

NAMELESS = normalize("ФИО не указано")
"""Показываемое имя карточки без своего ФИО — в форме сравнения (`sort_name`)."""


def allowed_dormitories(dormitory_ids: Sequence[int], criteria: ListCriteria) -> list[int]:
    """Общежития области, которые проходят выбор списка."""
    return [id for id in dormitory_ids if criteria.allowed(id)]


@dataclass(frozen=True)
class Shifts:
    """Сроки вахты по корням карточек, снятые одним запросом по проживанию."""

    current: frozenset[str]
    """Корни с текущей записью проживания — фильтр `current`."""

    ending: frozenset[str]
    """Корни, у которых вахта кончается в окне `days` — фильтр `ending`."""

    ends: dict[str, str]
    """Ранний конец вахты по всем текущим записям — порядок страницы `ending`."""

    window_ends: dict[str, str]
    """Ранний конец вахты внутри окна — дата события в блоке «Заканчивается вахта»."""

    dorms: dict[str, set[int]] = field(default_factory=dict)
    """Общежития текущих записей по корням — разбивка блока «Проживают».

    Снято тем же запросом по `residents`, что и сроки: отдельный проход давал
    рамке ещё одно обращение к базе за теми же строками (#251).
    """


@dataclass(frozen=True)
class Candidates:
    """Отбор списка: множества корней по каждому условию и их пересечение."""

    criteria: ListCriteria
    base: frozenset[str]
    shifts: Shifts
    query: frozenset[str] | None
    columns: frozenset[str] | None

    def roots(self, filter: str | None = None) -> set[str]:
        """Корни, проходящие условия, — как `filtered` в прежнем порте."""
        result = set(self.base)
        chosen = filter if filter is not None else self.criteria.filter
        if chosen == "current":
            result &= self.shifts.current
        elif chosen == "ending":
            result &= self.shifts.ending
        if self.query is not None:
            result &= self.query
        if self.columns is not None:
            result &= self.columns
        return result


def _base_roots(db: Session, roots: dict[str, str], allowed: Sequence[int]) -> frozenset[str]:
    """Корни, у которых есть строка-источник или запись журнала в области.

    Прежняя сборка карточек отбрасывала людей без источников и без истории, и
    порядок `total` считается по тем же людям. Шесть запросов по числу таблиц-
    источников дешевле сборки карточек: читается только `employee_id`.
    """
    if not allowed:
        return frozenset()
    # `app.personnel` импортирует этот модуль, поэтому справочник моделей-источников
    # читается здесь, а не на импорте модуля.
    from app.personnel import SOURCE_MODELS

    members: set[str] = set()
    for model in SOURCE_MODELS:
        members.update(
            db.scalars(
                select(model.employee_id)
                .where(model.employee_id.is_not(None), model.dormitory_id.in_(allowed))
                .distinct()
            )
        )
    members.update(
        db.scalars(
            select(EmployeeEvent.employee_id)
            .where(EmployeeEvent.dormitory_id.in_(allowed))
            .distinct()
        )
    )
    return frozenset(roots[member] for member in members if member in roots)


def _shifts(
    db: Session, roots: dict[str, str], allowed: Sequence[int], day: date, days: int
) -> Shifts:
    """Текущее проживание, концы вахты и общежития по строкам `residents` области."""
    current: set[str] = set()
    ending: set[str] = set()
    ends: dict[str, str] = {}
    window_ends: dict[str, str] = {}
    dorms: dict[str, set[int]] = defaultdict(set)
    if allowed:
        for employee_id, dormitory_id, end in db.execute(
            select(Resident.employee_id, Resident.dormitory_id, Resident.shift_end).where(
                Resident.employee_id.is_not(None), Resident.dormitory_id.in_(allowed)
            )
        ):
            if employee_id is None:
                continue
            root = roots[employee_id]
            current.add(root)
            dorms[root].add(dormitory_id)
            if end is None:
                continue
            text = end.isoformat()
            if root not in ends or text < ends[root]:
                ends[root] = text
            left = (end - day).days
            if left < 0 or left > days:
                continue
            ending.add(root)
            if root not in window_ends or text < window_ends[root]:
                window_ends[root] = text
    return Shifts(frozenset(current), frozenset(ending), ends, window_ends, dict(dorms))


def _query_roots(
    db: Session, criteria: ListCriteria, roots: dict[str, str]
) -> frozenset[str] | None:
    """Корни, у которых ФИО, табельный, телефон или вариант ФИО содержат запрос.

    Сравнение идёт в Python, а не в SQL: `lower()` в SQLite знает только латиницу,
    а `ILIKE` есть только в PostgreSQL, поэтому SQL-поиск подстроки молча терял бы
    русские запросы в юнит-прогоне. Один проход по четырём колонкам — это
    единственный запрос страницы, который читает строки помимо отобранных; так
    делает и клиент, который искал подстроку в склейке полей карточки и её
    вариантов. Если запрос выглядит телефоном, добавляется сравнение по цифрам —
    ровно то, что делал клиент (`PHONE_QUERY` и `DIGITS`), и только по телефонам:
    табельный номер в цифровую ветку не входит.

    Отдаются корни, а не `id` найденных строк: остальные множества отбора тоже
    множества корней, и присоединённая карточка иначе выпадала бы из пересечения
    в `Candidates.roots()`, хотя её ФИО показывает карточка группы.
    """
    query = normalize(criteria.query)
    if not query:
        return None
    digits = DIGITS.sub("", query)
    by_digits = bool(PHONE_QUERY.fullmatch(query)) and len(digits) >= 3
    parts: dict[str, list[str]] = defaultdict(list)
    phones: dict[str, list[str]] = defaultdict(list)
    for employee_id, name, number, phone in db.execute(
        select(Employee.id, Employee.full_name, Employee.personnel_number, Employee.phone)
    ):
        parts[employee_id].extend(value for value in (name, number, phone) if value)
        if phone:
            phones[employee_id].append(phone)
    for employee_id, alias_field, raw in db.execute(
        select(EmployeeAlias.employee_id, EmployeeAlias.field, EmployeeAlias.raw_value)
    ):
        parts[employee_id].append(raw)
        if alias_field == "phone":
            phones[employee_id].append(raw)
    result: set[str] = set()
    for employee_id, values in parts.items():
        text = normalize(" ".join(values))
        matched = query in text
        if not matched and by_digits:
            matched = digits in DIGITS.sub("", normalize(" ".join(phones.get(employee_id, ()))))
        if matched and (root := roots.get(employee_id)) is not None:
            result.add(root)
    return frozenset(result)


def _cards_lite(
    db: Session,
    *,
    roots: dict[str, str],
    identities: dict[str, dict[str, Any]],
    tabs: dict[str, str],
    allowed: Sequence[int],
    members: Iterable[str],
    load_sources: SourcesLoader,
) -> dict[str, dict[str, Any]]:
    """Карточки без истории и событий — только то, что читают условия столбцов.

    `column_predicate` решает по строке-источнику, и ему нужны `sources`,
    `current`, `variants` и поля карточки. Полная `employee_cards` для этого не
    нужна: журнал, общежития истории и разбивка вариантов по полям условий не
    участвуют.
    """
    selected = set(members)
    result: dict[str, dict[str, Any]] = {}
    for member in selected:
        root = roots[member]
        if root in result:
            continue
        result[root] = {
            "id": root,
            **identities[root],
            "sources": [],
            "current": [],
            "variants": {},
        }
    if not selected:
        return result
    variants: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for employee_id, alias_field, raw in db.execute(
        select(EmployeeAlias.employee_id, EmployeeAlias.field, EmployeeAlias.raw_value).where(
            EmployeeAlias.employee_id.in_(selected)
        )
    ):
        variants[roots[employee_id]][alias_field].append(raw)
    for root, field_values in variants.items():
        result[root]["variants"] = dict(field_values)
    for source in load_sources(allowed, selected):
        source_root = roots.get(source.employee_id or "")
        card = result.get(source_root) if source_root is not None else None
        if card is None:
            continue
        record = {
            "table_key": source.table_key,
            "row_id": source.row_id,
            "dormitory_id": source.dormitory_id,
            "source_name": tabs.get(source.table_key, source.table_key),
            "values": source.values,
        }
        card["sources"].append(record)
        if record["table_key"] == "residents":
            card["current"].append(record)
    return result


def candidates(
    db: Session,
    *,
    roots: dict[str, str],
    identities: dict[str, dict[str, Any]],
    tabs: dict[str, str],
    dormitory_ids: Sequence[int],
    criteria: ListCriteria,
    day: date,
    dormitories: list[dict[str, Any]],
    source_columns: list[dict[str, Any]],
    load_sources: SourcesLoader,
) -> Candidates:
    """Отбор по всем условиям списка — один раз на запрос страницы или рамки."""
    allowed = allowed_dormitories(dormitory_ids, criteria)
    base = _base_roots(db, roots, allowed)
    shifts = _shifts(db, roots, allowed, day, criteria.days)
    query = _query_roots(db, criteria, roots) if base else None
    columns: frozenset[str] | None = None
    if has_active_column_rules(criteria) and base:
        narrowed = set(base)
        if query is not None:
            narrowed &= query
        # Условия столбцов зависят от фильтра только через область, поэтому
        # считаются один раз на более широком множестве и пересекаются ниже.
        members = {member for member, root in roots.items() if root in narrowed}
        people = _cards_lite(
            db,
            roots=roots,
            identities=identities,
            tabs=tabs,
            allowed=allowed,
            members=members,
            load_sources=load_sources,
        )
        predicate = column_predicate(criteria, source_columns, dormitories)
        columns = frozenset(root for root, card in people.items() if predicate(card))
    return Candidates(criteria, base, shifts, query, columns)


def criteria_key(criteria: ListCriteria) -> tuple[Any, ...]:
    """Условия, от которых зависит `candidates()`.

    `filter` в ключ не входит: `base`, `shifts`, `query` и `columns` от него не
    зависят, а текущий фильтр `Candidates.roots(filter)` принимает аргументом.
    Поэтому блоки с разными фильтрами, но одной областью и сроком вахты делят
    один отбор.
    """
    return (
        criteria.dormitory,
        tuple(criteria.scope),
        criteria.days,
        normalize(criteria.query),
        criteria.column_filters,
    )


@dataclass
class SelectionCache:
    """Отбор списка по набору условий — один раз на запрос рабочей поверхности.

    Превью блоков и сводка `counts` считают отбор при разных фильтрах срока, но
    при одинаковых области, сроке вахты, поиске и условиях столбцов; без кеша
    каждый блок заново читал строки-источники, журнал и вахты (`_base_roots`,
    `_shifts`, `_query_roots`). Кеш держит отбор на набор условий, а фильтр
    пересекается с ним при сборке блока или сводки.
    """

    db: Session
    roots: dict[str, str]
    identities: dict[str, dict[str, Any]]
    tabs: dict[str, str]
    dormitory_ids: Sequence[int]
    day: date
    dormitories: list[dict[str, Any]]
    source_columns: list[dict[str, Any]]
    load_sources: SourcesLoader
    _found: dict[tuple[Any, ...], Candidates] = field(default_factory=dict)

    def get(self, criteria: ListCriteria) -> Candidates:
        key = criteria_key(criteria)
        found = self._found.get(key)
        if found is None:
            found = candidates(
                self.db,
                roots=self.roots,
                identities=self.identities,
                tabs=self.tabs,
                dormitory_ids=self.dormitory_ids,
                criteria=criteria,
                day=self.day,
                dormitories=self.dormitories,
                source_columns=self.source_columns,
                load_sources=self.load_sources,
            )
            self._found[key] = found
        return found


def displayed_name() -> Any:
    """Ключ порядка страницы: показываемое имя карточки, а не ФИО строки-корня.

    У карточки без своего ФИО `sort_name` пуст, а показывается она как «ФИО не
    указано» (`personName` клиента), поэтому прежний порядок ставил её между
    «Устинов» и «Хромов», а не первой. Подстановка возвращает этот порядок, не
    трогая саму колонку: ФИО карточки остаётся пустым в ответе.
    """
    return func.coalesce(func.nullif(Employee.sort_name, ""), NAMELESS)


def sort_name_of(employee: Employee) -> str:
    """То же, что `displayed_name()`, но для ключа `ending` в Python."""
    return employee.sort_name or NAMELESS


def ordered_roots(
    db: Session,
    employees: dict[str, Employee],
    selection: set[str],
    criteria: ListCriteria,
    shifts: Shifts,
    *,
    sql_order: bool = True,
) -> list[str]:
    """Порядок клиента: при `ending` — по раннему концу вахты, дальше ФИО и `id`.

    `sql_order=False` считает тот же порядок в памяти: превью блоков сортируют
    весь отбор целиком, и отдельный `ORDER BY` был бы ещё одним обращением к базе
    без выигрыша. Страница сортируется в SQL — там порядок идёт по индексу.
    Ключи совпадают: `sort_name` уже в форме сравнения, а коды символов и байты
    UTF-8 дают один порядок, как и `COLLATE "C"` в PostgreSQL.
    """
    if not selection:
        return []
    if criteria.filter == "ending":
        return sorted(
            selection,
            key=lambda root: (
                shifts.ends.get(root, ""),
                sort_name_of(employees[root]),
                root,
            ),
        )
    if not sql_order:
        return sorted(selection, key=lambda root: (sort_name_of(employees[root]), root))
    column: Any = displayed_name()
    if db.get_bind().dialect.name == "postgresql":
        # Порядок байтов UTF-8 совпадает с порядком кодов символов, как и
        # клиентский `russian_key`: локаль базы на порядок списка не влияет.
        column = column.collate("C")
    return list(
        db.scalars(
            select(Employee.id).where(Employee.id.in_(selection)).order_by(column, Employee.id)
        )
    )


def person_page(
    db: Session,
    *,
    candidates: Candidates,
    employees: dict[str, Employee],
    number: int,
    per_page: int,
) -> tuple[list[str], int]:
    """Корни запрошенной страницы и общее число людей в списке."""
    people = ordered_roots(
        db, employees, candidates.roots(), candidates.criteria, candidates.shifts
    )
    start = (number - 1) * per_page
    return people[start : start + per_page], len(people)


def counts_by_filter(
    *,
    candidates: Candidates,
    filters: tuple[str, ...] = ("all", "current", "ending"),
) -> dict[str, int]:
    """Сколько человек в каждом фильтре — сводка рабочей поверхности (#247).

    Числа «Персонал N», «Проживают сейчас» и «Завершают вахту» раньше считались
    в браузере по всему массиву карточек. Отбор у всех трёх общий (область,
    поиск, условия столбцов), меняется только фильтр срока, поэтому он считается
    один раз, а фильтры пересекаются с ним (`Candidates`, #251). Значение
    совпадает с `total` одноимённой страницы.
    """
    return {filter: len(candidates.roots(filter)) for filter in filters}


def block_previews(
    db: Session,
    *,
    selection: SelectionCache,
    employees: dict[str, Employee],
    lists: list[dict[str, Any]],
    blocks: list[dict[str, Any]] | None,
    day: date,
    dormitory: int | None,
    dormitories: list[dict[str, Any]],
    arrivals: list[dict[str, Any]],
    cards_for: Callable[[list[str]], list[dict[str, Any]]],
    default_blocks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Данные блоков рабочей поверхности без полной выборки карточек (#247).

    Блок рисовался из общего массива сотрудников; при `?employees=none` массива
    нет, поэтому счётчик, первые карточки, события для диаграммы и разбивка по
    общежитиям считаются здесь. Подписи дат, цвета и легенда остаются на клиенте.

    Отбор блока идёт тем же `candidates`, что и страница под ним, поэтому
    счётчик блока равен `total` списка с теми же условиями, а порядок — тот же
    (раньше превью шло в порядке карточек по `id`).

    Отбор и порядок стоят один раз на набор условий, а не на блок (#251): у
    блоков с одинаковой областью и сроком вахты общий `SelectionCache`, порядок
    считается по всему отбору и пересекается с набором блока, а карточки
    превью тянутся одним `cards_for` по объединению id. Иначе число запросов
    рамки росло бы с числом блоков.
    """
    today_text = day.isoformat()
    ordered: dict[tuple[Any, ...], list[str]] = {}
    previews: list[dict[str, Any]] = []
    # Корни превью по блокам: карточки собираются одним `cards_for` ниже.
    pages: list[list[str]] = []
    wanted: list[str] = []
    seen: set[str] = set()
    for block in blocks if blocks is not None else default_blocks:
        criteria, missing = block_criteria(block, dormitory, lists)
        limit = int(block["limit"])
        if block["kind"] == "plans":
            selected = sorted(
                (
                    plan
                    for plan in arrivals
                    if criteria.allowed(plan["dormitory_id"])
                    and today_text <= plan["date"] <= add_days(today_text, block["days"])
                ),
                key=lambda plan: (plan["date"], plan["id"]),
            )
            previews.append(
                {
                    "id": block["id"],
                    "kind": block["kind"],
                    "title": block["title"],
                    "count": sum(plan["count"] for plan in selected),
                    "items": [],
                    "events": [{"date": plan["date"], "count": plan["count"]} for plan in selected],
                    "dorms": [],
                    "missing_list": False,
                }
            )
            pages.append([])
            continue
        found = selection.get(criteria)
        # Порядок считается по всему отбору, а не по набору блока: ключ
        # `(ФИО, id)` (или `(конец вахты, ФИО, id)`) — полный порядок, поэтому
        # пересечение с набором блока его сохраняет, а запрос остаётся один на
        # фильтр, сколько бы блоков его ни просило.
        order_key = (criteria_key(criteria), criteria.filter)
        if order_key not in ordered:
            ordered[order_key] = ordered_roots(
                db, employees, set(found.base), criteria, found.shifts, sql_order=False
            )
        people = [] if missing else [root for root in ordered[order_key] if root in found.roots()]
        page_ids = people[:limit]
        pages.append(page_ids)
        for root in page_ids:
            if root not in seen:
                seen.add(root)
                wanted.append(root)
        dorms: list[dict[str, Any]] = []
        if block["kind"] == "residents":
            # Общежития текущих записей сняты тем же запросом, что и сроки вахты.
            now = found.shifts.dorms
            dorms = [
                {
                    "id": item["id"],
                    "name": item["name"],
                    "client_name": item["client_name"],
                    "is_archived": item["is_archived"],
                    "count": sum(1 for root in people if item["id"] in now.get(root, set())),
                }
                for item in dormitories
                if criteria.allowed(item["id"])
            ]
        previews.append(
            {
                "id": block["id"],
                "kind": block["kind"],
                "title": block["title"],
                "count": len(people),
                "items": [],
                "events": (
                    [
                        {"date": found.shifts.window_ends[root], "count": 1}
                        for root in people
                        if root in found.shifts.window_ends
                    ]
                    if block["kind"] == "ending"
                    else []
                ),
                "dorms": dorms,
                "missing_list": missing,
            }
        )
    cards = {card["id"]: card for card in cards_for(wanted)} if wanted else {}
    for preview, page_ids in zip(previews, pages, strict=True):
        preview["items"] = [cards[root] for root in page_ids if root in cards]
    return previews

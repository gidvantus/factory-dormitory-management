"""Точечные правки стоимости `GET /api/personnel` (issue #237).

Ответ этой ручки не меняется — меняется только то, сколько работы Python делает
по дороге. Поэтому каждый тест здесь сверяет поведение с прежним, а не
придумывает новое:

* `row_values` приводит дату и время к строке явно, а не проходом
  `json.dumps`/`json.loads` по всей строке: результат обязан совпасть с прежним
  побайтово, включая наложенные поля `PersonnelBinding`;
* `workspace` собирает состав группы одним проходом по `roots` (было
  O(карточек × карточек)), но `member_ids` остаётся тем же списком в том же
  порядке;
* `all_sources` не читает справочник общежитий второй раз: `workspace` уже
  загрузил его и отдаёт в ответ;
* `all_sources` читает строки-источники запросом по колонкам, а не ORM-объектами:
  значения и их порядок в ответе остаются прежними.

Замер стоимости — отдельный `dbtest` (`tests/test_personnel_workspace_perf.py`):
на SQLite он ничего не показывает.
"""

import json
from datetime import UTC, date, datetime
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app import sql_diagnostics
from app.api.personnel import get_workspace
from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.hostel import Hostel
from app.models.inflow import PersonnelInflow
from app.models.organization import OrganizationMember
from app.models.outflow import PersonnelOutflow
from app.models.personnel import Employee, PersonnelBinding
from app.models.resident import Resident
from app.models.table_column import ArchiveEntry
from app.personnel import (
    SOURCE_KEYS,
    SOURCE_MODELS,
    Row,
    all_sources,
    check_source_keys,
    row_values,
    source_key,
    source_spec,
    workspace,
)
from tests.conftest import create_user, organizations_for, sign_in
from tests.test_reports import create_dormitory

# Момент создания строки фиксирован: иначе сверка с прежним поведением зависела бы
# от часов, а не от кода.
CREATED_AT = datetime(2026, 1, 1, 9, 30, tzinfo=UTC)

# Ключи эталона заморожены строками, а не взяты из `SOURCE_KEYS`: сверка должна
# поймать смену ключа у модели, а не повторить её за кодом. Что эти строки
# совпадают со справочником на момент #237, проверяет соседний
# `test_source_keys_is_the_only_registry_of_table_keys`.
PREVIOUS_KEYS: dict[type[Row], str] = {
    Resident: "residents",
    PersonnelInflow: "inflow",
    PersonnelOutflow: "outflow",
    ArchiveEntry: "archive",
}


def previous_row_values(row: Row, lookup: dict[str, Any]) -> dict[str, Any]:
    """Эталон — точная копия `row_values` до #237, со проходом через `json`.

    Копия намеренная: тест должен сверять новое поведение с прежним, а не с
    пересказом прежнего поведения. Наложенные поля (`dormitory_name`,
    `client_name`, `hostel_name`, поля `PersonnelBinding`) копируются вместе с
    логикой, потому что они тоже участвуют в сравнении. Ключ таблицы берётся из
    `PREVIOUS_KEYS`, а не из живого `source_key`: иначе смена ключа меняла бы и
    эталон, и сверку разом.
    """
    values = {
        column.key: getattr(row, column.key)
        for column in row.__table__.columns
        if column.key != "employee_id"
    }
    values = json.loads(json.dumps(values, default=lambda value: value.isoformat()))
    dormitory = lookup["dormitories"].get(row.dormitory_id)
    values["dormitory_name"] = dormitory.name if dormitory else "Удалённое общежитие"
    values["client_name"] = dormitory.client_name if dormitory else ""
    if isinstance(row, Resident) and row.hostel_id:
        hostel = lookup["hostels"].get(row.hostel_id)
        values["hostel_name"] = hostel.name if hostel else None
    key = PREVIOUS_KEYS.get(type(row)) or f"custom_{row.tab_id}"
    binding = lookup["bindings"].get((row.dormitory_id, key))
    if binding:
        for field, column_id in binding.fields.items():
            value = (row.custom_values or {}).get(str(column_id))
            if value is not None:
                values[field] = str(value)
    return values


def resident_with_history(db_session: Session) -> tuple[Resident, dict[str, Any]]:
    """Строка проживающего со всеми видами значений: даты, JSON, связанные поля."""
    user = create_user(db_session)
    organization, _membership = organizations_for(db_session, user)
    dormitory = Dormitory(
        name="Северное", client_name="Стройкомплект", organization_id=organization.id
    )
    db_session.add(dormitory)
    db_session.flush()
    hostel = Hostel(
        dormitory_id=dormitory.id,
        name="Корпус 1",
        active_from_month=date(2026, 1, 1),
    )
    db_session.add(hostel)
    db_session.flush()
    resident = Resident(
        dormitory_id=dormitory.id,
        hostel_id=hostel.id,
        full_name="Семёнов Иван Иванович",
        personnel_number="Т-10",
        phone="+7 912 000 00 01",
        shift_start=date(2026, 1, 10),
        shift_end=date(2026, 2, 10),
        shift_count=30,
        created_at=CREATED_AT,
        custom_values={"7": "Повар"},
    )
    db_session.add(resident)
    binding = PersonnelBinding(
        dormitory_id=dormitory.id, table_key="residents", fields={"position": 7}
    )
    db_session.add(binding)
    db_session.commit()
    db_session.refresh(resident)
    lookup = {
        "dormitories": {dormitory.id: dormitory},
        "hostels": {hostel.id: hostel},
        "bindings": {(dormitory.id, "residents"): binding},
    }
    return resident, lookup


def test_row_values_keeps_the_previous_serialization(db_session: Session) -> None:
    """Дата и время — строка, остальное не тронуто, наложения на месте."""
    resident, lookup = resident_with_history(db_session)

    assert row_values(db_session, resident, lookup) == previous_row_values(resident, lookup)


def test_row_values_without_lookup_keeps_the_previous_serialization(
    db_session: Session,
) -> None:
    """Путь без справочника (`record_changed`, `all_sources` без `lookup`) — тот же."""
    resident, lookup = resident_with_history(db_session)

    assert row_values(db_session, resident) == previous_row_values(resident, lookup)


def test_all_sources_keeps_the_previous_values_and_order(db_session: Session) -> None:
    """Выборка колонок вместо ORM-объектов не меняет ни значения, ни их порядок.

    Сверка идёт с прежней реализацией (`previous_row_values`), а не с пересказом:
    строки-источники всех пяти моделей читаются запросом по колонкам, и ответ
    обязан остаться прежним — включая порядок ключей, который виден в JSON.
    """
    user = create_user(db_session)
    organization, _membership = organizations_for(db_session, user)
    dormitory = Dormitory(
        name="Северное", client_name="Стройкомплект", organization_id=organization.id
    )
    db_session.add(dormitory)
    db_session.flush()
    hostel = Hostel(
        dormitory_id=dormitory.id,
        name="Хостел 1",
        active_from_month=date(2026, 1, 1),
        occupancy_since=date(2026, 1, 1),
        resident_fields_since=date(2026, 1, 1),
    )
    db_session.add(hostel)
    employees = [Employee(full_name=f"Сотрудник {index}") for index in range(4)]
    db_session.add_all(employees)
    db_session.flush()
    tab = CustomTab(dormitory_id=dormitory.id, name="Своя", table_created=True)
    db_session.add(tab)
    db_session.flush()
    db_session.add_all(
        [
            Resident(
                dormitory_id=dormitory.id,
                employee_id=employees[0].id,
                full_name="Проживающий",
                hostel_id=hostel.id,
                shift_start=date(2026, 1, 10),
                shift_count=3,
                phone="+7 912 000 00 01",
                created_at=CREATED_AT,
                custom_values={"7": "Повар"},
            ),
            PersonnelInflow(
                dormitory_id=dormitory.id,
                employee_id=employees[1].id,
                settlement_date=date(2026, 1, 11),
                full_name="Приток",
                resident_values={"gender": "male"},
                created_at=CREATED_AT,
            ),
            PersonnelOutflow(
                dormitory_id=dormitory.id,
                employee_id=employees[2].id,
                departure_date=date(2026, 1, 12),
                full_name="Отток",
                evicted_at=CREATED_AT,
                created_at=CREATED_AT,
            ),
            ArchiveEntry(
                dormitory_id=dormitory.id,
                employee_id=employees[3].id,
                custom_values={"9": "архив"},
                created_at=CREATED_AT,
            ),
            CustomTabEntry(
                dormitory_id=dormitory.id,
                employee_id=employees[0].id,
                tab_id=tab.id,
                custom_values={"5": "значение"},
                created_at=CREATED_AT,
            ),
        ]
    )
    db_session.add_all(
        [
            PersonnelBinding(
                dormitory_id=dormitory.id, table_key="residents", fields={"position": 7}
            ),
            PersonnelBinding(
                dormitory_id=dormitory.id, table_key=f"custom_{tab.id}", fields={"mark": 5}
            ),
        ]
    )
    db_session.commit()
    db_session.refresh(dormitory)

    sources = all_sources(db_session, [dormitory.id], [dormitory])

    lookup = {
        "dormitories": {dormitory.id: dormitory},
        "hostels": {hostel.id: hostel},
        "bindings": {
            (binding.dormitory_id, binding.table_key): binding
            for binding in db_session.scalars(
                select(PersonnelBinding).where(PersonnelBinding.dormitory_id == dormitory.id)
            )
        },
    }
    expected: dict[tuple[str, Any], dict[str, Any]] = {}
    for model in SOURCE_MODELS:
        for row in db_session.scalars(
            select(model).where(
                model.employee_id.is_not(None), model.dormitory_id.in_([dormitory.id])
            )
        ):
            expected[(source_key(cast(Row, row)), row.id)] = previous_row_values(
                cast(Row, row), lookup
            )

    actual = {(item.table_key, item.row_id): item.values for item in sources}
    assert actual.keys() == expected.keys()
    for key, values in expected.items():
        # Порядок ключей — часть ответа: JSON отдаёт их в том же порядке.
        assert list(actual[key]) == list(values)
        assert actual[key] == values
    # Поля, которые прежняя пара «объект + значения» отдавала рядом со значениями.
    resident_record = next(item for item in sources if item.table_key == "residents")
    assert resident_record.dormitory_id == dormitory.id
    assert resident_record.employee_id == employees[0].id
    assert resident_record.row_id == db_session.scalars(select(Resident)).one().id


def test_workspace_member_ids_lists_every_card_of_the_group(
    client: TestClient, db_session: Session
) -> None:
    """Состав группы — те же `id` в том же порядке, но собран одним проходом."""
    user = sign_in(client, db_session)
    dormitory_id = create_dormitory(client)
    target = Employee(full_name="Семёнов Иван Иванович", identity_status="confirmed")
    source = Employee(full_name="Семёнов И. И.", identity_status="pending")
    db_session.add_all([target, source])
    db_session.flush()
    source.merged_into_id = target.id
    db_session.add_all(
        [
            Resident(dormitory_id=dormitory_id, employee_id=target.id, full_name="Семёнов И."),
            Resident(dormitory_id=dormitory_id, employee_id=source.id, full_name="Семёнов И. И."),
        ]
    )
    db_session.commit()

    data = workspace(db_session, user, [dormitory_id])

    [card] = [item for item in data["employees"] if item["id"] == target.id]
    assert card["member_ids"] == sorted([target.id, source.id])
    assert {source["row_id"] for source in card["sources"]} == {
        resident.id for resident in db_session.query(Resident).all()
    }
    # Карточка источника в ответ не попадает: группа отдаётся одной записью.
    assert [item["id"] for item in data["employees"]] == [target.id]


def test_workspace_reads_the_dormitory_directory_once(
    client: TestClient, db_session: Session
) -> None:
    """Справочник общежитий читается один раз: второй `SELECT` был лишним."""
    user = sign_in(client, db_session)
    dormitory_id = create_dormitory(client)
    db_session.add(Resident(dormitory_id=dormitory_id, employee_id=None, full_name="Без карточки"))
    db_session.commit()

    statements: list[str] = []

    def collect(
        _connection: Any,
        _cursor: Any,
        statement: str,
        _parameters: Any,
        _context: Any,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    engine = cast(Engine, db_session.get_bind())
    event.listen(engine, "before_cursor_execute", collect)
    try:
        workspace(db_session, user, [dormitory_id])
    finally:
        event.remove(engine, "before_cursor_execute", collect)

    loads = [statement for statement in statements if "FROM dormitories" in statement]
    assert len(loads) == 1, loads


def test_workspace_route_marks_the_settings_stage(client: TestClient, db_session: Session) -> None:
    """Настройки заездов — отдельный этап рядом с этапами сборки карточек.

    Ручка отдаёт их тем же ответом, но читают они свои таблицы: без разметки
    это время приписано сборке карточек, и по событию не видно, чей это вклад.
    """
    user = sign_in(client, db_session)
    create_dormitory(client)
    membership = db_session.scalars(
        select(OrganizationMember).where(OrganizationMember.user_id == user.id)
    ).first()
    assert membership is not None

    token = sql_diagnostics.start_request("probe")
    try:
        payload = get_workspace(user, membership, db_session)
    finally:
        request_sql = sql_diagnostics.current()
        sql_diagnostics.finish_request(token)

    assert request_sql is not None
    assert {"settings", "sources", "assemble"} <= set(request_sql.stages_ms)
    assert payload["arrival_settings"] is not None


def test_source_keys_is_the_only_registry_of_table_keys() -> None:
    """Ключ модели описан один раз, и его инвариант ловится при импорте, а не в проде.

    До ревью ключ был описан дважды — в `SOURCE_KEYS` и в цепочке `isinstance`
    внутри `source_key`, — причём запасные пути расходились: неизвестную модель
    `source_key` называла `archive`, а `all_sources` падала. Теперь оба берут
    ключ из `SOURCE_KEYS`, а вне справочника разрешена ровно одна модель — вкладка.
    """
    check_source_keys()
    with pytest.raises(RuntimeError, match="SOURCE_KEYS"):
        check_source_keys(
            {Resident: "residents", PersonnelInflow: "inflow", PersonnelOutflow: "outflow"}
        )
    assert SOURCE_KEYS[ArchiveEntry] == "archive"
    assert source_key(cast(Row, CustomTabEntry(dormitory_id=1, tab_id=7))) == "custom_7"
    # Замороженный эталон сверки (`PREVIOUS_KEYS`) обязан совпадать со справочником:
    # смена ключа модели должна падать здесь, а не проходить незамеченной в диффе
    # сверки поведения.
    assert {model: SOURCE_KEYS[model] for model in PREVIOUS_KEYS} == PREVIOUS_KEYS


def test_row_values_and_all_sources_annotate_the_row_the_same_way(
    db_session: Session,
) -> None:
    """Наложения общежития, хостела и привязки считает один помощник на оба пути.

    `all_sources` отдаёт строку в ответ ручки, `row_values` пишет её снимок в
    историю через `record_changed`, а тот сравнивает прежний снимок с новыми
    значениями. Разойдись эти пути — сравнение начнёт сравнивать разные формы.
    """
    resident, lookup = resident_with_history(db_session)
    employee = Employee(full_name="Семёнов Иван Иванович", identity_status="confirmed")
    db_session.add(employee)
    db_session.flush()
    resident.employee_id = employee.id
    db_session.flush()

    [record] = all_sources(
        db_session, [resident.dormitory_id], list(lookup["dormitories"].values())
    )

    assert record.values == row_values(db_session, resident, lookup)
    assert record.values == row_values(db_session, resident)
    assert (record.table_key, record.row_id) == ("residents", resident.id)


def test_hostel_name_belongs_to_the_only_source_with_hostel_id() -> None:
    """`annotate` узнаёт хостел по значению `hostel_id`, а не по типу строки.

    Условие `values.get("hostel_id")` заменило прежнее `isinstance(row, Resident)
    and row.hostel_id` и работает там же лишь потому, что колонка `hostel_id` есть
    только у `Resident` (`app/models/resident.py:23`). Если у следующего
    источника появится хостел, форма его строки изменится у обоих путей сразу, и
    это должно быть решением, а не побочным эффектом помощника, — поэтому
    проверка стоит здесь, а не держится на комментарии.
    """
    with_hostel = [
        model.__name__ for model in SOURCE_MODELS if "hostel_id" in source_spec(model).keys
    ]

    assert with_hostel == ["Resident"]

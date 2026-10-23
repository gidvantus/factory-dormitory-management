"""Снимок «было → стало» в колонке `changes` журнала действий.

Юнит-тесты идут на SQLite (как и остальные тесты журнала): там `audit_events` —
обычная таблица без партиций, а проверка партиционированной вставки помечена
`dbtest` и идёт на стенде.

Снимок собирают слушатели `after_flush` и `before_commit` (`app.audit`): ручки
пишут и промежуточными `flush`, поэтому снимок копится за транзакцию, а не
собирается один раз на коммите. Проверяется здесь ровно то, что обещает
постановка: что видно в записи, чего в ней быть не должно и как снимок ужимается
под предел объёма.

Строку журнала кладёт в тот же коммит, что и действие, слушатель `before_commit`,
поэтому в тесте она видна прямо в сессии теста. Запросы к ручкам идут через
`TestClient`, а для проверки предела снимка сессия коммитится напрямую —
контекст запроса ставит `commit_as_request`.
"""

from datetime import UTC, datetime
from time import perf_counter
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app import audit
from app import db as db_module
from app.models.audit import AuditEvent
from app.models.personnel import Employee
from app.models.user import User
from tests.conftest import create_user, login, organizations_for, sign_in

PAYLOAD = {"name": "Северное", "client_name": "Стройкомплект"}
# Правка проживающего требует месяц отчёта: он приходит параметром запроса.
CURRENT_MONTH = "2026-10-01"

PHONE_ONE = "+79990001122"
PHONE_TWO = "+79990009999"

# Сколько изменений просит постановка: больше предела, поэтому из них остаётся
# `DIFF_LIMIT` записей и хвост в `{"_omitted": 2}`. Один сотрудник с единственным
# заполненным полем даёт ровно одно изменение снимка.
CHANGES_IN_ONE_COMMIT = 12

# Таблицы из пункта 5 постановки: их значения — отпечатки секретов, а ключи
# `token_hash` и `identifier_hash` маскирование не знает.
SECRET_TABLES = frozenset({"activation_tokens", "recovery_requests"})

REPORT_PROBE_PATH = "/api/probe"


def events(db_session: Session) -> list[AuditEvent]:
    """Строки журнала в порядке появления."""
    db_session.expire_all()
    return list(db_session.scalars(select(AuditEvent).order_by(AuditEvent.id)))


def last_event(db_session: Session) -> AuditEvent:
    """Последняя строка журнала."""
    rows = events(db_session)
    assert rows, "в журнале нет ни одной строки"
    return rows[-1]


def changes_of(db_session: Session) -> list[dict[str, Any]]:
    """Снимок последней строки журнала."""
    return last_event(db_session).changes or []


def rows_of(changes: list[dict[str, Any]], entity: str) -> list[dict[str, Any]]:
    """Записи снимка по одной таблице: хвост `{"_omitted": N}` в них не входит."""
    return [record for record in changes if record.get("entity") == entity]


def omitted_of(changes: list[dict[str, Any]]) -> int:
    """Сколько изменений не поместилось в снимок: 0 — поместились все."""
    tail = changes[-1] if changes else {}
    return int(tail.get(audit.OMITTED_KEY, 0))


def create_dormitory(client: TestClient) -> int:
    """Завести общежитие через API и вернуть его id."""
    created = client.post("/api/dormitories", json=PAYLOAD)
    assert created.status_code == 201, created.text
    return int(created.json()["id"])


def create_resident(client: TestClient, dormitory_id: int) -> int:
    """Завести проживающего в общежитии и вернуть его id."""
    created = client.post(f"/api/dormitories/{dormitory_id}/residents")
    assert created.status_code == 201, created.text
    return int(created.json()["id"])


def update_resident(
    client: TestClient, dormitory_id: int, resident_id: int, body: dict[str, str]
) -> None:
    """Сохранить поля проживающего так, как это делает кабинет."""
    response = client.patch(
        f"/api/dormitories/{dormitory_id}/residents/{resident_id}?month={CURRENT_MONTH}",
        json=body,
    )
    assert response.status_code == 200, response.text


def commit_as_request(
    session: Session,
    *,
    method: str = "POST",
    path: str = REPORT_PROBE_PATH,
) -> None:
    """Закоммитить сессию так, как это делает запрос.

    Слушатели журнала смотрят на контекст запроса; в тесте его ставит эта обёртка
    — тем же способом, что middleware в `app/main.py`.
    """
    context = audit.AuditContext(
        request_id=str(uuid4()),
        method=method,
        scope={"path": path, "path_params": {}},
        ip="127.0.0.1",
        user_agent="pytest",
        request_body=None,
        started=perf_counter(),
        prefix="/api",
    )
    token = audit.start_context(context)
    try:
        session.commit()
    finally:
        audit.finish_context(token)


def test_update_records_old_and_new_masked_with_fingerprint(
    client: TestClient, db_session: Session
) -> None:
    """Правка поля даёт `old` и `new`, ПДн — маской и отпечатком, лишнего нет.

    Правка проживающего — главный случай постановки: в снимке должно быть ровно
    одно поле `phone` со обеими сторонами, а исходный номер не должен читаться ни
    в базе, ни в ответах.
    """
    sign_in(client, db_session)
    dormitory_id = create_dormitory(client)
    resident_id = create_resident(client, dormitory_id)

    update_resident(client, dormitory_id, resident_id, {"phone": PHONE_ONE})
    update_resident(client, dormitory_id, resident_id, {"phone": PHONE_TWO})

    changes = changes_of(db_session)
    records = rows_of(changes, "residents")
    assert len(records) == 1, changes

    record = records[0]
    assert record["op"] == "update"
    assert record["id"] == resident_id
    assert record["field"] == "phone"
    # Обе стороны — маска и отпечаток: «было → стало» видно, а номер не читается.
    assert record["old"]["_masked"] == "+7***22"
    assert record["new"]["_masked"] == "+7***99"
    assert len(record["old"]["fp"]) == audit.FINGERPRINT_LENGTH
    assert record["old"]["fp"] != record["new"]["fp"]
    # Неизменившиеся поля в снимок не попадают вовсе.
    assert {item["field"] for item in records} == {"phone"}

    stored = str(changes)
    assert PHONE_ONE not in stored
    assert PHONE_TWO not in stored


def test_organization_edit_is_visible_without_masking(
    client: TestClient, db_session: Session
) -> None:
    """Реквизиты организации видны целиком: по ним и ищут в журнале."""
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.patch(
        "/api/organization",
        json={
            "name": "ООО Ромашка",
            "inn": "7701234567",
            "address": "г. Москва, ул. Ленина, 1",
        },
    )
    assert response.status_code == 200, response.text

    records = rows_of(changes_of(db_session), "organizations")
    written = {record["field"]: record for record in records}
    assert written["name"]["new"] == "ООО Ромашка"
    assert written["inn"]["new"] == "7701234567"
    assert written["address"]["new"] == "г. Москва, ул. Ленина, 1"
    for field in ("name", "inn", "address"):
        assert written[field]["op"] == "update"
        assert written[field]["old"] is None


def test_insert_records_values_with_insert_op(client: TestClient, db_session: Session) -> None:
    """`POST` даёт `op="insert"` со значениями непустых колонок."""
    sign_in(client, db_session)
    dormitory_id = create_dormitory(client)

    records = rows_of(changes_of(db_session), "dormitories")
    written = {record["field"]: record for record in records}
    assert written["name"]["op"] == "insert"
    assert written["name"]["new"] == PAYLOAD["name"]
    assert written["name"]["old"] is None
    assert written["client_name"]["new"] == PAYLOAD["client_name"]
    # Идентификатор строки: общежитие сброшено на диск до коммита, ключ известен.
    assert written["name"]["id"] == dormitory_id
    # Пустые колонки в снимок не попадают.
    assert all(record["new"] is not None for record in records)


def test_delete_records_old_values_with_delete_op(client: TestClient, db_session: Session) -> None:
    """`DELETE` даёт `op="delete"` со старыми значениями."""
    sign_in(client, db_session)
    dormitory_id = create_dormitory(client)
    resident_id = create_resident(client, dormitory_id)
    update_resident(client, dormitory_id, resident_id, {"phone": PHONE_ONE})

    deleted = client.delete(f"/api/dormitories/{dormitory_id}/residents/{resident_id}")
    assert deleted.status_code == 204, deleted.text

    changes = changes_of(db_session)
    records = [record for record in rows_of(changes, "residents") if record["op"] == "delete"]
    assert records, changes
    written = {record["field"]: record for record in records}
    assert written["phone"]["old"]["_masked"] == "+7***22"
    assert written["phone"]["new"] is None
    assert written["id"]["old"] == resident_id
    assert PHONE_ONE not in str(changes)


def test_secrets_and_token_tables_never_reach_the_snapshot(
    client: TestClient, db_session: Session
) -> None:
    """Секреты и таблицы с отпечатками токенов в снимок не попадают.

    Регистрация и восстановление пароля заводят `activation_tokens` и
    `recovery_requests`, у которых значение — отпечаток секрета, а ключа
    (`token_hash`, `identifier_hash`) список маскирования не знает.
    """
    email = "worker@example.com"
    registered = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "full_name": "Иванов Иван Иванович",
            "consent": True,
            "terms_accepted": True,
        },
    )
    assert registered.status_code == 201, registered.text
    recovery = client.post("/api/auth/password-recovery", json={"email": email})
    assert recovery.status_code == 200, recovery.text

    changes = [record for row in events(db_session) for record in (row.changes or [])]
    assert any(record["entity"] == "users" for record in changes), changes
    assert all(record["entity"] not in SECRET_TABLES for record in changes)

    stored = str(changes)
    assert "token_hash" not in stored
    assert "identifier_hash" not in stored

    # Хеш пароля не читается ни значением, ни отпечатком.
    user = db_session.scalar(select(User).where(User.email == email))
    assert user is not None
    assert user.password_hash not in stored
    for record in changes:
        if record["field"] == "password_hash":
            assert record["new"] == audit.SECRET_MASK
            assert record["old"] is None


def test_twelve_changes_in_one_commit_are_cut_to_ten_plus_omitted(
    db_session: Session,
) -> None:
    """Больше десяти изменений в коммите: десять записей плюс `{"_omitted": N}`.

    Двенадцать сотрудников с одним заполненным полем дают ровно двенадцать
    изменений: остальные колонки пусты, а умолчания сервера и ключ появляются
    только на самом коммите — снимок собирается раньше.
    """
    for index in range(CHANGES_IN_ONE_COMMIT):
        db_session.add(Employee(personnel_number=f"Т-{index}"))

    commit_as_request(db_session)

    changes = changes_of(db_session)
    assert len(changes) == audit.DIFF_LIMIT + 1, changes
    assert changes[-1] == {audit.OMITTED_KEY: CHANGES_IN_ONE_COMMIT - audit.DIFF_LIMIT}
    # Хвост снимка не потерян: он свёрнут в одну запись.
    assert all(record["entity"] == "employees" for record in rows_of(changes, "employees"))
    assert len(rows_of(changes, "employees")) == audit.DIFF_LIMIT


def test_commit_without_changes_leaves_changes_null(
    client: TestClient, db_session: Session
) -> None:
    """Коммит без изменений: `changes = NULL`, а ручка отвечает как раньше."""
    sign_in(client, db_session)
    dormitory_id = create_dormitory(client)
    before = len(events(db_session))

    response = client.patch(f"/api/dormitories/{dormitory_id}", json={"name": PAYLOAD["name"]})

    assert response.status_code == 200, response.text
    assert response.json()["name"] == PAYLOAD["name"]
    rows = events(db_session)
    # Строка журнала остаётся: запрос write, и сам факт действия в журнале нужен.
    assert len(rows) == before + 1
    assert rows[-1].method == "PATCH"
    assert rows[-1].changes is None


def test_read_handle_that_writes_leaves_a_row(client: TestClient, db_session: Session) -> None:
    """`GET` вкладки таблицы создаёт столбцы и коммитит — строка журнала нужна.

    Прежнее правило «строка только для write-методов» теряло эти изменения
    целиком; правило расширено до «есть изменения в сессии или метод — write».
    """
    sign_in(client, db_session)
    dormitory_id = create_dormitory(client)

    response = client.get(f"/api/dormitories/{dormitory_id}/tables/residents/columns")
    assert response.status_code == 200, response.text

    row = last_event(db_session)
    assert row.method == "GET"
    assert row.path == "/api/dormitories/{dormitory_id}/tables/{table_key}/columns"
    changes = row.changes
    assert changes
    records = rows_of(changes, "table_columns")
    assert records
    assert all(record["op"] == "insert" for record in records)
    # Все записи снимка — о созданных столбцах: снимок описывает изменения запроса,
    # а не только тело, и у `GET` он тоже есть.
    assert len(records) == len(changes) - (1 if omitted_of(changes) else 0)


@pytest.mark.dbtest
def test_row_with_changes_lands_in_the_current_month_partition() -> None:
    """Строка с непустым `changes` ложится в партицию текущего месяца.

    Проверка идёт на настоящей PostgreSQL: в юнит-прогоне партиций не существует.
    """
    marker = str(uuid4())
    moment = datetime.now(UTC)
    partition = f"audit_events_{moment.year:04d}_{moment.month:02d}"
    # `SELECT` из партиционированной таблицы `audit_events` в том же тесте, что и
    # остальные проверки: строка уносится в конце, чужой журнал не трогается.
    list_place_sql = text(
        "SELECT tableoid::regclass::text FROM audit_events WHERE request_id = :marker"
    )
    delete_sql = text("DELETE FROM audit_events WHERE request_id = :marker")

    with db_module.SessionLocal() as db:
        try:
            db.add(
                AuditEvent(
                    method="POST",
                    path=REPORT_PROBE_PATH,
                    action="post_probe",
                    kind=audit.KIND_DATA,
                    request_id=marker,
                    changes=[
                        {
                            "entity": "dormitories",
                            "id": 1,
                            "op": "update",
                            "field": "name",
                            "old": "Северное",
                            "new": "Южное",
                        }
                    ],
                )
            )
            db.commit()

            placed = db.scalar(list_place_sql, {"marker": marker})
            assert placed is not None
            assert str(placed).split(".")[-1] == partition
        finally:
            db.execute(delete_sql, {"marker": marker})
            db.commit()

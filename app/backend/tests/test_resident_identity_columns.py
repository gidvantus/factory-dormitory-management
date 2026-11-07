"""Назначение столбцов формы, сохранение старых данных и защита от скрытой записи."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.personnel import Employee
from app.models.resident import Resident
from app.models.table_column import TableColumn
from app.personnel import today
from tests.conftest import sign_in
from tests.test_personnel import FIELDS, check, create
from tests.test_reports import create_dormitory
from tests.test_table_columns import add_column
from tests.test_table_exchange import filled, upload, workbook_rows


def setup_custom(client: TestClient, db: Session, *, number: bool = False) -> tuple[int, int, int]:
    dorm = create_dormitory(client)
    base = f"/api/dormitories/{dorm}/tables/residents"
    columns = client.get(base + "/columns").json()
    for column in columns:
        if column["builtin_key"] in ("full_name", "phone"):
            assert client.delete(f"{base}/columns/{column['id']}").status_code == 204
    name = add_column(client, base, "Фамилия", "text")["id"]
    phone = add_column(client, base, "Контакт", "number" if number else "text")["id"]
    db.commit()
    return dorm, name, phone


def request_record(client: TestClient, dorm: int, columns: dict[str, int]) -> dict[str, Any]:
    fields = {"full_name": "Петров Пётр", "phone": "+7 (900) 123-45-67"}
    token = check(client, fields)["check_token"]
    response = client.post(
        "/api/personnel/records",
        json={
            "dormitory_id": dorm,
            "table_key": "residents",
            "entry_columns": columns,
            "identity": {**fields, "mode": "new", "check_token": token},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_mapping_backfills_hidden_data_keeps_filled_cells_and_survives_rename(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    dorm, name, phone = setup_custom(client, db_session, number=True)
    old = Resident(dormitory_id=dorm, full_name="Сохранённое имя", phone="+79001112233")
    filled = Resident(
        dormitory_id=dorm,
        full_name="Старое имя",
        phone="+79002223344",
        custom_values={str(name): "Имя в ячейке"},
    )
    db_session.add_all([old, filled])
    db_session.commit()
    binding = f"/api/personnel/bindings/{dorm}/residents"
    catalog = client.get(binding).json()
    assert catalog["fields"] == {}
    assert all(column["builtin_key"] not in ("full_name", "phone") for column in catalog["columns"])
    assert next(column for column in catalog["columns"] if column["id"] == phone)[
        "can_convert_to_text"
    ]
    fields = {"full_name": name, "phone": phone}
    result = client.put(binding, json={"fields": fields, "convert_phone_to_text": True})
    assert result.status_code == 200, result.text
    assert db_session.get(TableColumn, phone).kind == "text"  # type: ignore[union-attr]
    assert old.custom_values == {str(name): "Сохранённое имя", str(phone): "+79001112233"}
    assert filled.custom_values[str(name)] == "Имя в ячейке"
    assert filled.full_name == "Имя в ячейке"
    assert client.get(binding).json()["fields"] == fields
    renamed = client.patch(
        f"/api/dormitories/{dorm}/tables/residents/columns/{name}",
        json={"name": "Фамилия и имя", "kind": "text"},
    )
    assert renamed.status_code == 200, renamed.text
    record = request_record(client, dorm, fields)
    row = db_session.get(Resident, record["row_id"])
    assert row is not None
    assert row.full_name == row.custom_values[str(name)] == "Петров Пётр"
    assert row.phone == row.custom_values[str(phone)] == "+7 (900) 123-45-67"
    other = create_dormitory(client, "Другое общежитие")
    assert client.get(f"/api/personnel/bindings/{other}/residents").json()["fields"] != fields
    # Правка назначенной ячейки остаётся согласована с поиском и карточкой.
    cell = client.put(
        f"/api/dormitories/{dorm}/tables/residents/rows/{row.id}/cells/{phone}",
        json={"value": "+79005556677"},
    )
    assert cell.status_code == 200, cell.text
    assert row.phone == "+79005556677"
    month = today().replace(day=1).isoformat()
    changed = client.patch(
        f"/api/dormitories/{dorm}/residents/{row.id}?month={month}", json={"full_name": "Новое имя"}
    )
    assert changed.status_code == 200, changed.text
    assert row.custom_values[str(name)] == "Новое имя"


def test_no_hidden_creation_when_builtin_or_selected_column_is_archived(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    dorm, name, phone = setup_custom(client, db_session)

    def submit() -> Any:
        return client.post(
            "/api/personnel/records",
            json={
                "dormitory_id": dorm,
                "table_key": "residents",
                "identity": {
                    **FIELDS,
                    "mode": "new",
                    "check_token": check(client, FIELDS)["check_token"],
                },
            },
        )

    assert submit().status_code == 409
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 0
    assert db_session.scalar(select(func.count()).select_from(Employee)) == 0
    binding = f"/api/personnel/bindings/{dorm}/residents"
    assert (
        client.put(binding, json={"fields": {"full_name": name, "phone": phone}}).status_code == 200
    )
    assert (
        client.delete(f"/api/dormitories/{dorm}/tables/residents/columns/{name}").status_code == 204
    )
    assert submit().status_code == 409
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 0


def test_mapping_rejects_foreign_duplicate_incompatible_and_filled_number(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    dorm, name, phone = setup_custom(client, db_session, number=True)
    other = create_dormitory(client, "Другое")
    foreign = add_column(client, f"/api/dormitories/{other}/tables/residents", "Фамилия", "text")[
        "id"
    ]
    binding = f"/api/personnel/bindings/{dorm}/residents"
    for fields in [
        {"full_name": foreign},
        {"full_name": name, "phone": name},
        {"full_name": phone},
        {"phone": phone},
    ]:
        assert client.put(binding, json={"fields": fields}).status_code == 422
    db_session.add(Resident(dormitory_id=dorm, custom_values={str(phone): "79001112233"}))
    db_session.commit()
    result = client.put(
        binding, json={"fields": {"full_name": name, "phone": phone}, "convert_phone_to_text": True}
    )
    assert result.status_code == 409
    assert db_session.get(TableColumn, phone).kind == "number"  # type: ignore[union-attr]


def test_stale_mapping_prevents_creation_and_can_be_changed(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    # Стандартные назначения работают без ручной настройки.
    original = client.get(f"/api/personnel/bindings/{dorm}/residents").json()["fields"]
    row = create(client, dorm)
    new_name = add_column(client, f"/api/dormitories/{dorm}/tables/residents", "Новое ФИО", "text")[
        "id"
    ]
    updated = {**original, "full_name": new_name}
    assert (
        client.put(
            f"/api/personnel/bindings/{dorm}/residents", json={"fields": updated}
        ).status_code
        == 200
    )
    response = client.post(
        "/api/personnel/records",
        json={
            "dormitory_id": dorm,
            "table_key": "residents",
            "entry_columns": original,
            "identity": {
                **FIELDS,
                "mode": "new",
                "check_token": check(client, FIELDS)["check_token"],
            },
        },
    )
    assert response.status_code == 409
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 1
    stored = db_session.get(Resident, row["row_id"])
    assert stored is not None
    assert stored.custom_values[str(new_name)] == FIELDS["full_name"]
    assert (
        client.put(
            f"/api/personnel/bindings/{dorm}/residents", json={"fields": original}
        ).status_code
        == 200
    )


@pytest.mark.parametrize("number", [False, True])
def test_import_uses_assigned_columns_and_rejects_previous_mapping_template(
    client: TestClient,
    db_session: Session,
    number: bool,
) -> None:
    sign_in(client, db_session)
    dorm, name, phone = setup_custom(client, db_session, number=number)
    path = f"/api/dormitories/{dorm}/data-transfer/residents"
    headers = workbook_rows(client.get(path + "/template").content)[0]
    old = filled(
        client,
        path,
        [[{"Фамилия": "Прежний шаблон", "Контакт": 79001234567}.get(header) for header in headers]],
    )
    saved = client.put(
        f"/api/personnel/bindings/{dorm}/residents",
        json={"fields": {"full_name": name, "phone": phone}, "convert_phone_to_text": number},
    )
    assert saved.status_code == 200, saved.text
    content = filled(
        client,
        path,
        [
            [
                {"Фамилия": "Импортированный сотрудник", "Контакт": "+7 (900) 123-45-67"}.get(
                    header
                )
                for header in headers
            ]
        ],
    )
    response = upload(client, path, content)
    assert response.status_code == 200, response.text
    row = db_session.scalar(select(Resident).where(Resident.dormitory_id == dorm))
    assert row is not None
    assert row.full_name == row.custom_values[str(name)] == "Импортированный сотрудник"
    assert row.phone == row.custom_values[str(phone)] == "+7 (900) 123-45-67"
    employee = db_session.get(Employee, row.employee_id)
    assert (
        employee is not None and employee.full_name == row.full_name and employee.phone == row.phone
    )
    rejected = upload(client, path, old)
    assert rejected.status_code == 422
    assert "актуальный шаблон" in rejected.text
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 1


def test_import_validates_assigned_phone_atomically(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm, name, phone = setup_custom(client, db_session)
    assert (
        client.put(
            f"/api/personnel/bindings/{dorm}/residents",
            json={"fields": {"full_name": name, "phone": phone}},
        ).status_code
        == 200
    )
    path = f"/api/dormitories/{dorm}/data-transfer/residents"
    headers = workbook_rows(client.get(path + "/template").content)[0]
    values = [
        {"Фамилия": "Верная строка", "Контакт": "+79001234567"},
        {"Фамилия": "Неверная строка", "Контакт": "некорректный номер"},
    ]
    content = filled(client, path, [[row.get(header) for header in headers] for row in values])
    response = upload(client, path, content)
    assert response.status_code == 422
    assert "Контакт" in response.text
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 0
    assert db_session.scalar(select(func.count()).select_from(Employee)) == 0


def test_default_assignment_keeps_existing_excel_template_compatible(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    path = f"/api/dormitories/{dorm}/data-transfer/residents"
    headers = workbook_rows(client.get(path + "/template").content)[0]
    content = filled(
        client,
        path,
        [
            [
                {"ФИО": "Стандартная запись", "Номер телефона": "+79001234567"}.get(header)
                for header in headers
            ]
        ],
    )
    binding = f"/api/personnel/bindings/{dorm}/residents"
    defaults = client.get(binding).json()["fields"]
    assert client.put(binding, json={"fields": defaults}).status_code == 200
    response = upload(client, path, content)
    assert response.status_code == 200, response.text


def test_import_copies_builtin_into_assigned_empty_column_and_rejects_conflicting_values(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    base = f"/api/dormitories/{dorm}/tables/residents"
    columns = client.get(base + "/columns").json()
    phone = next(column["id"] for column in columns if column["builtin_key"] == "phone")
    name = add_column(client, base, "Фамилия", "text")["id"]
    assert (
        client.put(
            f"/api/personnel/bindings/{dorm}/residents",
            json={"fields": {"full_name": name, "phone": phone}},
        ).status_code
        == 200
    )
    path = f"/api/dormitories/{dorm}/data-transfer/residents"
    headers = workbook_rows(client.get(path + "/template").content)[0]
    content = filled(
        client,
        path,
        [[{"ФИО": "Импорт", "Номер телефона": "+79001234567"}.get(header) for header in headers]],
    )
    assert upload(client, path, content).status_code == 200
    row = db_session.scalar(select(Resident).where(Resident.dormitory_id == dorm))
    assert row is not None and row.custom_values[str(name)] == row.full_name == "Импорт"
    conflict = filled(
        client,
        path,
        [[{"ФИО": "Одно имя", "Фамилия": "Другое имя"}.get(header) for header in headers]],
    )
    response = upload(client, path, conflict)
    assert response.status_code == 422
    assert "разные значения" in response.text
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 1

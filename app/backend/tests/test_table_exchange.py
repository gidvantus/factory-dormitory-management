"""Настоящие .xlsx и API: актуальность схемы, атомарность и изоляция организации."""

from collections.abc import Callable
from datetime import date
from io import BytesIO
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from openpyxl.worksheet.worksheet import Worksheet
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import table_exchange
from app.models.audit import AuditEvent
from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.hostel import Hostel
from app.models.report import ReportCell
from app.models.table_import_job import TableImportJob
from app.table_import_queue import run_next_import
from tests.conftest import sign_in
from tests.test_reports import create_dormitory


def setup(client: TestClient, db: Session, **options: Any) -> tuple[int, dict[str, Any], str]:
    sign_in(client, db)
    dorm = create_dormitory(client)
    tab = client.post(
        f"/api/dormitories/{dorm}/tabs", json={"name": "Отпуск", "options": options}
    ).json()
    if not tab["table_created"]:
        response = client.post(
            f"/api/dormitories/{dorm}/tabs/{tab['id']}/table",
            json={
                "columns": [
                    {"name": "ФИО", "kind": "text"},
                    {"name": "Дата отпуска", "kind": "date"},
                ]
            },
        )
        assert response.status_code == 201, response.text
        tab = response.json()
    return dorm, tab, f"/api/dormitories/{dorm}/data-transfer/{tab['table_key']}"


def edit_file(content: bytes, edit: Callable[[Worksheet], None]) -> bytes:
    workbook = load_workbook(BytesIO(content))
    edit(workbook["Данные"])
    stream = BytesIO()
    workbook.save(stream)
    workbook.close()
    return stream.getvalue()


def filled(client: TestClient, path: str, rows: list[list[Any]], query: str = "") -> bytes:
    response = client.get(path + "/template" + query)
    assert response.status_code == 200, response.text

    def fill(sheet: Worksheet) -> None:
        for row_index, values in enumerate(rows, 2):
            for col_index, value in enumerate(values, 1):
                sheet.cell(row_index, col_index, value)

    return edit_file(response.content, fill)


def upload(client: TestClient, path: str, content: bytes, query: str = "") -> Any:
    return client.post(
        path + "/import" + query,
        files={
            "file": (
                "Отпуск.xlsx",
                content,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )


def workbook_rows(content: bytes) -> list[list[Any]]:
    workbook = load_workbook(BytesIO(content), data_only=False)
    result = [list(row) for row in workbook["Данные"].iter_rows(values_only=True)]
    workbook.close()
    return result


def test_import_job_reuses_key_before_and_after_commit(
    client: TestClient, db_session: Session
) -> None:
    _dorm, tab, path = setup(client, db_session)
    content = filled(client, path, [["Первый", "2026-11-03"], ["Второй", None]])
    job_id = uuid4()

    def enqueue(data: bytes) -> Any:
        return client.post(
            path + "/import/jobs",
            headers={"Idempotency-Key": str(job_id)},
            files={"file": ("Отпуск.xlsx", data)},
        )

    queued = enqueue(content)
    assert queued.status_code == 202, queued.text
    assert queued.json()["status"] == "pending"
    assert queued.json()["progress"] is None
    assert enqueue(content).json() == queued.json()
    assert enqueue(content + b"other").status_code == 409
    entries = (
        select(func.count()).select_from(CustomTabEntry).where(CustomTabEntry.tab_id == tab["id"])
    )
    assert db_session.scalar(entries) == 0
    assert run_next_import()
    assert not run_next_import()
    result = client.get(path + f"/import/jobs/{job_id}").json()
    assert result == {
        "id": str(job_id),
        "status": "completed",
        "rows_added": 2,
        "cells_added": 0,
        "detail": None,
        "progress": {"rows_processed": 2, "rows_total": 2},
        "cancel_requested": False,
    }
    assert enqueue(content).json() == result
    assert client.post(path + f"/import/jobs/{job_id}/cancel").json() == result
    assert db_session.scalar(entries) == 2
    job = db_session.get(TableImportJob, job_id, populate_existing=True)
    assert job and job.content is None


def test_import_job_failure_rolls_back_rows(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _dorm, _tab, path = setup(client, db_session)
    content = filled(client, path, [["Первый", None], ["Второй", None]])
    job_id = uuid4()
    calls = 0
    original = table_exchange.record_changed

    def fail_second(*args: Any, **kwargs: Any) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("Проверка отката")
        original(*args, **kwargs)

    monkeypatch.setattr(table_exchange, "record_changed", fail_second)
    assert (
        client.post(
            path + "/import/jobs",
            headers={"Idempotency-Key": str(job_id)},
            files={"file": ("Отпуск.xlsx", content)},
        ).status_code
        == 202
    )
    assert run_next_import()
    result = client.get(path + f"/import/jobs/{job_id}").json()
    assert result["status"] == "failed"
    assert result["progress"] is None
    assert db_session.scalar(select(func.count()).select_from(CustomTabEntry)) == 0


def test_cancel_queued_import_keeps_table_empty(client: TestClient, db_session: Session) -> None:
    _dorm, _tab, path = setup(client, db_session)
    content = filled(client, path, [["Первый", None]])
    job_id = uuid4()
    assert (
        client.post(
            path + "/import/jobs",
            headers={"Idempotency-Key": str(job_id)},
            files={"file": ("Отпуск.xlsx", content)},
        ).status_code
        == 202
    )
    url = path + f"/import/jobs/{job_id}"
    cancelled = client.post(url + "/cancel")
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"
    event = db_session.scalar(
        select(AuditEvent).where(AuditEvent.path.endswith("/jobs/{job_id}/cancel"))
    )
    assert event is not None and isinstance(event.path_params, dict)
    assert event.path_params["job_id"] == str(job_id)
    assert client.post(url + "/cancel").json() == cancelled.json()
    assert client.get(url).json() == cancelled.json()
    assert not run_next_import()
    assert db_session.scalar(select(func.count()).select_from(CustomTabEntry)) == 0
    job = db_session.get(TableImportJob, job_id, populate_existing=True)
    assert job and job.content is None


def test_import_adds_rows_persists_dates_and_export_contains_all_data(
    client: TestClient, db_session: Session
) -> None:
    dorm, tab, path = setup(client, db_session)
    original = filled(client, path, [["Иванов", "2026-11-03"]])
    assert upload(client, path, original).json() == {"rows_added": 1, "cells_added": 0}
    second = filled(
        client, path, [["Петров", "04.11.2026"], [None, None], ["Сидоров", date(2026, 11, 5)]]
    )
    assert upload(client, path, second).json()["rows_added"] == 2
    loaded = client.get(f"/api/dormitories/{dorm}/tabs/{tab['id']}/rows").json()
    assert len(loaded) == 3
    exported = client.get(path + "/export?from=2026-01-01&to=2026-01-31")
    assert exported.status_code == 200
    assert workbook_rows(exported.content) == [
        ["ФИО", "Дата отпуска"],
        ["Иванов", "2026-11-03"],
        ["Петров", "2026-11-04"],
        ["Сидоров", "2026-11-05"],
    ]
    assert "no-store" in exported.headers["cache-control"]


@pytest.mark.parametrize("change", ["add", "rename", "archive", "replace"])
def test_schema_changes_reject_old_template_and_generate_new_headers(
    client: TestClient, db_session: Session, change: str
) -> None:
    dorm, tab, path = setup(client, db_session)
    content = filled(client, path, [["Иванов", "2026-11-03"]])
    columns_path = f"/api/dormitories/{dorm}/tables/{tab['table_key']}/columns"
    columns = client.get(columns_path).json()
    if change == "add":
        response = client.post(columns_path, json={"name": "Дата выхода", "kind": "date"})
        expected = ["ФИО", "Дата отпуска", "Дата выхода"]
    elif change == "rename":
        response = client.patch(
            f"{columns_path}/{columns[1]['id']}", json={"name": "Начало отпуска", "kind": "date"}
        )
        expected = ["ФИО", "Начало отпуска"]
    else:
        response = client.delete(f"{columns_path}/{columns[1]['id']}")
        expected = ["ФИО"]
        if change == "replace":
            response = client.post(columns_path, json={"name": "Дата отпуска", "kind": "date"})
            expected = ["ФИО", "Дата отпуска"]
    assert response.status_code in {200, 201, 204}, response.text
    rejected = upload(client, path, content)
    assert rejected.status_code == 422 and "строго по шаблону" in rejected.text
    assert db_session.scalar(select(func.count()).select_from(CustomTabEntry)) == 0
    fresh = client.get(path + "/template")
    assert workbook_rows(fresh.content)[0] == expected


@pytest.mark.parametrize(
    "bad",
    [
        "header",
        "order",
        "extra_column",
        "missing_column",
        "formula",
        "date",
        "extra_sheet",
        "missing_meta",
        "not_xlsx",
    ],
)
def test_invalid_file_is_rejected_without_partial_rows(
    client: TestClient, db_session: Session, bad: str
) -> None:
    _dorm, _tab, path = setup(client, db_session)
    content = filled(
        client, path, [["Правильная строка", "2026-11-03"], ["Вторая строка", "2026-11-04"]]
    )

    def corrupt(sheet: Worksheet) -> None:
        if bad == "header":
            sheet["A1"] = "Другое поле"
        elif bad == "order":
            sheet["A1"], sheet["B1"] = "Дата отпуска", "ФИО"
        elif bad == "extra_column":
            sheet["C1"] = "Лишнее"
        elif bad == "missing_column":
            sheet.delete_cols(2)
        elif bad == "formula":
            sheet["A3"] = '=HYPERLINK("https://example.com")'
        elif bad == "date":
            sheet["B3"] = "31.02.2026"
        elif bad == "extra_sheet":
            assert sheet.parent is not None
            sheet.parent.create_sheet("Ещё лист")
        elif bad == "missing_meta":
            assert sheet.parent is not None
            del sheet.parent["_Схема"]

    content = b"not an Excel file" if bad == "not_xlsx" else edit_file(content, corrupt)
    response = upload(client, path, content)
    assert response.status_code == 422, response.text
    assert "строго по шаблону" in response.text
    if bad == "date":
        assert (
            "Строка 3" in response.json()["detail"] and "Дата отпуска" in response.json()["detail"]
        )
    assert db_session.scalar(select(func.count()).select_from(CustomTabEntry)) == 0


def test_all_scalar_types_and_dropdown_labels(client: TestClient, db_session: Session) -> None:
    dorm, tab, path = setup(client, db_session)
    columns_path = f"/api/dormitories/{dorm}/tables/{tab['table_key']}/columns"
    for definition in [
        {"name": "Сумма", "kind": "number"},
        {"name": "Согласовано", "kind": "checkbox"},
        {
            "name": "Статус",
            "kind": "select",
            "options": [{"label": "Ожидается"}, {"label": "Готово"}],
        },
    ]:
        response = client.post(columns_path, json=definition)
        assert response.status_code == 201, response.text
    content = filled(client, path, [["Иванов", "2026-11-03", "12,50", "Нет", "Готово"]])
    response = upload(client, path, content)
    assert response.status_code == 200, response.text
    columns = [col for col in client.get(columns_path).json() if col["kind"] != "action"]
    row = db_session.scalar(select(CustomTabEntry))
    assert row is not None
    values = row.custom_values
    assert values[str(columns[2]["id"])] == "12.5"
    assert values[str(columns[3]["id"])] is False
    assert values[str(columns[4]["id"])] == columns[4]["options"][1]["id"]
    assert workbook_rows(client.get(path + "/export").content)[1][-2:] == ["Нет", "Готово"]
    for invalid in [
        ["Иванов", None, "не число", None, None],
        ["Иванов", None, None, "может быть", None],
        ["Иванов", None, None, None, "Другой"],
    ]:
        assert upload(client, path, filled(client, path, [invalid])).status_code == 422
    assert db_session.scalar(select(func.count()).select_from(CustomTabEntry)) == 1


@pytest.mark.parametrize(
    "key", ["residents", "inflow", "outflow", "advance", "settlement", "archive"]
)
def test_standard_tables_support_template_import_export(
    client: TestClient, db_session: Session, key: str
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    path = f"/api/dormitories/{dorm}/data-transfer/{key}"
    template = client.get(path + "/template")
    assert template.status_code == 200, template.text
    headers = workbook_rows(template.content)[0]
    values = [
        "Иванов" if header == "ФИО" else "123" if header == "Т/н" else None for header in headers
    ]
    imported = upload(client, path, filled(client, path, [values]))
    assert imported.status_code == 200 and imported.json()["rows_added"] == 1, imported.text
    assert workbook_rows(client.get(path + "/export").content)[1][headers.index("ФИО")] == "Иванов"


def test_flags_block_api_templates_copy_flags_and_hidden_tabs_export_only(
    client: TestClient, db_session: Session
) -> None:
    dorm, tab, path = setup(client, db_session, import_enabled=False, export_enabled=False)
    assert client.get(path + "/template").status_code == 409
    assert client.get(path + "/export").status_code == 409
    snapshot = client.get(f"/api/dormitories/{dorm}/settings").json()
    saved = client.put(
        f"/api/dormitories/{dorm}/settings",
        json={
            "revision": snapshot["revision"],
            "exchange_options": {"residents": {"import_enabled": False, "export_enabled": False}},
        },
    )
    assert saved.status_code == 200, saved.text
    for action in ("template", "export"):
        assert (
            client.get(f"/api/dormitories/{dorm}/data-transfer/residents/{action}").status_code
            == 409
        )
    snapshot = saved.json()
    saved = client.put(
        f"/api/dormitories/{dorm}/settings",
        json={
            "revision": snapshot["revision"],
            "tabs": [
                {
                    "key": tab["table_key"],
                    "name": tab["name"],
                    "is_active": False,
                    "options": {**tab["options"], "export_enabled": True},
                }
            ],
        },
    )
    assert saved.status_code == 200, saved.text
    assert client.get(path + "/template").status_code == 409
    assert client.get(path + "/export").status_code == 200
    template = client.post(
        "/api/dormitory-templates", json={"dormitory_id": dorm, "name": "С обменом"}
    ).json()
    copy = client.post(
        "/api/dormitories",
        json={"name": "Копия", "client_name": "Клиент", "structure_template_id": template["id"]},
    ).json()
    assert copy["exchange_options"]["residents"] == {
        "import_enabled": False,
        "export_enabled": False,
    }
    copied_tabs = client.get(f"/api/dormitories/{copy['id']}/tabs").json()
    assert copied_tabs[0]["options"]["import_enabled"] is False


def test_foreign_and_other_tab_templates_are_rejected(
    client: TestClient, db_session: Session
) -> None:
    dorm, _tab, path = setup(client, db_session)
    content = filled(client, path, [["Иванов", "2026-11-03"]])
    other = client.post(f"/api/dormitories/{dorm}/tabs", json={"name": "Другая"}).json()
    client.post(
        f"/api/dormitories/{dorm}/tabs/{other['id']}/table",
        json={
            "columns": [{"name": "ФИО", "kind": "text"}, {"name": "Дата отпуска", "kind": "date"}]
        },
    )
    assert (
        upload(
            client, f"/api/dormitories/{dorm}/data-transfer/{other['table_key']}", content
        ).status_code
        == 422
    )
    sign_in(client, db_session, email="foreign-exchange@example.com")
    assert client.get(path + "/template").status_code == 404
    assert client.get(path + "/export").status_code == 404
    assert upload(client, path, content).status_code == 404


def test_calendar_rows_preserve_manual_values_and_days(
    client: TestClient, db_session: Session
) -> None:
    _dorm, _tab, path = setup(client, db_session, table_format="calendar", period_mode="month")
    query = "?from=2026-11-01&to=2026-11-03"
    content = filled(client, path, [["Бригада", "0", "12", "Текст"]], query)
    response = upload(client, path, content, query)
    assert response.status_code == 200, response.text
    row = db_session.scalar(select(CustomTabEntry))
    assert row is not None
    assert row.calendar_values == {
        "2026-11-01": "0",
        "2026-11-02": "12",
        "2026-11-03": "Текст",
    }
    assert workbook_rows(client.get(path + "/export" + query).content)[1] == [
        "Бригада",
        "0",
        "12",
        "Текст",
    ]
    assert upload(client, path, content, "?from=2026-12-01&to=2026-12-03").status_code == 422


@pytest.mark.parametrize("key", ["report", "places"])
def test_grids_import_empty_cells_and_reject_overwrite(
    client: TestClient, db_session: Session, key: str
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    if key == "report":
        client.post(f"/api/dormitories/{dorm}/report/rows", json={"name": "Ручной показатель"})
    else:
        db_session.add(Hostel(dormitory_id=dorm, name="Хостел", active_from_month=date(2026, 1, 1)))
        db_session.commit()
    path = f"/api/dormitories/{dorm}/data-transfer/{key}"
    query = "?from=2026-11-01&to=2026-11-02"
    template = client.get(path + "/template" + query)
    assert template.status_code == 200, template.text

    def fill(sheet: Worksheet) -> None:
        index = (
            next(
                index
                for index in range(2, sheet.max_row + 1)
                if sheet.cell(index, 1).value == "Ручной показатель"
            )
            if key == "report"
            else 2
        )
        sheet.cell(index, 2 if key == "report" else 3, 7)

    content = edit_file(template.content, fill)
    response = upload(client, path, content, query)
    assert response.status_code == 200 and response.json()["cells_added"] == 1, response.text
    assert upload(client, path, content, query).status_code == 422
    exported = workbook_rows(client.get(path + "/export" + query).content)
    assert any("7" in [str(value) for value in row] for row in exported[1:])
    if key == "report":
        assert db_session.scalar(select(func.count()).select_from(ReportCell)) == 1


def test_export_does_not_turn_user_text_into_excel_formula(
    client: TestClient, db_session: Session
) -> None:
    _dorm, _tab, path = setup(client, db_session)
    content = filled(client, path, [["Иванов", None]])
    assert upload(client, path, content).status_code == 200
    row = db_session.scalar(select(CustomTabEntry))
    assert row
    row.custom_values = {
        key: "=1+1" if value == "Иванов" else value for key, value in row.custom_values.items()
    }
    db_session.commit()
    workbook = load_workbook(BytesIO(client.get(path + "/export").content))
    assert workbook["Данные"]["A2"].value == "=1+1"
    assert workbook["Данные"]["A2"].data_type == "s"
    workbook.close()


def test_transaction_failure_rolls_back_all_rows(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _dorm, _tab, path = setup(client, db_session)
    content = filled(client, path, [["Первый", None], ["Второй", None]])
    calls = 0
    original = table_exchange.record_changed

    def fail_second(*args: Any, **kwargs: Any) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("Проверка отката")
        original(*args, **kwargs)

    monkeypatch.setattr(table_exchange, "record_changed", fail_second)
    with pytest.raises(RuntimeError, match="Проверка отката"):
        upload(client, path, content)
    assert db_session.scalar(select(func.count()).select_from(CustomTabEntry)) == 0


def test_linked_pick_preserves_zero_and_populates_copy(
    client: TestClient, db_session: Session
) -> None:
    dorm, source, path = setup(client, db_session)
    columns_path = f"/api/dormitories/{dorm}/tables/{source['table_key']}/columns"
    amount = client.post(columns_path, json={"name": "Сумма", "kind": "number"}).json()
    assert upload(client, path, filled(client, path, [["0", "2026-11-03", 0]])).status_code == 200
    source_columns = client.get(columns_path).json()
    target = client.post(f"/api/dormitories/{dorm}/tabs", json={"name": "Связанные"}).json()
    response = client.post(
        f"/api/dormitories/{dorm}/tabs/{target['id']}/table",
        json={
            "columns": [
                {
                    "name": "Выбор записи",
                    "kind": "text",
                    "client_id": -1,
                    "fill": {
                        "mode": "pick",
                        "source": source["table_key"],
                        "field": str(source_columns[0]["id"]),
                    },
                },
                {
                    "name": "Сумма из источника",
                    "kind": "number",
                    "fill": {
                        "mode": "lookup",
                        "source": source["table_key"],
                        "field": str(amount["id"]),
                        "match_column_id": -1,
                        "update": "copy",
                    },
                },
            ]
        },
    )
    assert response.status_code == 201, response.text
    target_path = f"/api/dormitories/{dorm}/data-transfer/{target['table_key']}"
    response = upload(client, target_path, filled(client, target_path, [[0, None]]))
    assert response.status_code == 200, response.text
    exported = workbook_rows(client.get(target_path + "/export").content)
    assert exported[1] == ["0", "0"]
    response = upload(
        client, target_path, filled(client, target_path, [[0, "Попытка подменить связь"]])
    )
    assert response.status_code == 422 and "автоматически" in response.text


def test_history_exports_full_rows_and_export_flag_is_editable(
    client: TestClient, db_session: Session
) -> None:
    dorm, _source, path = setup(client, db_session)
    archive = client.post(
        f"/api/dormitories/{dorm}/tabs", json={"name": "История", "kind": "archive"}
    ).json()
    assert upload(client, path, filled(client, path, [["Иванов", None]])).status_code == 200
    history_path = f"/api/dormitories/{dorm}/data-transfer/{archive['table_key']}"
    assert client.get(history_path + "/template").status_code == 409
    exported = client.get(history_path + "/export")
    assert exported.status_code == 200, exported.text
    rows = workbook_rows(exported.content)
    assert rows[0] == ["Дата", "Действие", "Автор"] and len(rows) > 1
    # Архив, созданный до появления двух новых полей JSON, сохраняет режим чтения.
    stored = db_session.get(CustomTab, archive["id"])
    assert stored is not None
    stored.options = {
        key: value
        for key, value in stored.options.items()
        if key not in {"import_enabled", "export_enabled"}
    }
    db_session.commit()
    snapshot = client.get(f"/api/dormitories/{dorm}/settings").json()
    current_archive = next(tab for tab in snapshot["tabs"] if tab["id"] == archive["id"])
    assert current_archive["options"]["import_enabled"] is False
    old_options = {
        key: value
        for key, value in current_archive["options"].items()
        if key not in {"import_enabled", "export_enabled"}
    }
    legacy_saved = client.put(
        f"/api/dormitories/{dorm}/settings",
        json={
            "revision": snapshot["revision"],
            "tabs": [
                {"key": archive["table_key"], "name": archive["name"], "options": old_options}
            ],
        },
    )
    assert legacy_saved.status_code == 200, legacy_saved.text
    snapshot = legacy_saved.json()
    response = client.put(
        f"/api/dormitories/{dorm}/settings",
        json={
            "revision": snapshot["revision"],
            "tabs": [
                {
                    "key": archive["table_key"],
                    "name": archive["name"],
                    "options": {**current_archive["options"], "export_enabled": False},
                }
            ],
        },
    )
    assert response.status_code == 200, response.text
    assert client.get(history_path + "/export").status_code == 409

"""Раздача файлов `GET /uploads/{key}`: коды, заголовки и контракт с клиентом.

Здесь проверяется то, что видит браузер и тестировщик: аноним получает `404`
(существование файла не подтверждается), участник чужой организации — `403`,
участник организации-владельца — те самые байты с защитными заголовками. Ключ с
обходом каталогов и отсутствующий объект дают тот же `404`, что и аноним, —
различать «нет файла» и «нет прав» нельзя, иначе по коду ответа видно, что файл
с таким ключом существует.

Ключ берётся из задания импорта (`import_jobs.file_key`), а не из реестра
загрузок: право даёт принадлежность данных организации, см. `app/file_access.py`.
"""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.main import app
from app.models.import_job import IMPORT_STATUS_READY, IMPORT_TABLE_PLACES, ImportJob
from app.storage import LocalStorage
from tests.conftest import sign_in

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
KEY = "2026-10-29/abc123.xlsx"
MISSING_KEY = "2026-10-29/vanished.xlsx"
PAYLOAD = b"PK\x03\x04 payload of the imported workbook"
NOT_FOUND_DETAIL = "Файл не найден"
FORBIDDEN_DETAIL = "Нет доступа к файлу"


def create_dormitory(client: TestClient) -> int:
    response = client.post("/api/dormitories", json={"name": "Северное", "client_name": "Клиент"})
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def store_import(db_session: Session, dormitory_id: int, key: str) -> ImportJob:
    job = ImportJob(
        dormitory_id=dormitory_id,
        table_key=IMPORT_TABLE_PLACES,
        status=IMPORT_STATUS_READY,
        filename="mesta.xlsx",
        size_bytes=len(PAYLOAD),
        file_key=key,
        result={},
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


def prepare(client: TestClient, db_session: Session, storage: LocalStorage) -> tuple[int, str]:
    """Вошедший владелец, его общежитие, задание импорта и файл в хранилище."""
    sign_in(client, db_session, email="owner@example.com")
    dormitory_id = create_dormitory(client)
    store_import(db_session, dormitory_id, KEY)
    storage.put_raw(PAYLOAD, KEY)
    return dormitory_id, f"/uploads/{KEY}"


def test_the_owner_downloads_exactly_the_stored_bytes(
    client: TestClient, db_session: Session, upload_storage: LocalStorage
) -> None:
    _dormitory_id, url = prepare(client, db_session, upload_storage)

    response = client.get(url)

    assert response.status_code == 200, response.text
    assert response.content == PAYLOAD
    # Расширение задаёт тип: браузер не должен угадывать содержимое.
    assert response.headers["content-type"].startswith(XLSX_MIME)
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert response.headers["cache-control"] == "private, no-store"
    # Скачивание открывает файл, а не навязывает имя: `Content-Disposition` нет.
    assert "content-disposition" not in response.headers


def test_anonymous_gets_404_even_when_the_file_exists(
    client: TestClient, db_session: Session, upload_storage: LocalStorage
) -> None:
    """Само существование файла анониму не подтверждается."""
    dormitory_id, url = prepare(client, db_session, upload_storage)
    client.cookies.clear()

    response = client.get(url)

    assert response.status_code == 404
    assert response.json() == {"detail": NOT_FOUND_DETAIL}
    assert dormitory_id > 0


def test_a_user_of_another_organization_gets_403(
    client: TestClient, db_session: Session, upload_storage: LocalStorage
) -> None:
    _dormitory_id, url = prepare(client, db_session, upload_storage)
    # Второй вход — уже другим пользователем со своей организацией.
    sign_in(client, db_session, email="stranger@example.com")

    response = client.get(url)

    assert response.status_code == 403
    assert response.json() == {"detail": FORBIDDEN_DETAIL}


def test_an_empty_key_is_the_same_404(
    client: TestClient, db_session: Session, upload_storage: LocalStorage
) -> None:
    prepare(client, db_session, upload_storage)

    response = client.get("/uploads/")

    assert response.status_code == 404
    assert response.json() == {"detail": NOT_FOUND_DETAIL}


def test_a_traversal_key_is_the_same_404(
    client: TestClient, db_session: Session, upload_storage: LocalStorage
) -> None:
    prepare(client, db_session, upload_storage)

    # Кодированная точка не даёт клиенту «исправить» путь за нас.
    response = client.get("/uploads/2026-10-29/..%2F..%2Fsecret.xlsx")

    assert response.status_code == 404
    assert response.json() == {"detail": NOT_FOUND_DETAIL}


def test_a_registered_key_without_an_object_is_the_same_404(
    client: TestClient, db_session: Session, upload_storage: LocalStorage
) -> None:
    """Ключ есть в задании импорта, объекта в хранилище нет — файла нет."""
    sign_in(client, db_session, email="owner@example.com")
    dormitory_id = create_dormitory(client)
    store_import(db_session, dormitory_id, MISSING_KEY)

    response = client.get(f"/uploads/{MISSING_KEY}")

    assert response.status_code == 404
    assert response.json() == {"detail": NOT_FOUND_DETAIL}


def test_the_route_is_published_in_the_public_schema() -> None:
    """Маршрут — часть контракта: клиент читает его из OpenAPI, а не из памяти."""
    schema = app.openapi()

    assert "/uploads/{key}" in schema["paths"]
    responses = schema["paths"]["/uploads/{key}"]["get"]["responses"]
    assert {"200", "403", "404"} <= set(responses)

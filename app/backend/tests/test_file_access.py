"""Правила доступа к файлам: закрыто по умолчанию и открыто своей организации.

Правило в CRM одно: файл читает участник организации, которой принадлежит
общежитие задания импорта с этим `file_key`. Реестр `uploaded_file` — учёт, а не
право, поэтому загрузивший файл сотрудник не получает исключительного доступа, а
коллега по организации не получает отказа.

Тесты идут на SQLite в памяти: правило — это запрос по связям, DDL ему не нужен.
"""

import pytest
from sqlalchemy.orm import Session

from app.file_access import (
    can_read,
    content_type_for,
    normalize_key,
    public_url,
    register_upload,
    stored_path,
)
from app.models.dormitory import Dormitory
from app.models.import_job import IMPORT_STATUS_READY, IMPORT_TABLE_PLACES, ImportJob
from app.models.organization import OrganizationMember
from app.models.uploaded_file import UploadedFile
from app.models.user import User
from tests.conftest import create_user, organizations_for

KEY = "2026-10-29/abc123.xlsx"
OTHER_KEY = "2026-10-29/other.xlsx"


def user_with_dormitory(
    db_session: Session, email: str = "owner@example.com"
) -> tuple[User, Dormitory]:
    """Пользователь со своей организацией и одним общежитием в ней."""
    user = create_user(db_session, email=email)
    organization, _member = organizations_for(db_session, user)
    dormitory = Dormitory(
        organization_id=organization.id,
        name="Северное",
        client_name="Клиент",
        created_by_id=user.id,
    )
    db_session.add(dormitory)
    db_session.commit()
    db_session.refresh(dormitory)
    return user, dormitory


def store_import(db_session: Session, dormitory: Dormitory, key: str) -> ImportJob:
    """Задание импорта, ссылающееся на файл в хранилище."""
    job = ImportJob(
        dormitory_id=dormitory.id,
        table_key=IMPORT_TABLE_PLACES,
        status=IMPORT_STATUS_READY,
        filename="mesta.xlsx",
        size_bytes=10,
        file_key=key,
        result={},
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (KEY, KEY),
        (f"/{KEY}", KEY),
        (stored_path(KEY), KEY),
        (f"/{stored_path(KEY)}", KEY),
    ],
)
def test_normalize_key_accepts_every_form_of_the_stored_path(raw: str, expected: str) -> None:
    assert normalize_key(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [None, "", "/", "uploads/", "../2026-10-29/a.xlsx", "2026-10-29/../../a.xlsx", "a/./b.xlsx"],
)
def test_normalize_key_rejects_empty_and_traversal(raw: str | None) -> None:
    assert normalize_key(raw) is None


def test_stored_path_is_the_public_address() -> None:
    assert stored_path(KEY) == f"uploads/{KEY}"


def test_public_url_is_rooted_at_the_site() -> None:
    """`file_url` — готовый `href`: клиент не собирает его из ключа."""
    assert public_url(KEY) == f"/uploads/{KEY}"


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        (KEY, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        ("2026-10-29/act.pdf", "application/pdf"),
        ("2026-10-29/unknown.bin", "application/octet-stream"),
    ],
)
def test_content_type_is_taken_from_the_extension(key: str, expected: str) -> None:
    """`.xlsx` знает только наша таблица: `/etc/mime.types` в slim-образе нет."""
    assert content_type_for(key) == expected


def test_the_owning_organization_reads_its_import_file(db_session: Session) -> None:
    user, dormitory = user_with_dormitory(db_session)
    store_import(db_session, dormitory, KEY)

    assert can_read(db_session, KEY, user) is True


def test_a_member_of_the_owning_organization_reads_the_file(db_session: Session) -> None:
    """Право даёт принадлежность данных, а не факт загрузки: коллеге файл открыт."""
    _owner, dormitory = user_with_dormitory(db_session)
    organization_id = dormitory.organization_id
    colleague = create_user(db_session, email="colleague@example.com")
    db_session.add(
        OrganizationMember(organization_id=organization_id, user_id=colleague.id, role="admin")
    )
    colleague.active_organization_id = organization_id
    db_session.commit()
    store_import(db_session, dormitory, KEY)

    assert can_read(db_session, KEY, colleague) is True


def test_a_member_of_another_organization_cannot_read(db_session: Session) -> None:
    _owner, dormitory = user_with_dormitory(db_session)
    stranger = create_user(db_session, email="stranger@example.com")
    organizations_for(db_session, stranger)
    store_import(db_session, dormitory, KEY)

    assert can_read(db_session, KEY, stranger) is False


def test_anonymous_cannot_read_anything(db_session: Session) -> None:
    _owner, dormitory = user_with_dormitory(db_session)
    store_import(db_session, dormitory, KEY)

    assert can_read(db_session, KEY, None) is False


def test_a_file_of_no_import_is_closed(db_session: Session) -> None:
    user, _dormitory = user_with_dormitory(db_session)

    assert can_read(db_session, OTHER_KEY, user) is False


def test_a_traversal_key_is_closed(db_session: Session) -> None:
    user, dormitory = user_with_dormitory(db_session)
    store_import(db_session, dormitory, KEY)

    assert can_read(db_session, "../2026-10-29/abc123.xlsx", user) is False


def test_an_organization_link_without_membership_is_not_a_right(db_session: Session) -> None:
    """`active_organization_id` без строки членства правом не является."""
    _owner, dormitory = user_with_dormitory(db_session)
    store_import(db_session, dormitory, KEY)
    outsider = create_user(db_session, email="outsider@example.com")
    outsider.active_organization_id = dormitory.organization_id
    db_session.commit()

    assert can_read(db_session, KEY, outsider) is False


def test_register_upload_records_who_and_why(db_session: Session) -> None:
    user, _dormitory = user_with_dormitory(db_session)

    register_upload(db_session, stored_path(KEY), user, purpose="places_import")

    row = db_session.query(UploadedFile).filter(UploadedFile.key == KEY).one()
    assert row.uploader_kind == "user"
    assert row.uploader_id == user.id
    assert row.purpose == "places_import"
    assert row.created_at is not None


def test_register_upload_does_not_duplicate_the_key(db_session: Session) -> None:
    user, _dormitory = user_with_dormitory(db_session)

    register_upload(db_session, KEY, user, purpose="places_import")
    register_upload(db_session, KEY, user, purpose="other")

    rows = db_session.query(UploadedFile).filter(UploadedFile.key == KEY).all()
    assert len(rows) == 1
    assert rows[0].purpose == "places_import"


def test_register_upload_without_commit_joins_the_caller_transaction(db_session: Session) -> None:
    """`commit=False` оставляет регистрацию в общей транзакции импорта."""
    user, _dormitory = user_with_dormitory(db_session)

    register_upload(db_session, KEY, user, purpose="places_import", commit=False)
    db_session.rollback()

    assert db_session.query(UploadedFile).filter(UploadedFile.key == KEY).first() is None


def test_register_upload_ignores_an_unusable_key(db_session: Session) -> None:
    register_upload(db_session, "../evil.xlsx", purpose="places_import")

    assert db_session.query(UploadedFile).count() == 0

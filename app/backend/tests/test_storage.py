"""Единый механизм хранения файлов: раскладка по дням, чтение и защита ключа.

Проверяется локальный режим (`LocalStorage`) — он же режим юнит-прогона и
стенда без ключей S3. S3-режим здесь только выбирается: клиент boto3 создаётся
без обращения к сети, а настоящий бакет проверяется на стенде
(`docs/file-access.md`).

Раскладка по дням важна не сама по себе: ключ, который вернул `save_bytes`,
попадает в `import_jobs.file_key` и в ссылку `/uploads/<ключ>`, поэтому формат
`YYYY-MM-DD/имя` — часть контракта хранилища, а не деталь реализации.
"""

from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import storage as storage_module
from app.config import Settings
from app.storage import (
    LocalStorage,
    S3Storage,
    Storage,
    StorageError,
    StorageNotFoundError,
    get_storage,
)

KEY = "2026-10-29/abc123.xlsx"
PAYLOAD = b"PK\x03\x04 not really a workbook"


def today() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%d")


def local_storage(tmp_path: Path) -> LocalStorage:
    return LocalStorage(tmp_path / "uploads")


def test_save_bytes_puts_the_file_into_the_today_folder(tmp_path: Path) -> None:
    local = local_storage(tmp_path)

    key = local.save_bytes(PAYLOAD, "abc123.xlsx")

    assert key == f"{today()}/abc123.xlsx"
    assert local.read_bytes(key) == PAYLOAD
    assert local.exists(key) is True


def test_put_raw_keeps_the_key_as_is(tmp_path: Path) -> None:
    local = local_storage(tmp_path)

    assert local.put_raw(PAYLOAD, KEY) == KEY
    assert local.read_bytes(KEY) == PAYLOAD


def test_missing_file_is_a_not_found_error(tmp_path: Path) -> None:
    local = local_storage(tmp_path)

    with pytest.raises(StorageNotFoundError):
        local.read_bytes("2026-10-29/nope.xlsx")
    assert local.exists("2026-10-29/nope.xlsx") is False


def test_delete_is_idempotent(tmp_path: Path) -> None:
    local = local_storage(tmp_path)
    local.put_raw(PAYLOAD, KEY)

    local.delete(KEY)
    local.delete(KEY)

    assert local.exists(KEY) is False


def test_list_folder_returns_relative_keys(tmp_path: Path) -> None:
    local = local_storage(tmp_path)
    local.put_raw(PAYLOAD, "2026-10-29/a.xlsx")
    local.put_raw(PAYLOAD, "2026-10-29/b.xlsx")

    assert local.list_folder("2026-10-29") == ["2026-10-29/a.xlsx", "2026-10-29/b.xlsx"]


@pytest.mark.parametrize("name", ["../evil.xlsx", "2026-10-29/../../evil.xlsx", "", "/"])
def test_keys_with_traversal_or_empty_are_rejected(tmp_path: Path, name: str) -> None:
    local = local_storage(tmp_path)

    with pytest.raises(StorageError):
        local.save_bytes(PAYLOAD, name)


def test_leading_slash_does_not_escape_the_storage_folder(tmp_path: Path) -> None:
    """Абсолютный путь снимается до относительного ключа, а не ведёт из каталога."""
    local = local_storage(tmp_path)

    assert local.put_raw(PAYLOAD, "/2026-10-29/a.xlsx") == "2026-10-29/a.xlsx"
    assert (tmp_path / "uploads" / "2026-10-29" / "a.xlsx").read_bytes() == PAYLOAD


def test_storage_without_keys_falls_back_to_the_local_disk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        storage_module,
        "get_settings",
        lambda: SimpleNamespace(s3_enabled=False),
    )

    assert isinstance(get_storage(), LocalStorage)


def test_storage_with_keys_uses_s3(monkeypatch: pytest.MonkeyPatch) -> None:
    """Клиент boto3 создаётся без обращения к сети: проверяется выбор режима."""
    monkeypatch.setattr(
        storage_module,
        "get_settings",
        lambda: SimpleNamespace(
            s3_enabled=True,
            s3_endpoint="https://s3.example.test",
            s3_access_key="key",
            s3_secret_key="secret",
            s3_bucket="bucket",
            s3_prefix="crm-agent-test",
            s3_region="ru-1",
        ),
    )

    assert isinstance(get_storage(), S3Storage)


def test_the_mode_is_chosen_by_the_keys_of_the_active_environment() -> None:
    """Ключи и префикс берутся у пары активной среды, а не у обеих сразу."""
    settings = Settings(
        database_url="sqlite+pysqlite:///:memory:",
        jwt_secret="unit-test-secret-value-0123456789",
        s3_bucket="bucket",
        s3_env="test",
        s3_access_key_test="test-key",
        s3_secret_key_test="test-secret",
        s3_access_key_prod="prod-key",
        s3_secret_key_prod="prod-secret",
    )

    assert settings.s3_enabled is True
    assert settings.s3_access_key == "test-key"
    assert settings.s3_prefix == "crm-agent-test"
    assert settings.s3_region == "ru-1"

    prod = settings.model_copy(update={"s3_env": "prod"})
    assert prod.s3_access_key == "prod-key"
    assert prod.s3_prefix == "crm-prod"


def test_empty_bucket_turns_s3_off() -> None:
    """Пустой бакет — это локальный режим, а не полусобранный S3."""
    settings = Settings(
        database_url="sqlite+pysqlite:///:memory:",
        jwt_secret="unit-test-secret-value-0123456789",
        s3_bucket="",
    )

    assert settings.s3_enabled is False


def test_storage_is_the_single_shared_object() -> None:
    """Проект берёт хранилище из одного места: `from app.storage import storage`."""
    assert isinstance(storage_module.storage, Storage)

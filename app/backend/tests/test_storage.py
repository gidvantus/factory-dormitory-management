"""Единый механизм хранения файлов: раскладка по дням, чтение и защита ключа.

Проверяется локальный режим (`LocalStorage`) — он же режим юнит-прогона и
стенда без ключей S3 — и перевод ошибок boto3 в `StorageError`: на этом держится
обещанный `503` «Хранилище файлов недоступно…» из ручки импорта. Сам S3-клиент
подменяется заглушкой: обращений к сети в юнит-прогоне нет, а настоящий бакет
проверяется на стенде (`docs/file-access.md`).

Раскладка по дням важна не сама по себе: ключ, который вернул `save_bytes`,
попадает в `import_jobs.file_key` и в ссылку `/uploads/<ключ>`, поэтому формат
`YYYY-MM-DD/имя` — часть контракта хранилища, а не деталь реализации.
"""

import logging
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

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


def test_an_empty_folder_lists_the_whole_storage(tmp_path: Path) -> None:
    """Значение по умолчанию `folder=""` — «весь каталог», а не недопустимый ключ."""
    local = local_storage(tmp_path)
    local.put_raw(PAYLOAD, "2026-10-29/a.xlsx")
    local.put_raw(PAYLOAD, "2026-10-30/b.xlsx")

    assert local.list_folder() == ["2026-10-29/a.xlsx", "2026-10-30/b.xlsx"]


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


@pytest.mark.parametrize("env", ["production", "Prod", ""])
def test_a_typo_in_the_environment_fails_the_application_at_start(env: str) -> None:
    """`S3_ENV` — `Literal`: опечатка роняет старт, а не переключает хранилище молча.

    Свободная строка дала бы пустые ключи активной среды, `s3_enabled = False` и
    локальный диск вместо бакета: импорты легли бы в `/app/uploads`, и нашлось бы
    это только глазами в каталоге.
    """
    with pytest.raises(ValidationError):
        Settings(
            database_url="sqlite+pysqlite:///:memory:",
            jwt_secret="unit-test-secret-value-0123456789",
            s3_bucket="bucket",
            s3_env=env,
        )


def s3_storage() -> S3Storage:
    """S3-хранилище с фиктивными ключами: клиент создаётся без обращения к сети."""
    return S3Storage(
        endpoint="https://s3.example.test",
        access_key="key",
        secret_key="secret",
        bucket="bucket",
        prefix="crm-agent-test",
    )


class FailingClient:
    """Заглушка клиента S3, которая падает на любом вызове."""

    def __init__(self, error: Exception) -> None:
        self._error = error

    def put_object(self, **_kwargs: object) -> None:
        raise self._error

    def get_object(self, **_kwargs: object) -> None:
        raise self._error

    def delete_object(self, **_kwargs: object) -> None:
        raise self._error

    def head_object(self, **_kwargs: object) -> None:
        raise self._error


def failing_storage(error: Exception) -> S3Storage:
    storage = s3_storage()
    storage._client = FailingClient(error)
    return storage


def access_denied() -> Exception:
    """Ответ S3 «нет прав на запись» — `ClientError`, а не `StorageError`."""
    from botocore.exceptions import ClientError

    return ClientError({"Error": {"Code": "AccessDenied", "Message": "Access Denied"}}, "PutObject")


def endpoint_is_down() -> Exception:
    """Сетевой отказ boto3 — `BotoCoreError`."""
    from botocore.exceptions import EndpointConnectionError

    return EndpointConnectionError(endpoint_url="https://s3.example.test")


@pytest.mark.parametrize("error", [access_denied(), endpoint_is_down()])
@pytest.mark.parametrize("call", ["save_bytes", "put_raw", "delete"])
def test_a_failed_s3_call_becomes_a_storage_error(error: Exception, call: str) -> None:
    """Ошибки boto3 наружу не выходят: их ловит ручка и отдаёт 503.

    `ClientError` (нет прав, бакета нет) и `BotoCoreError` (площадка не
    отвечает) — не `StorageError`. Без перевода `except StorageError` в ручке
    импорта их не поймал бы, и клиент получил бы `500` вместо обещанного
    «Хранилище файлов недоступно, файл не сохранён».
    """
    storage = failing_storage(error)

    with pytest.raises(StorageError) as raised:
        if call == "save_bytes":
            storage.save_bytes(PAYLOAD, "abc123.xlsx")
        elif call == "put_raw":
            storage.put_raw(PAYLOAD, KEY)
        else:
            storage.delete(KEY)

    # Ошибка «файла нет» здесь была бы неверной: сбой записи — не отсутствие файла.
    assert not isinstance(raised.value, StorageNotFoundError)


def test_a_missing_object_is_a_not_found_error() -> None:
    from botocore.exceptions import ClientError

    storage = failing_storage(ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject"))

    with pytest.raises(StorageNotFoundError):
        storage.read_bytes(KEY)


@pytest.mark.parametrize("code", ["NoSuchBucket", "AccessDenied", "InvalidAccessKeyId"])
def test_a_configuration_or_rights_failure_is_not_a_missing_file(
    code: str, caplog: pytest.LogCaptureFixture
) -> None:
    """`NoSuchBucket` — ошибка настройки, а не пропавший файл.

    Раньше код «нет бакета» мапился в `StorageNotFoundError`: переименованный
    бакет или опечатка в `S3_BUCKET` выглядели как удалённые файлы — каждая
    ссылка отвечала `404`, а в логе не было ни строки. Теперь это
    `StorageError` (наружу — `500`) и запись в логе с кодом отказа.
    """
    from botocore.exceptions import ClientError

    storage = failing_storage(ClientError({"Error": {"Code": code}}, "GetObject"))

    with pytest.raises(StorageError) as raised:
        storage.read_bytes(KEY)

    assert not isinstance(raised.value, StorageNotFoundError)
    assert "отказ сервиса" in caplog.text


def test_a_bucketless_delete_is_reported_as_a_failure() -> None:
    """`delete` тоже не должен выдавать ошибку настройки за «файла нет»."""
    from botocore.exceptions import ClientError

    storage = failing_storage(ClientError({"Error": {"Code": "NoSuchBucket"}}, "DeleteObject"))

    with pytest.raises(StorageError) as raised:
        storage.delete(KEY)

    assert not isinstance(raised.value, StorageNotFoundError)


def test_a_network_failure_on_read_is_a_storage_error() -> None:
    """Сеть не отвечает — это 500 через `StorageError`, а не «файла нет»."""
    storage = failing_storage(endpoint_is_down())

    with pytest.raises(StorageError) as raised:
        storage.read_bytes(KEY)

    assert not isinstance(raised.value, StorageNotFoundError)


def test_s3_exists_treats_a_failed_call_as_absent() -> None:
    storage = failing_storage(endpoint_is_down())

    assert storage.exists(KEY) is False


def test_storage_is_the_single_shared_object() -> None:
    """Проект берёт хранилище из одного места: `from app.storage import storage`."""
    assert isinstance(storage_module.storage, Storage)


def test_the_storage_mode_is_written_to_the_log(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Режим хранилища видно в логе: раньше «S3 выключен» находили только по каталогу.

    Строка пишется на старте приложения (`app.main.lifespan`), а не при импорте
    `app.storage`: импорт идёт раньше настройки логирования, и запись на уровне
    INFO терялась.
    """
    caplog.set_level(logging.INFO, logger="app.storage")

    storage_module.log_storage_mode()

    assert "Хранилище файлов" in caplog.text
    assert "LocalStorage" in caplog.text


def test_the_mode_log_line_shows_the_prefix_and_no_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """В лог попадают только тип хранилища и префикс среды: ключей там нет."""
    lines: list[str] = []

    class Collector(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            lines.append(record.getMessage())

    handler = Collector()
    logger = logging.getLogger("app.storage")
    logger.addHandler(handler)
    try:
        monkeypatch.setattr(storage_module, "storage", s3_storage())
        monkeypatch.setattr(
            storage_module,
            "get_settings",
            lambda: SimpleNamespace(s3_prefix="crm-agent-test"),
        )
        storage_module.log_storage_mode()
    finally:
        logger.removeHandler(handler)

    assert lines, "режим хранилища не попал в лог"
    written = " ".join(lines)
    assert "S3Storage" in written
    assert "crm-agent-test" in written
    # Ключ доступа лежит в самом хранилище — в строку лога он попасть не должен.
    assert "secret" not in written.lower()

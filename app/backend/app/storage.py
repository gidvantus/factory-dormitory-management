"""Единый механизм хранения файлов проекта.

ВСЕ чтения и записи файлов в проекте должны идти только через этот модуль:

    from app.storage import storage

    key = storage.save_bytes(data, "имя.ext")   # запись (возвращает ключ с датой)
    data = storage.read_bytes(key)              # чтение
    storage.delete(key)                         # удаление (идемпотентно)
    storage.exists(key)                         # проверка наличия

Файлы раскладываются по подпапкам: внутри префикса среды на каждый день
создаётся отдельная папка YYYY-MM-DD, например:

    crm-agent-test/2026-10-29/abc123.xlsx   (тестовая среда)
    crm-prod/2026-10-29/abc123.xlsx         (боевая среда)

Ключ, возвращаемый save_bytes (например "2026-10-29/abc123.xlsx"), — это
относительный путь внутри префикса; его же принимают read_bytes/delete/exists.

Режим выбирается конфигурацией (app.config):
  * S3 включён, когда заданы S3_ENDPOINT, S3_BUCKET и ключи активной среды
    (S3_ENV=test|prod). Файлы хранятся в общем бакете под префиксом среды.
  * Иначе — локальный каталог app/backend/uploads (режим разработки без S3),
    структура та же: uploads/2026-10-29/имя.ext.

Ключи доступа берутся только из переменных окружения (.env, в репозиторий
не попадает) и никогда не логируются. boto3 импортируется лениво: режим
локального диска не требует установленного boto3.
"""

import logging
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.config import get_settings

log = logging.getLogger(__name__)

# Каталог локального хранилища (fallback без S3): <app/backend>/uploads,
# в образе — /app/uploads (в compose у сервиса `api` смонтирован том).
UPLOAD_DIR = Path(__file__).resolve().parent.parent / "uploads"


def _today_dir() -> str:
    """Подпапка текущего дня (UTC), например 2026-10-29."""
    return datetime.now(UTC).strftime("%Y-%m-%d")


def _boto_errors() -> tuple[type[Exception], ...]:
    """Исключения boto3, которые обязан поймать `S3Storage`.

    Импорт ленивый, как и сам boto3: режим локального диска не требует ни
    библиотеки, ни этого модуля, а `except` принимает любое выражение-кортеж.
    """
    from botocore.exceptions import BotoCoreError, ClientError

    return (ClientError, BotoCoreError)


class StorageError(Exception):
    """Общая ошибка файлового хранилища."""


class StorageNotFoundError(StorageError):
    """Файл не найден в хранилище."""


def _safe_key(name: str) -> str:
    """Очищает имя объекта: без абсолютных путей и обходов каталогов."""
    key = str(name).replace("\\", "/").strip("/")
    if not key or any(part == ".." for part in key.split("/")):
        raise StorageError(f"Недопустимое имя файла: {name!r}")
    return key


class Storage:
    """Единый интерфейс хранилища файлов."""

    # --- запись ---
    def save_bytes(self, data: bytes, name: str, content_type: str | None = None) -> str:
        """Сохраняет байты под именем name. Возвращает ключ с подпапкой даты."""
        raise NotImplementedError

    def put_raw(self, data: bytes, key: str, content_type: str | None = None) -> str:
        """Сохраняет объект ровно по ключу key (без подпапки даты).

        Нужно для служебных файлов, которым не подходит раскладка save_bytes
        по дням. Возвращает key.
        """
        raise NotImplementedError

    # --- чтение ---
    def read_bytes(self, name: str) -> bytes:
        """Читает файл целиком. StorageNotFoundError, если файла нет."""
        raise NotImplementedError

    # --- список ---
    def list_folder(self, folder: str = "") -> list[str]:
        """Возвращает относительные ключи файлов внутри folder (без префикса среды)."""
        raise NotImplementedError

    # --- удаление ---
    def delete(self, name: str) -> None:
        """Удаляет файл. Идемпотентно: отсутствующего файла не ошибка."""
        raise NotImplementedError

    # --- наличие ---
    def exists(self, name: str) -> bool:
        raise NotImplementedError


def _put_object(client: Any, **kwargs: Any) -> None:
    """`put_object` без утечки ошибок boto3 наружу.

    Сбой записи — «в бакете нет прав на запись», «площадка не отвечает»,
    «ключ доступа истёк» — обязан стать `StorageError`: только его ловит ручка
    импорта и превращает в `503` «Хранилище файлов недоступно, файл не
    сохранён». `ClientError` и `BotoCoreError` — не `StorageError`, и без этого
    перевода клиент получал бы `500` от общего обработчика, а обещанного
    текста не было бы вовсе.
    """
    try:
        client.put_object(**kwargs)
    except _boto_errors() as e:
        raise _map_client_error(e, str(kwargs.get("Key", ""))) from e


class S3Storage(Storage):
    """Хранение в S3-совместимом объектном хранилище (Timeweb Cloud)."""

    def __init__(
        self,
        *,
        endpoint: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        prefix: str,
        region: str = "ru-1",
    ) -> None:
        import boto3  # ленивый импорт: нужен только в S3-режиме
        from botocore.client import Config

        self._bucket = bucket
        self._prefix = f"{prefix.strip('/')}/" if prefix.strip("/") else ""
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "virtual"},
                connect_timeout=10,
                read_timeout=60,
                retries={"max_attempts": 2},
            ),
        )

    def _key(self, name: str) -> str:
        return self._prefix + _safe_key(name)

    def save_bytes(self, data: bytes, name: str, content_type: str | None = None) -> str:
        """Сохраняет файл в подпапку текущей даты (YYYY-MM-DD) внутри префикса среды.

        Возвращает относительный ключ вида "2026-10-29/имя.ext".
        """
        safe = _safe_key(name)
        key = f"{_today_dir()}/{safe}"
        _put_object(
            self._client,
            Bucket=self._bucket,
            Key=self._prefix + key,
            Body=data,
            ContentType=content_type or "application/octet-stream",
        )
        log.info("S3: сохранён объект %s%s", self._prefix, key)
        return key

    def put_raw(self, data: bytes, key: str, content_type: str | None = None) -> str:
        """Сохраняет объект ровно по ключу key внутри префикса среды."""
        safe = _safe_key(key)
        _put_object(
            self._client,
            Bucket=self._bucket,
            Key=self._prefix + safe,
            Body=data,
            ContentType=content_type or "application/octet-stream",
        )
        log.info("S3: сохранён объект %s%s", self._prefix, safe)
        return safe

    def list_folder(self, folder: str = "") -> list[str]:
        """Список файлов (относительные ключи) внутри folder, без префикса среды."""
        folder = _safe_key(folder)
        prefix = self._prefix + (folder + "/" if folder else "")
        keys: list[str] = []
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                if obj["Key"].endswith("/"):
                    continue  # виртуальные «папки» S3 пропускаем
                keys.append(obj["Key"][len(self._prefix) :])
        return keys

    def read_bytes(self, name: str) -> bytes:
        safe = _safe_key(name)
        try:
            resp = self._client.get_object(Bucket=self._bucket, Key=self._prefix + safe)
            return resp["Body"].read()
        except _boto_errors() as e:
            raise _map_client_error(e, name) from e

    def delete(self, name: str) -> None:
        safe = _safe_key(name)
        try:
            self._client.delete_object(Bucket=self._bucket, Key=self._prefix + safe)
        except _boto_errors() as e:
            raise _map_client_error(e, name) from e
        log.info("S3: удалён объект %s%s", self._prefix, safe)

    def exists(self, name: str) -> bool:
        safe = _safe_key(name)
        try:
            self._client.head_object(Bucket=self._bucket, Key=self._prefix + safe)
            return True
        except _boto_errors():
            return False


class LocalStorage(Storage):
    """Хранение в локальном каталоге (разработка без S3)."""

    def __init__(self, base_dir: Path = UPLOAD_DIR) -> None:
        self._base_dir = Path(base_dir)
        self._base_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str) -> Path:
        key = _safe_key(name)
        base = self._base_dir.resolve()
        path = (base / key).resolve()
        if not path.is_relative_to(base):
            raise StorageError(f"Недопустимое имя файла: {name!r}")
        return path

    def save_bytes(self, data: bytes, name: str, content_type: str | None = None) -> str:
        """Сохраняет файл в подпапку текущей даты (YYYY-MM-DD).

        Возвращает относительный ключ вида "2026-10-29/имя.ext".
        """
        safe = _safe_key(name)
        key = f"{_today_dir()}/{safe}"
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return key

    def put_raw(self, data: bytes, key: str, content_type: str | None = None) -> str:
        """Сохраняет файл ровно по ключу key (без подпапки даты)."""
        safe = _safe_key(key)
        path = self._path(safe)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return safe

    def list_folder(self, folder: str = "") -> list[str]:
        """Список файлов (относительные ключи) внутри folder."""
        folder_key = _safe_key(folder)
        base = self._path(folder_key) if folder_key else self._base_dir
        out: list[str] = []
        if base.is_dir():
            for p in sorted(base.rglob("*")):
                if p.is_file():
                    out.append(p.relative_to(self._base_dir).as_posix())
        return out

    def read_bytes(self, name: str) -> bytes:
        safe = _safe_key(name)
        try:
            return self._path(safe).read_bytes()
        except FileNotFoundError as e:
            raise StorageNotFoundError(safe) from e

    def delete(self, name: str) -> None:
        safe = _safe_key(name)
        # Идемпотентность: отсутствующий файл — не ошибка удаления.
        with suppress(OSError):
            self._path(safe).unlink(missing_ok=True)

    def exists(self, name: str) -> bool:
        return self._path(_safe_key(name)).is_file()


def _map_client_error(e: Exception, name: str) -> StorageError:
    """Превращает ошибки boto3 в StorageError / StorageNotFoundError.

    Сюда приходят и ответы сервиса (`ClientError`: нет прав, нет бакета), и
    сетевые отказы (`BotoCoreError`: площадка не отвечает, соединение
    оборвалось, подпись не собралась). И то и другое — `StorageError`, а не
    исключение boto3: вызывающий код умеет обращаться только с ним.
    """
    from botocore.exceptions import ClientError

    if isinstance(e, ClientError):
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("NoSuchKey", "NoSuchBucket", "NotFound"):
            return StorageNotFoundError(name)
        return StorageError(f"S3: {code}: {e}")
    return StorageError(f"S3: {e}")


def get_storage() -> Storage:
    """Возвращает активное хранилище (S3 или локальный диск)."""
    settings = get_settings()
    if settings.s3_enabled:
        return S3Storage(
            endpoint=settings.s3_endpoint,
            access_key=settings.s3_access_key,
            secret_key=settings.s3_secret_key,
            bucket=settings.s3_bucket,
            prefix=settings.s3_prefix,
            region=settings.s3_region,
        )
    return LocalStorage()


# Единая точка доступа для всего проекта.
storage = get_storage()


def log_storage_mode() -> None:
    """Пишет в лог выбранный режим хранилища — один раз, на старте приложения.

    Вызывается из `app.main.lifespan`, а не при импорте этого модуля:
    `app.storage` импортируется из `app.api.hostels` раньше, чем приложение
    успевает настроить логирование, и строка на уровне INFO тогда просто
    терялась (корневой логгер до этой настройки стоит на WARNING). Смысл тот же —
    при старте видно, куда пойдут файлы, — но запись действительно доходит до
    лога контейнера.

    Ключи и секреты в лог не попадают: только тип хранилища и префикс среды.
    """
    log.info(
        "Хранилище файлов: %s%s",
        type(storage).__name__,
        f", префикс {get_settings().s3_prefix}" if isinstance(storage, S3Storage) else "",
    )

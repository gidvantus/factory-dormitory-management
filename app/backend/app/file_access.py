"""Правила доступа к файлам (`/uploads/*`) — единая точка проверки.

Базовое правило: доступ **ЗАКРЫТ всем**. Право чтения появляется только тогда,
когда файл связан с данными организации пользователя:

    import — файл импорта «Размещение персонала»: задание `import_jobs` ссылается
             на него колонкой `file_key`, а общежитие задания принадлежит
             организации пользователя (`dormitories.organization_id`). Читает
             любой участник этой организации — роль не важна, это чтение своих
             данных.

Других правил в CRM нет намеренно: публичных файлов, владельческого правила,
чатов, аватаров и логотипов в проекте не существует. Реестр `uploaded_file`
(`uploader_kind`, `uploader_id`, `purpose`) — это учёт и диагностика, а не
право: файл открывает привязка к данным, а не факт загрузки. Иначе сотрудник,
загрузивший импорт, был бы единственным, кто может его скачать, а коллеги по
организации получали бы 403.

--------------------------------------------------------------------------------
ДОБАВЛЕНИЕ НОВОГО ВИДА ФАЙЛОВ
--------------------------------------------------------------------------------
1. Загрузку проводить ТОЛЬКО через `app.storage` и сразу регистрировать
   загрузку: `register_upload(session, key, user, purpose="...")`.
2. Связать файл с данными организации: колонкой вида `file_key` в таблице,
   которая уже знает свою организацию (как `import_jobs` знает общежитие).
   Без такой связи файл не прочитает никто — это и есть безопасное поведение
   по умолчанию.
3. Добавить ЯВНОЕ правило в `can_read` и тест на него в
   `app/backend/tests/test_file_access.py`.
4. Отдавать файл клиенту по-прежнему только через `/uploads/{key}` — других
   путей к файлам быть не должно.
"""

import mimetypes
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.dormitory import Dormitory
from app.models.import_job import ImportJob
from app.models.organization import OrganizationMember
from app.models.uploaded_file import UploadedFile
from app.models.user import User

# Путь файла в ответах API начинается с этого префикса, а ключ в `app.storage`
# — уже без него.
UPLOAD_PREFIX = "uploads/"

# Значение `uploaded_file.uploader_kind` для обычного пользователя CRM: других
# видов аккаунта в проекте нет.
UPLOADER_KIND_USER = "user"


def normalize_key(raw: str | None) -> str | None:
    """Приводит путь файла к ключу хранилища (без префикса `uploads/`).

    Понимает и `uploads/2026-10-29/имя.xlsx`, и `/uploads/...`, и голый ключ
    `2026-10-29/имя.xlsx`. Возвращает `None`, если путь пустой или
    подозрительный (обход каталогов): такой ключ не открывает ничего.
    """
    if not raw:
        return None
    key = str(raw).replace("\\", "/").strip().lstrip("/")
    if key.startswith(UPLOAD_PREFIX):
        key = key[len(UPLOAD_PREFIX) :]
    key = key.strip("/")
    if not key:
        return None
    parts = key.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    return key


def stored_path(key: str) -> str:
    """Путь файла в том виде, в каком он приходит клиенту: `uploads/<ключ>`."""
    return f"{UPLOAD_PREFIX}{key}"


def public_url(key: str) -> str:
    """Адрес файла для ссылки в ответах API: `/uploads/<ключ>`.

    Именно этот вид получает клиент в `file_url`: он подставляет адрес в `href`
    как есть и не собирает его из ключа. Ведущий слэш обязателен — иначе браузер
    понял бы адрес как относительный пути текущей страницы.
    """
    return f"/{stored_path(key)}"


# Тип содержимого по расширению ключа. Таблица нужна потому, что модуль
# `mimetypes` знает `.xlsx` только при наличии `/etc/mime.types`, а в образе
# `python:*-slim` его нет: без таблицы файл уходил бы как
# `application/octet-stream` и браузер не открыл бы его как таблицу.
CONTENT_TYPES_BY_SUFFIX = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".txt": "text/plain; charset=utf-8",
}


def content_type_for(key: str) -> str:
    """`Content-Type` по расширению ключа; неизвестное расширение — набор байт."""
    suffix = Path(key).suffix.lower()
    if suffix in CONTENT_TYPES_BY_SUFFIX:
        return CONTENT_TYPES_BY_SUFFIX[suffix]
    guessed = mimetypes.guess_type(key)[0]
    return guessed or "application/octet-stream"


def register_upload(
    session: Session,
    key: str,
    user: User | None = None,
    purpose: str | None = None,
    *,
    commit: bool = True,
) -> None:
    """Регистрирует загруженный файл в реестре (учёт: кто и зачем загрузил).

    Вызывается сразу после `storage.save_bytes`. Повторная регистрация того же
    ключа ничего не меняет: первая запись остаётся.

    `commit=False` — только `flush`: регистрация входит в ОБЩУЮ транзакцию
    вызывающего кода. Так импорт «Размещение персонала» пишет файл, задание
    импорта и строку реестра одним коммитом, а не тремя.
    """
    normalized = normalize_key(key)
    if normalized is None:
        return
    if session.scalar(select(UploadedFile.id).where(UploadedFile.key == normalized)) is not None:
        return
    session.add(
        UploadedFile(
            key=normalized,
            uploader_kind=UPLOADER_KIND_USER if user is not None else None,
            uploader_id=None if user is None else user.id,
            purpose=purpose,
        )
    )
    if commit:
        session.commit()
    else:
        session.flush()


def _import_file_organization_id(session: Session, key: str) -> int | None:
    """Организация, которой принадлежит общежитие задания с этим файлом.

    `None` — файла нет ни у одного задания: правило доступа не срабатывает.
    """
    organization_id = session.scalar(
        select(Dormitory.organization_id)
        # Импорт знает общежитие, общежитие знает организацию: чужое задание
        # от чужой организации по этому запросу не найдётся.
        .join(ImportJob, ImportJob.dormitory_id == Dormitory.id)
        .where(ImportJob.file_key == key)
        .limit(1)
    )
    return None if organization_id is None else int(organization_id)


def can_read(session: Session, key: str | None, user: User | None = None) -> bool:
    """Можно ли отдать файл этому пользователю (`None` — аноним).

    Единственная точка принятия решения для `/uploads/{key}`. Любое сомнение
    трактуется как запрет: аноним не читает ничего, участник организации читает
    только файлы своей организации.
    """
    normalized = normalize_key(key)
    if normalized is None:
        return False
    if user is None or user.active_organization_id is None:
        return False
    membership = session.scalar(
        select(OrganizationMember.id).where(
            OrganizationMember.organization_id == user.active_organization_id,
            OrganizationMember.user_id == user.id,
        )
    )
    if membership is None:
        # Ссылка на организацию без строки членства правом не является.
        return False
    return _import_file_organization_id(session, normalized) == user.active_organization_id

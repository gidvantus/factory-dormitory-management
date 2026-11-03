"""CLI резервных копий БД: выгрузка дампов в S3 и ротация.

Запускается ВНУТРИ контейнера `api` — там boto3 и ключи S3 из `.env` сервера;
сам дамп снимается снаружи (`docker exec db pg_dump`) и приходит сюда файлом:

    python -m app.backup_cli check
    python -m app.backup_cli upload /tmp/crm_20261103_030000.dump crm_20261103_030000.dump
    python -m app.backup_cli rotate backup/db 10

`check` печатает класс хранилища и префикс среды и отказывает, если пишем не в
S3 или не в боевой префикс `crm-prod`: при `S3_ENV=test` дамп уехал бы в
`crm-agent-test`, а при выключенном S3 — в локальный каталог `uploads`, то есть
на тот же сервер, с которого его и снимали.

`upload` кладёт файл ровно под ключ `backup/db/<имя>` внутри префикса среды,
например `crm-prod/backup/db/crm_20261103_030000.dump`. `rotate` оставляет
`keep` самых новых дампов в папке, остальные удаляет.

Имя объекта — часть контракта с `.github/workflows/backup-db.yml`: шаблон
`crm_ГГГГММДД_ЧЧММСС.dump` сортируется лексикографически в том же порядке, что и
по времени, поэтому ротации не нужны ни даты объектов, ни их метаданные.
Всё, что под шаблон не подходит, ротация не трогает никогда: под префиксом
`crm-prod` лежат ещё и файлы пользователей (`<ГГГГ-ММ-ДД>/<uuid>.xlsx`).
"""

import re
import sys
from collections.abc import Sequence
from pathlib import Path

from app.config import get_settings
from app.storage import S3Storage, Storage, StorageError, get_storage

# Папка дампов внутри префикса среды. Ротация работает только внутри `backup/`:
# защита от `list_folder("")`, который вернул бы весь префикс со файлами
# пользователей, и от удаления этих файлов.
BACKUP_FOLDER = "backup/db"
BACKUP_ROOT = "backup/"
# Префикс боевой среды (`S3_ENV=prod`). Дамп содержит персональные данные, и
# тестовый префикс — не место для боевой копии.
PROD_PREFIX = "crm-prod"
# Шаблон имени дампа: `crm_20261103_030000.dump`.
DUMP_NAME = re.compile(r"^crm_\d{8}_\d{6}\.dump$")


class BackupError(Exception):
    """Отказ CLI: аргументы не те или хранилище не годится для бэкапа."""


def _is_dump_in(folder: str, key: str) -> bool:
    """Дамп ли это `keep`-кандидат: лежит прямо в folder и назван по шаблону.

    Прямо — потому что `list_folder` локального хранилища обходит каталог
    рекурсивно; вложенные папки ротации не принадлежат.
    """
    parent, _, name = key.rpartition("/")
    return parent == folder and bool(DUMP_NAME.match(name))


def check_backup_storage(storage: Storage, prefix: str) -> str:
    """Проверяет, что бэкап уйдёт в S3 и в боевой префикс. Возвращает описание.

    Отказ, а не предупреждение: `::warning::` в Vahta был нужен, потому что там
    бэкап снимался и на первом деплое, когда базы ещё нет. Здесь «первого
    деплоя» нет — бэкап запускается по расписанию на давно работающем стенде,
    и неподходящее хранилище означает, что копия не уехала за пределы сервера.
    """
    if not isinstance(storage, S3Storage):
        raise BackupError(
            f"хранилище — {type(storage).__name__}, а не S3Storage: S3 выключен "
            "(пусты S3_BUCKET или ключи активной среды в .env сервера). Бэкап "
            "остался бы на том же диске, с которого снят"
        )
    if prefix != PROD_PREFIX:
        raise BackupError(
            f"префикс хранилища {prefix!r}, а боевой бэкап пишется только в "
            f"{PROD_PREFIX!r}: проверьте S3_ENV в .env сервера — при S3_ENV=test "
            "дамп уедет в crm-agent-test"
        )
    return f"Хранилище: {type(storage).__name__}, префикс: {prefix}"


def upload(storage: Storage, local_path: str | Path, name: str) -> str:
    """Выгружает локальный файл под ключ `backup/db/<name>`. Возвращает ключ."""
    if not DUMP_NAME.match(name):
        raise BackupError(
            f"имя дампа {name!r} не подходит под шаблон crm_ГГГГММДД_ЧЧММСС.dump: "
            "такие объекты ротация не отличит от файлов пользователей"
        )
    path = Path(local_path)
    try:
        data = path.read_bytes()
    except OSError as e:
        raise BackupError(f"не удалось прочитать дамп {path}: {e.strerror or e}") from e
    return storage.put_raw(data, f"{BACKUP_FOLDER}/{name}")


def rotate(storage: Storage, folder: str, keep: int) -> list[str]:
    """Оставляет `keep` самых новых дампов в `folder`, остальные удаляет.

    Возвращает список удалённых ключей в порядке удаления (от старых к новым).
    «Самый новый» — лексикографически наибольшее имя: `crm_ГГГГММДД_ЧЧММСС`
    сортируется по времени. Файлы, не подходящие под шаблон, не удаляются.
    """
    normalized = str(folder).strip().strip("/")
    if not normalized.startswith(BACKUP_ROOT):
        raise BackupError(
            f"папка {folder!r} вне {BACKUP_ROOT!r}: ротация трогает только копии БД, "
            "а не файлы пользователей под префиксом среды"
        )
    if keep < 1:
        raise BackupError(
            f"keep={keep}: оставлять меньше одного дампа нельзя — это удаление всех копий"
        )
    keys = sorted(k for k in storage.list_folder(normalized) if _is_dump_in(normalized, k))
    removed: list[str] = []
    for key in keys[:-keep]:
        storage.delete(key)
        removed.append(key)
    return removed


def _parse_keep(raw: str) -> int:
    """Разбирает `keep` из аргумента: нечисло — отказ, а не traceback."""
    try:
        return int(raw)
    except ValueError as e:
        raise BackupError(f"keep={raw!r} — не число") from e


def run(argv: Sequence[str], storage: Storage, prefix: str) -> int:
    """Выполняет команду и возвращает код выхода. Ошибки — одной строкой в stderr.

    Хранилище и префикс приходят аргументами, а не берутся из настроек: юнит-тест
    подаёт `LocalStorage(tmp_path)` и не поднимает приложение.
    """
    try:
        if list(argv) == ["check"]:
            print(check_backup_storage(storage, prefix))
            return 0
        if len(argv) == 3 and argv[0] == "upload":
            key = upload(storage, argv[1], argv[2])
            print(f"OK: выгружен {key}")
            return 0
        if len(argv) == 3 and argv[0] == "rotate":
            keep = _parse_keep(argv[2])
            removed = rotate(storage, argv[1], keep)
            for key in removed:
                print(f"удалён {key}")
            print(f"Ротация: удалено {len(removed)}, оставлено не больше {keep}")
            return 0
        raise BackupError(
            "неизвестная команда: нужна одна из 'check', 'upload <путь> <имя>', "
            "'rotate <папка> <keep>'"
        )
    except (BackupError, StorageError) as e:
        # Одна строка вместо traceback: в логе Actions он занимает сотню строк и
        # прячет причину, а `set -e` на сервере всё равно валит job по коду 1.
        print(f"ОШИБКА: {e}", file=sys.stderr)
        return 1


def main(argv: Sequence[str] | None = None) -> int:
    """Точка входа `python -m app.backup_cli`: хранилище из настроек приложения."""
    args = list(sys.argv[1:] if argv is None else argv)
    return run(args, get_storage(), get_settings().s3_prefix)


if __name__ == "__main__":
    sys.exit(main())

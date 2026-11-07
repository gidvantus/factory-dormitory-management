#!/usr/bin/env python3
"""Создание новой ревизии alembic с уникальным идентификатором.

Зачем не голый `alembic revision`: он берёт порядковый номер, а порядковые
номера сталкиваются, когда две ветки создают ревизии параллельно — так в этом
проекте и разошлись `0062_table_views` (develop-s) и `0060_merge_stand_heads`
(develop-m). Здесь идентификатор собирается из метки времени UTC и слага
описания: `20261105183000_svod_golov`. Две ветки, создавшие ревизии в одну
секунду, тоже не столкнутся — к идентификатору добавится `x`.

Главное правило — **ровно одна голова**: если в дереве их две, скрипт откажет
и не даст наращивать сломанное дерево. Сначала сведите головы:

    python _tools/alembic-heads.py --merge

Использование:

    python _tools/new_migration.py "добавить поле в заявку"
    python _tools/new_migration.py --dry-run "проверить, что создастся"
    python _tools/new_migration.py --versions <каталог> "описание"

Зависимостей нет: дерево ревизий разбирается в `_tools/alembic_tree.py` как
текст модулей, поэтому скрипт работает на раннере и на машине без alembic.

Коды возврата: 0 — файл создан (или показан при `--dry-run`), 1 — в дереве не
одна голова, 2 — ошибка каталога или записи.
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

# Импорт соседнего модуля: при `python _tools/new_migration.py` каталог скрипта
# уже первый в sys.path, поэтому пакет и `__init__.py` не нужны.
from alembic_tree import (
    DEFAULT_VERSIONS,
    NEW_TEMPLATE,
    collect,
    dangling_of,
    heads_of,
    timestamp_revision_id,
)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Создать ревизию alembic с идентификатором из метки времени.",
    )
    parser.add_argument("message", help="описание изменения — уходит в докстроку и в слаг")
    parser.add_argument(
        "--versions",
        type=Path,
        default=DEFAULT_VERSIONS,
        help="каталог alembic/versions (по умолчанию — каталог этого репозитория)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="показать файл и идентификатор, ничего не создавая",
    )
    return parser.parse_args(argv[1:])


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    versions = args.versions.resolve()
    if not versions.is_dir():
        print(f"Нет каталога ревизий: {versions}", file=sys.stderr)
        return 2
    try:
        files, parents = collect(versions)
    except (OSError, SyntaxError, ValueError) as error:
        print(f"Не удалось разобрать дерево ревизий в {versions}: {error}", file=sys.stderr)
        return 2
    if not files:
        print(f"В {versions} нет ни одной ревизии — каталог не тот.", file=sys.stderr)
        return 2

    heads = heads_of(files, parents)
    dangling = dangling_of(files, parents)
    if dangling:
        print(
            "Ошибка: в дереве есть `down_revision` без ревизии: "
            f"{', '.join(dangling)}. Это опечатка в имени родителя — "
            "alembic на таком дереве не стартует.",
            file=sys.stderr,
        )
        return 1
    if len(heads) != 1:
        print(
            "Ошибка: нужна ровно одна голова миграций, а в дереве их "
            f"{len(heads)}: {', '.join(heads)}. Новая ревизия на таком дереве "
            "нарастила бы развилку. Сначала сведите головы одной командой:\n"
            "  python _tools/alembic-heads.py --merge",
            file=sys.stderr,
        )
        return 1

    down_revision = heads[0]
    revision = timestamp_revision_id(args.message, files)
    created = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")
    text = NEW_TEMPLATE.format(
        message=args.message,
        revision=revision,
        down_revision=down_revision,
        created=created,
    )
    path = versions / f"{revision}.py"
    if path.exists():
        print(f"Файл {path.name} уже существует — повторите запуск.", file=sys.stderr)
        return 2

    if args.dry_run:
        print(f"--- был бы создан {path}:")
        print(text)
        return 0

    try:
        path.write_text(text, encoding="utf-8")
    except OSError as error:
        print(f"Не удалось записать {path.name}: {error}", file=sys.stderr)
        return 2
    print(f"Создана ревизия: {path.name}")
    print(f"  revision = {revision}")
    print(f"  down_revision = {down_revision}")
    print("Заполните upgrade()/downgrade(). Перед созданием ревизии делайте `git pull`,")
    print("а PR с миграцией мержите сразу: чем дольше живёт ветка, тем больше шанс развилки.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

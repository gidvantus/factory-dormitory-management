#!/usr/bin/env python3
"""Одна голова alembic: проверка и сводящая ревизия одной командой.

Зачем проверка: `api` начинает старт с `alembic upgrade head`
(`app/backend/entrypoint.sh`). Если в дереве ревизий две головы, alembic
отвечает «Multiple head revisions are present for given argument 'head'» и
выходит, контейнер `api` уходит в цикл перезапуска, а сайт отдаёт 502 от nginx
фронта. Так было после каждого параллельного слияния develop-s: #133, #139,
#159 и 5 ноября 2026 — на `main` и на `develop-m` после слияния develop-s (#169).

Зачем `--merge`: проверка без починки каждый раз превращалась в ручную правку —
посчитать следующий номер, вспомнить формат, вписать кортеж голов. Здесь это
одна команда: она же стоит в проверках pull request, в деплое и на стенде.

    python _tools/alembic-heads.py                      # проверка: ровно одна голова
    python _tools/alembic-heads.py --merge              # создать сводящую ревизию
    python _tools/alembic-heads.py --merge --name exchange_mail
    python _tools/alembic-heads.py --merge --dry-run    # показать файл, не создавая
    python _tools/alembic-heads.py <каталог>            # явный каталог alembic/versions

Разбор дерева общий с `_tools/new_migration.py` и живёт в `_tools/alembic_tree.py`:
зависимостей нет, файлы ревизий читаются как текст модуля (`ast`), а не импортом.

Коды возврата: 0 — одна голова (или сводящая ревизия создана, или сводить
нечего), 1 — голов несколько и `--merge` не просили, 2 — ошибка разбора дерева
или записи файла.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Импорт соседнего модуля: при `python _tools/alembic-heads.py` каталог скрипта
# уже первый в sys.path, поэтому пакет и `__init__.py` не нужны.
from alembic_tree import (
    DEFAULT_VERSIONS,
    SLUG,
    collect,
    dangling_of,
    heads_of,
    render_merge,
    write_revision,
)


def report_dangling(parents: dict[str, list[str]], dangling: list[str]) -> None:
    """Назвать `down_revision`, за которыми нет ревизии: опечатка ломает старт api."""
    for parent in dangling:
        children = ", ".join(
            revision for revision, down_revisions in parents.items() if parent in down_revisions
        )
        print(
            f"::error::down_revision {parent!r} указывает на несуществующую "
            f"ревизию (её ждут: {children}). Опечатка в имени родителя "
            f"ломает `alembic upgrade head` так же, как вторая голова.",
            file=sys.stderr,
        )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Проверить, что в дереве alembic ровно одна голова, или свести головы.",
    )
    parser.add_argument(
        "versions",
        nargs="?",
        type=Path,
        default=DEFAULT_VERSIONS,
        help="каталог alembic/versions (по умолчанию — каталог этого репозитория)",
    )
    parser.add_argument(
        "--merge",
        action="store_true",
        help="создать сводящую ревизию, если голов несколько",
    )
    parser.add_argument(
        "--name",
        default="merge_heads",
        help="слаг в идентификаторе сводящей ревизии (по умолчанию merge_heads)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="вместе с --merge: напечатать файл, ничего не создавая",
    )
    return parser.parse_args(argv[1:])


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.dry_run and not args.merge:
        print("--dry-run имеет смысл только с --merge.", file=sys.stderr)
        return 2
    if args.merge and not SLUG.match(args.name):
        print(
            f"--name {args.name!r}: нужен слаг из строчных латинских букв, цифр и подчёркиваний.",
            file=sys.stderr,
        )
        return 2

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
    print(f"Ревизий в дереве: {len(files)}. Каталог: {versions}")

    if dangling:
        report_dangling(parents, dangling)
        return 2

    if len(heads) == 1:
        print(f"Голова одна: {heads[0]}")
        if args.merge:
            print("Сводить нечего.")
        return 0

    if not args.merge:
        print(
            "::error::В дереве alembic "
            f"{len(heads)} головы: {', '.join(heads)}. `alembic upgrade head` "
            "падает с «Multiple head revisions», `api` уходит в цикл перезапуска, "
            "а сайт отдаёт 502. Лечится одной командой, схему она не трогает:\n"
            "  python _tools/alembic-heads.py --merge\n"
            "затем коммит созданного файла. Вручную — образец "
            "app/backend/alembic/versions/0063_merge_main_heads.py.",
            file=sys.stderr,
        )
        return 1

    revision, text = render_merge(files, heads, args.name)
    path = versions / f"{revision}.py"
    if path.exists():
        print(
            f"Файл {path.name} уже существует: номер {revision} занят, "
            f"разберитесь с деревом вручную.",
            file=sys.stderr,
        )
        return 2
    if args.dry_run:
        print(f"--- был бы создан {path}:")
        print(text)
        return 0

    try:
        path = write_revision(versions, revision, text)
    except OSError as error:
        print(f"Не удалось записать {path.name}: {error}", file=sys.stderr)
        return 2
    print(f"Создана сводящая ревизия: {path.name} (down_revision: {', '.join(heads)})")

    try:
        after_files, after_parents = collect(versions)
    except (OSError, SyntaxError, ValueError) as error:
        print(f"Созданный файл не разбирается: {error}", file=sys.stderr)
        return 2
    after_heads = heads_of(after_files, after_parents)
    if len(after_heads) != 1:
        print(
            f"После записи голов всё ещё {len(after_heads)}: {', '.join(after_heads)}",
            file=sys.stderr,
        )
        return 2
    print(f"Голова одна: {after_heads[0]}")
    print("Осталось: git add файла, коммит, push. Дальше головы проверяют деплой, стенд и PR.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

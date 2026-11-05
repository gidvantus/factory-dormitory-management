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

Своих зависимостей у скрипта нет намеренно: на раннере деплоя нет ни alembic,
ни зависимостей `app/backend`, а `alembic/env.py` тянет модели и драйвер базы.
Поэтому файлы ревизий разбираются как текст модуля (`ast`), а не импортом:
`alembic/versions` — не пакет, и импорт по имени разрешился бы в чужую
библиотеку из site-packages.

Коды возврата: 0 — одна голова (или сводящая ревизия создана, или сводить
нечего), 1 — голов несколько и `--merge` не просили, 2 — ошибка разбора дерева
или записи файла.
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path

# Каталог ревизий рядом с этим скриптом: `_tools/` лежит в корне репозитория.
DEFAULT_VERSIONS = Path(__file__).resolve().parents[1] / "app" / "backend" / "alembic" / "versions"

# Номер ревизии — первые четыре цифры идентификатора (`0063_merge_main_heads`).
NUMBER_PREFIX = re.compile(r"^(\d{4})_")

# Слаг в имени сводящей ревизии: латиница нижнего регистра, цифры, подчёркивания.
SLUG = re.compile(r"^[a-z][a-z0-9_]*$")

# Шаблон сводящей ревизии: тем же форматом пишутся файлы руками, поэтому
# сгенерированный файл не отличается от `0058_merge_alembic_heads` и соседей.
MERGE_TEMPLATE = '''"""Свести головы alembic: {heads}.

Ревизия создана `python _tools/alembic-heads.py --merge`: в дереве было
{count} головы, а `alembic upgrade head` работает только с одной. Головы
расходятся, когда develop-s и develop-m (или две ветки задач) независимо
добавляют ревизии, а слияние не сводит их между собой.

Ревизия пустая — только сводит головы, схемы и данных не касается. Допишите
причину, если она не сводится к параллельному слиянию веток.
"""

revision = "{revision}"
down_revision = ({parents})
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
'''


def literal_revisions(node: ast.expr) -> list[str]:
    """Достать идентификаторы ревизий из выражения `down_revision`.

    Поддерживаются обе формы, встречающиеся в дереве: строка (`"0059_x"`),
    `None` (корень) и кортеж/список родителей у сводящих ревизий
    (`("0059_x", "0059_y")`). Имя вместо литерала означает, что разбирать
    модуль исполнением, — это ошибка формата, о ней сообщаем явно.
    """
    if isinstance(node, ast.Constant) and node.value is None:
        return []
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, (ast.Tuple, ast.List)):
        revisions: list[str] = []
        for element in node.elts:
            if not (isinstance(element, ast.Constant) and isinstance(element.value, str)):
                raise ValueError("элемент down_revision — не строковый литерал")
            revisions.append(element.value)
        return revisions
    raise ValueError("down_revision — не литерал (строка, кортеж или None)")


def read_revision_file(path: Path) -> tuple[str, list[str]] | None:
    """Вернуть `revision` и список `down_revision` из файла ревизии.

    `None` — в файле нет присваивания `revision`: это не ревизия (например,
    вспомогательный модуль рядом), и головы он не образует.

    Читаем как `utf-8-sig`: правка ревизии на Windows добавляет BOM, а `ast`
    на нём падает с «invalid non-printable character U+FEFF».
    """
    tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
    revision: str | None = None
    down_revisions: list[str] = []
    for statement in tree.body:
        # Обе формы присваивания встречаются в дереве: `revision = "…"` и
        # аннотированная `revision: str = "…"` — без второй половина ревизий
        # выпала бы из разбора и «потеряла» своих родителей.
        if isinstance(statement, ast.AnnAssign):
            if not isinstance(statement.target, ast.Name) or statement.value is None:
                continue
            name, value = statement.target.id, statement.value
        elif isinstance(statement, ast.Assign):
            names = [target.id for target in statement.targets if isinstance(target, ast.Name)]
            if len(names) != 1:
                continue
            name, value = names[0], statement.value
        else:
            continue
        if name == "revision":
            if not (isinstance(value, ast.Constant) and isinstance(value.value, str)):
                raise ValueError("revision — не строковый литерал")
            revision = value.value
        elif name == "down_revision":
            down_revisions = literal_revisions(value)
    if revision is None:
        return None
    return revision, down_revisions


def collect(versions: Path) -> tuple[dict[str, Path], dict[str, list[str]]]:
    """Собрать дерево: идентификатор ревизии → файл, идентификатор → родители."""
    files: dict[str, Path] = {}
    parents: dict[str, list[str]] = {}
    for path in sorted(versions.glob("*.py")):
        parsed = read_revision_file(path)
        if parsed is None:
            continue
        revision, down_revisions = parsed
        if revision in files:
            raise ValueError(
                f"идентификатор ревизии {revision!r} встречается дважды: "
                f"{files[revision].name} и {path.name}"
            )
        files[revision] = path
        parents[revision] = down_revisions
    return files, parents


def heads_of(files: dict[str, Path], parents: dict[str, list[str]]) -> list[str]:
    """Головы — ревизии, на которые не ссылается ни один `down_revision`."""
    referenced = {down for down_revisions in parents.values() for down in down_revisions}
    return sorted(revision for revision in files if revision not in referenced)


def dangling_of(files: dict[str, Path], parents: dict[str, list[str]]) -> list[str]:
    """`down_revision`, за которыми нет ревизии: опечатка в имени родителя."""
    referenced = {down for down_revisions in parents.values() for down in down_revisions}
    return sorted(parent for parent in referenced if parent not in files)


def next_revision_id(files: dict[str, Path], name: str) -> str:
    """Следующий свободный номер ревизии плюс слаг: `0064_merge_heads`."""
    numbers = [
        int(match.group(1)) for revision in files if (match := NUMBER_PREFIX.match(revision))
    ]
    return f"{max(numbers, default=0) + 1:04d}_{name}"


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

    revision = next_revision_id(files, args.name)
    path = versions / f"{revision}.py"
    text = MERGE_TEMPLATE.format(
        heads=", ".join(heads),
        count=len(heads),
        revision=revision,
        parents=", ".join(f'"{head}"' for head in heads),
    )
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

    path.write_text(text, encoding="utf-8")
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

#!/usr/bin/env python3
"""Проверка «в дереве alembic ровно одна голова» — без alembic и без сети.

Зачем: `api` начинает старт с `alembic upgrade head` (`app/backend/entrypoint.sh`).
Если в дереве ревизий две головы, alembic отвечает «Multiple head revisions are
present for given argument 'head'» и выходит, контейнер `api` уходит в цикл
перезапуска, а сайт отдаёт 502 от nginx фронта. Так было после каждого
параллельного слияния develop-s: #133, #139, #159 и снова — на `main` после
слияния develop-s и develop-m (#169, #170). Каждый раз это ловилось уже на
сервере; этот скрипт ставит ту же проверку в деплой и в проверки pull request,
где падение дешевле.

Своих зависимостей у скрипта нет намеренно: на раннере деплоя нет ни alembic,
ни зависимостей `app/backend`, а `alembic/env.py` тянет модели и драйвер базы.
Поэтому файлы ревизий разбираются как текст модуля (`ast`), а не импортом:
`alembic/versions` — не пакет, и импорт по имени разрешился бы в чужую
библиотеку из site-packages.

    python _tools/alembic-heads.py               # каталог ревизий по умолчанию
    python _tools/alembic-heads.py <каталог>     # явный каталог `alembic/versions`

Коды возврата: 0 — одна голова, 1 — голов несколько, 2 — ревизия ссылается на
несуществующего родителя (опечатка в `down_revision`).
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

# Каталог ревизий рядом с этим скриптом: `_tools/` лежит в корне репозитория.
DEFAULT_VERSIONS = Path(__file__).resolve().parents[1] / "app" / "backend" / "alembic" / "versions"


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
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
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


def main(argv: list[str]) -> int:
    versions = Path(argv[1]).resolve() if len(argv) > 1 else DEFAULT_VERSIONS
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

    referenced: set[str] = set()
    for down_revisions in parents.values():
        referenced.update(down_revisions)
    heads = sorted(revision for revision in files if revision not in referenced)
    dangling = sorted(parent for parent in referenced if parent not in files)

    print(f"Ревизий в дереве: {len(files)}. Каталог: {versions}")
    if dangling:
        for parent in dangling:
            children = ", ".join(revision for revision, downs in parents.items() if parent in downs)
            print(
                f"::error::down_revision {parent!r} указывает на несуществующую "
                f"ревизию (её ждут: {children}). Опечатка в имени родителя "
                f"ломает `alembic upgrade head` так же, как вторая голова.",
                file=sys.stderr,
            )
        return 2

    if len(heads) == 1:
        print(f"Голова одна: {heads[0]}")
        return 0

    print(
        "::error::В дереве alembic "
        f"{len(heads)} головы: {', '.join(heads)}. `alembic upgrade head` "
        "падает с «Multiple head revisions», `api` уходит в цикл перезапуска, "
        "а сайт отдаёт 502. Нужна сводящая ревизия: `revision` — новое имя, "
        "`down_revision` — кортеж из перечисленных голов (образец — "
        "app/backend/alembic/versions/0060_merge_stand_heads.py).",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

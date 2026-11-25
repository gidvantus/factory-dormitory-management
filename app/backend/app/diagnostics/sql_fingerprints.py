"""Поиск SQL-шаблона по fingerprint из события `slow_sql_request` (issue #231).

Событие в stdout само SQL не содержит — там только fingerprint: `text()` в
проекте собирается f-строками, и литерал в готовом SQL уже не отличить от имени
колонки. Поэтому шаблон ищут офлайн, по коду:

    # все SQL из кода с отпечатками
    python -m app.diagnostics.sql_fingerprints

    # что даёт отпечаток у конкретного SQL
    python -m app.diagnostics.sql_fingerprints "SELECT id FROM residents WHERE id = :id"

    # где в коде шаблон с отпечатком из события
    python -m app.diagnostics.sql_fingerprints --fingerprint 1a2b3c4d5e6f

Команда ничего не выполняет в базе: она читает `.py` файлы (по умолчанию —
текущий каталог), берёт строковые литералы, похожие на SQL, и считает отпечатки
той же функцией, что и приложение (`app.sql_diagnostics.fingerprint`). Ни одного
`EXPLAIN`, ни одного подключения к базе здесь нет и быть не должно.

Коды выхода: `0` — отпечаток найден (или список напечатан); `2` — не найден;
`1` — ошибка запуска или разбора файла.

Чего команда не находит: SQL, который собирает сам SQLAlchemy из ORM-запросов
(`select(Resident)…`). Готовый стейтмент там появляется только во время
выполнения, в коде его нет. Для таких событий шаблон ищут по маршруту из того же
события и по списку таблиц `tables`: он в событии есть и сужает поиск до места
в ручке. См. `docs/monitoring.md`.
"""

import argparse
import ast
import sys
from collections.abc import Iterator, Sequence
from pathlib import Path

from app.sql_diagnostics import analyze, fingerprint, normalize

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_NOT_FOUND = 2

# Что вообще считается SQL-литералом в коде. Отбор нарочно широкий: лучше
# показать лишнюю строку, чем не найти медленный шаблон.
_SQL_STARTS = (
    "select ",
    "insert ",
    "update ",
    "delete ",
    "with ",
    "merge ",
    "set ",
    "explain ",
    "analyze ",
)
# Сколько символов нормализованной формы печатать рядом с отпечатком.
_PREVIEW = 140


def _looks_like_sql(text: str) -> bool:
    """Похож ли литерал на SQL-стейтмент, а не на текст сообщения."""
    stripped = text.strip()
    if len(stripped) < 12:
        return False
    if analyze(stripped).operation != "OTHER":
        return True
    lowered = normalize(stripped).lower()
    return any(marker in lowered for marker in (" from ", " join "))


def statements(path: Path) -> Iterator[tuple[int, str]]:
    """SQL-литералы файла и номера строк, где они начинаются."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and _looks_like_sql(node.value)
        ):
            yield node.lineno, node.value


def scan(root: Path) -> Iterator[tuple[str, Path, int, str]]:
    """Обойти каталог и отдать (отпечаток, файл, строка, шаблон)."""
    for path in sorted(root.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        try:
            found = list(statements(path))
        except (OSError, SyntaxError, UnicodeDecodeError) as error:
            print(f"{path}: {error}", file=sys.stderr)
            continue
        for lineno, statement in found:
            yield fingerprint(statement), path, lineno, normalize(statement)


def _print_table(root: Path) -> int:
    """Напечатать все найденные шаблоны: отпечаток, место, начало SQL."""
    rows = 0
    for value, path, lineno, template in scan(root):
        rows += 1
        print(f"{value}  {path}:{lineno}  {template[:_PREVIEW]}")
    if not rows:
        print(f"SQL-литералов не найдено: {root}", file=sys.stderr)
        return EXIT_NOT_FOUND
    return EXIT_OK


def _find(root: Path, wanted: str) -> int:
    """Найти места в коде по отпечатку из события."""
    target = wanted.strip().lower()
    rows = 0
    for value, path, lineno, template in scan(root):
        if value != target:
            continue
        rows += 1
        print(f"{path}:{lineno}  {template[:_PREVIEW]}")
    if not rows:
        print(f"Отпечаток {wanted} в {root} не найден", file=sys.stderr)
        return EXIT_NOT_FOUND
    return EXIT_OK


def main(argv: Sequence[str] | None = None) -> int:
    """Точка входа команды; коды выхода — часть контракта для оператора."""
    parser = argparse.ArgumentParser(
        prog="python -m app.diagnostics.sql_fingerprints",
        description="Отпечатки SQL-шаблонов: посчитать по SQL или найти шаблон в коде.",
    )
    parser.add_argument("sql", nargs="?", help="SQL, отпечаток которого нужно посчитать")
    parser.add_argument(
        "--scan",
        type=Path,
        default=Path(),
        metavar="КАТАЛОГ",
        help="где искать SQL в коде (по умолчанию текущий каталог)",
    )
    parser.add_argument(
        "--fingerprint",
        dest="wanted",
        metavar="ОТПЕЧАТОК",
        help="отпечаток из события: напечатать место в коде",
    )
    try:
        args = parser.parse_args(argv)
    except SystemExit as exit_request:
        # `argparse` выходит кодом 2, а `2` здесь значит «не найдено»: код отказа
        # в запуске не должен читаться как результат поиска.
        return EXIT_ERROR if exit_request.code else EXIT_OK

    if args.sql:
        print(fingerprint(args.sql))
        print(normalize(args.sql))
        return EXIT_OK
    if not args.scan.is_dir():
        print(f"Каталог не найден: {args.scan}", file=sys.stderr)
        return EXIT_ERROR
    if args.wanted:
        return _find(args.scan, args.wanted)
    return _print_table(args.scan)


if __name__ == "__main__":  # pragma: no cover - запуск командой, не импортом
    sys.exit(main())

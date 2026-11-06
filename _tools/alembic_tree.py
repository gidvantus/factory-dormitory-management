#!/usr/bin/env python3
"""Разбор дерева ревизий alembic: общая часть для инструментов `_tools/`.

Зачем отдельный модуль: `alembic-heads.py` проверяет и сводит головы, а
`new_migration.py` создаёт новую ревизию. Обоим нужно одно и то же — прочитать
`revision`/`down_revision` из файлов, посчитать головы и понять, что дерево
цело. Две копии этого разбора разъехались бы на первой же правке (как когда-то
разъехались копии обвязчика в тестах миграций), поэтому разбор живёт здесь.

Зависимостей нет намеренно: на раннере деплоя нет ни alembic, ни зависимостей
`app/backend`, а `alembic/env.py` тянет модели и драйвер базы. Поэтому файлы
ревизий читаются как текст модуля (`ast`), а не импортом: `alembic/versions` —
не пакет, и импорт по имени разрешился бы в чужую библиотеку из site-packages.

Импорт рассчитан на запуск скриптов из `_tools/` (`python _tools/<скрипт>.py`):
в этом случае каталог скрипта уже первый в `sys.path`.
"""

from __future__ import annotations

import ast
import re
from datetime import UTC, datetime
from pathlib import Path

# Каталог ревизий рядом с этим модулем: `_tools/` лежит в корне репозитория.
DEFAULT_VERSIONS = Path(__file__).resolve().parents[1] / "app" / "backend" / "alembic" / "versions"

# Номер ревизии — первые четыре цифры идентификатора (`0063_merge_main_heads`).
NUMBER_PREFIX = re.compile(r"^(\d{4})_")

# Слаг в идентификаторе ревизии: строчная латиница, цифры, подчёркивания.
SLUG = re.compile(r"^[a-z][a-z0-9_]*$")

# Транслитерация для имён ревизий: описания в проекте русские, а идентификатор
# должен остаться читаемым (`svod_golov`, а не `migration`).
TRANSLIT = str.maketrans(
    {
        "а": "a",
        "б": "b",
        "в": "v",
        "г": "g",
        "д": "d",
        "е": "e",
        "ё": "e",
        "ж": "zh",
        "з": "z",
        "и": "i",
        "й": "y",
        "к": "k",
        "л": "l",
        "м": "m",
        "н": "n",
        "о": "o",
        "п": "p",
        "р": "r",
        "с": "s",
        "т": "t",
        "у": "u",
        "ф": "f",
        "х": "h",
        "ц": "ts",
        "ч": "ch",
        "ш": "sh",
        "щ": "sch",
        "ъ": "",
        "ы": "y",
        "ь": "",
        "э": "e",
        "ю": "yu",
        "я": "ya",
    }
)

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

# Шаблон новой ревизии — как у `alembic revision`, но идентификатор из времени.
NEW_TEMPLATE = '''"""{message}

Revision ID: {revision}
Revises: {down_revision}
Create Date: {created}

"""

revision = "{revision}"
down_revision = "{down_revision}"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # TODO: изменения схемы (op.add_column, op.create_table и т.п.)
    pass


def downgrade() -> None:
    # TODO: обратные изменения, в обратном порядке
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


def next_merge_id(files: dict[str, Path], name: str) -> str:
    """Следующий свободный номер плюс слаг для сводящей ревизии: `0064_merge_heads`."""
    numbers = [
        int(match.group(1)) for revision in files if (match := NUMBER_PREFIX.match(revision))
    ]
    return f"{max(numbers, default=0) + 1:04d}_{name}"


def render_merge(files: dict[str, Path], heads: list[str], name: str) -> tuple[str, str]:
    """Идентификатор и текст сводящей ревизии для перечисленных голов."""
    revision = next_merge_id(files, name)
    text = MERGE_TEMPLATE.format(
        heads=", ".join(heads),
        count=len(heads),
        revision=revision,
        parents=", ".join(f'"{head}"' for head in heads),
    )
    return revision, text


def slugify(text: str, limit: int = 40) -> str:
    """Слаг из описания: транслит, строчные, только латиница/цифры/подчёркивания."""
    slug = re.sub(r"[^a-z0-9]+", "_", text.strip().lower().translate(TRANSLIT)).strip("_")
    return slug[:limit].strip("_") or "migration"


def timestamp_revision_id(message: str, files: dict[str, Path]) -> str:
    """Идентификатор из метки времени UTC: `<20261105183000>_<слаг>`.

    Метка времени вместо порядкового номера — защита от той самой развилки:
    две ветки, создавшие ревизии параллельно, получают разные идентификаторы
    и не сталкиваются номерами. Если две ревизии созданы в одну секунду,
    к идентификатору добавляется `x`.
    """
    revision = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    revision = f"{revision}_{slugify(message)}"
    while revision in files:
        revision += "x"
    return revision


def write_revision(versions: Path, revision: str, text: str) -> Path:
    """Записать файл ревизии, не перезаписывая существующий."""
    path = versions / f"{revision}.py"
    if path.exists():
        raise FileExistsError(f"файл {path.name} уже существует")
    path.write_text(text, encoding="utf-8")
    return path

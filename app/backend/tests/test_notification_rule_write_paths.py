"""Инвентарь путей записи: у каждого писателя таблицы каталога есть хук правил.

Повод — два возврата код-ревью подряд (Б1, Б5, Б6): хук `notify_row_written`
забывали в одном из нескольких писателей одной и той же таблицы. Пользователь
видел правило включённым и не сломанным, но сообщения не было. Повторять это
в третий раз нельзя, поэтому тест ищет пропуск сам, а не полагается на память
разработчика или ревьюера.

Как он работает: статически (без запуска приложения) обходит объявления функций
в `app/api/*.py` и ищет маркеры записи строки таблицы каталога — конструкторы
моделей строк, присваивание `custom_values`, `setattr` по строке и динамический
`model(...)` в `process_inflow`. Каждая такая функция обязана звать
`notify_row_written`, иначе тест падает со списком имён. Образец — инвентарь
маршрутов `tests/test_route_guard_inventory.py`: новая точка записи сразу
попадает в проверку, а не в жалобу пользователя.

Обратная проверка (`test_inventory_is_not_empty`) держит сам обход: если
разметка файлов изменится и маркеров не найдётся, тест с десятком «зелёных»
пропусков не должен выглядеть успешным.
"""

import ast
from pathlib import Path
from typing import Any

API_DIR = Path(__file__).resolve().parents[1] / "app" / "api"

# Модели строк таблиц каталога: конструктор в обработчике — это новая строка.
ROW_MODELS = {
    "Resident",
    "PersonnelInflow",
    "PersonnelOutflow",
    "PaymentEntry",
    "ArchiveEntry",
    "CustomTabEntry",
}

# `model = Resident if … else PersonnelOutflow; target = model(...)` — так
# `process_inflow` выбирает таблицу назначения; по имени конструктора этого не
# видно, поэтому вызов `model(...)` тоже считается маркером.
DYNAMIC_MODEL = "model"

# Приёмники `setattr`, которые в этом API — строка таблицы каталога. Остальные
# (`plan`, `item`, `dormitory`) правят служебные объекты, а не строки таблиц.
ROW_TARGETS = {"row", "resident"}

# Имя хука. Оно же ищется в теле функции.
HOOK = "notify_row_written"

# Функции с маркером записи, которым хук не нужен, — с причиной. Пустой словарь
# не случаен: каждый новый путь либо получает хук, либо объяснение здесь, и
# мёртвую запись ловит отдельный тест.
EXEMPT: dict[str, str] = {}


def _call_name(node: ast.expr) -> str | None:
    """Имя вызываемого: `Resident(...)` и `models.Resident(...)` — оба «Resident»."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _target_name(node: ast.expr) -> str | None:
    """Имя приёмника `setattr`: `row` или `plan.resident` → «resident»."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def write_markers(function: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    """Маркеры записи строки таблицы каталога внутри одной функции."""
    markers: set[str] = set()
    for node in ast.walk(function):
        if isinstance(node, ast.Call):
            name = _call_name(node.func)
            if name in ROW_MODELS or name == DYNAMIC_MODEL:
                markers.add(str(name))
            elif name == "setattr" and node.args and _target_name(node.args[0]) in ROW_TARGETS:
                markers.add("setattr")
        if (
            isinstance(node, ast.Attribute)
            and node.attr == "custom_values"
            and isinstance(node.ctx, ast.Store)
        ):
            markers.add("custom_values")
    return markers


def calls_hook(function: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    """Зовёт ли функция сам хук."""
    return any(
        isinstance(node, ast.Call) and _call_name(node.func) == HOOK for node in ast.walk(function)
    )


def write_paths() -> dict[str, dict[str, Any]]:
    """Пути записи `файл::функция` → маркеры и признак хука.

    Обходятся только функции верхнего уровня: обработчики в этих модулях
    объявлены там, вложенных писателей строк нет.
    """
    result: dict[str, dict[str, Any]] = {}
    for path in sorted(API_DIR.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in tree.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            markers = write_markers(node)
            if markers:
                result[f"{path.name}::{node.name}"] = {
                    "markers": markers,
                    "hook": calls_hook(node),
                }
    return result


def test_every_write_path_notifies_rules() -> None:
    """Забытый хук в любой точке записи валит тест, а не тихо теряет сообщение."""
    missing = sorted(
        name
        for name, found in write_paths().items()
        if name.split("::")[1] not in EXEMPT and not found["hook"]
    )

    assert not missing, "точки записи без notify_row_written: " + ", ".join(missing)


def test_inventory_is_not_empty() -> None:
    """Обход не протух: известные пути записи обязаны находиться.

    Без этой проверки поломка разбора (переименованный модуль, отступы, другой
    способ создания строки) сделала бы основной тест пустым и «зелёным».
    """
    required = {
        # строки таблиц «Проживающие», «Отток», «Приток»
        "residents.py::create_resident",
        "residents.py::update_resident",
        "residents.py::move_to_outflow",
        "outflow.py::create_outflow",
        "outflow.py::update_outflow",
        "inflow.py::create_inflow",
        "inflow.py::create_entry",
        "inflow.py::process_inflow",
        "inflow.py::update_inflow",
        # ячейки и строки вкладок
        "table_columns.py::save_custom_cell",
        "table_columns.py::create_archive",
        "custom_tabs.py::create_row",
        # выплаты
        "payments.py::create_payment",
        "payments.py::update_payment",
        "residents.py::register_payment",
        # второй писатель таблиц каталога и перевод
        "personnel.py::create_record",
        "residents.py::transfer_resident",
    }

    assert required <= set(write_paths())


def test_exemptions_are_live() -> None:
    """Белый список не копится: каждая запись — по-прежнему путь записи."""
    dead = sorted(set(EXEMPT) - set(write_paths()))

    assert not dead, "мёртвые записи исключений: " + ", ".join(dead)

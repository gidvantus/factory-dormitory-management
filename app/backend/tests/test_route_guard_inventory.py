"""Инвентарный тест маршрутов: каждый маршрут с общежитием проходит гейт доступа.

Смысл теста — не проверить одну ручку, а сделать **невозможной** забытую проверку:
данные кабинета принадлежат организации, и каждый маршрут, который принимает
`dormitory_id`, обязан объявлять зависимость `OwnDormitory` — либо проверять
принадлежность внутри обработчика, если `dormitory_id` приходит телом запроса.
Новый маршрут без гейта валит этот тест, а не попадает в прод.

Тест идёт по приложению целиком, а не по списку модулей: список пришлось бы
обновлять руками, и он бы отстал от кода ровно там, где нужен.
"""

from collections.abc import Iterator
from typing import Any

from fastapi.routing import APIRoute

from app.access import require_own_dormitory
from app.main import app

# Ручки, у которых `dormitory_id` приходит **телом** запроса: зависимость на путь
# их не закрывает, принадлежность проверяется внутри обработчика вызовом
# `own_dormitory(db, payload.dormitory_id, membership)`. Запись здесь — обещание,
# что проверка есть; мёртвых записей не бывает, это отдельный тест.
BODY_GUARDED: dict[tuple[str, str], str] = {
    ("post", "/api/personnel/records"): "own_dormitory(db, payload.dormitory_id, membership)",
    ("post", "/api/personnel/link"): "own_dormitory(db, payload.dormitory_id, membership)",
    ("post", "/api/personnel/arrivals"): (
        "writable_dormitory → own_dormitory(db, payload.dormitory_id, membership)"
    ),
    ("put", "/api/personnel/arrivals/{plan_id}"): (
        "writable_dormitory → own_dormitory и для общежития плана, и для нового"
    ),
    ("put", "/api/personnel/employees/{employee_id}/next-shift"): (
        "own_dormitory(db, payload.dormitory_id, membership)"
    ),
    ("post", "/api/report-templates"): "own_dormitory(db, payload.dormitory_id, membership)",
    ("post", "/api/dormitory-templates"): "own_dormitory(db, payload.dormitory_id, membership)",
    ("post", "/api/dashboard/preview"): "validate_config(..., organization_id) в источнике",
    ("post", "/api/dashboard/blocks"): "validate_config(..., organization_id) в источнике",
    (
        "put",
        "/api/dashboard/blocks/{block_id}",
    ): "validate_config(..., organization_id) в источнике",
    ("post", "/api/statistics/preview"): (
        "расчёт идёт по отфильтрованному списку общежитий организации"
    ),
    ("post", "/api/statistics/reports"): "validate_blocks → validate_config с organization_id",
    (
        "put",
        "/api/statistics/reports/{report_id}",
    ): "validate_blocks → validate_config с organization_id",
}


def api_routes() -> Iterator[tuple[str, APIRoute]]:
    """Все маршруты приложения с полным путём.

    Обход рекурсивный, потому что форма хранения зависит от версии FastAPI:

    * начиная с 0.14x `include_router` кладёт в `app.routes` **обёртку**
      включённого роутера (`_IncludedRouter` с `original_router` и
      `include_context`), а сами `APIRoute` лежат внутри неё. Проверено на
      FastAPI 0.159 (образ стенда): `app.routes` — 33 обёртки и ни одного
      `APIRoute`, поэтому обход без рекурсии не нашёл бы ни одной доменной ручки;
    * в более старых версиях `include_router` копирует маршруты в приложение
      сразу с уже склеенным путём, и тогда срабатывает ветка `isinstance`.

    Что обход не протух, сторожит `test_walked_paths_match_the_documented_ones`:
    множество путей обязано совпасть с `openapi.json`. Тихая деградация обхода
    (ноль маршрутов, удвоенный префикс) валит тест, а не проходит незамеченной.
    """

    yield from _walk(app, "")


def _walk(node: Any, prefix: str) -> Iterator[tuple[str, APIRoute]]:
    for route in getattr(node, "routes", []):
        inner = getattr(route, "original_router", None)
        if inner is not None:
            # Префикс включения уже содержит префикс самого роутера.
            captured = getattr(route, "include_context", None)
            own_prefix = getattr(captured, "prefix", None) or prefix + inner.prefix
            yield from _walk(inner, own_prefix)
        elif isinstance(route, APIRoute):
            yield prefix + route.path, route


def _gated(dependant: Any) -> bool:
    """Есть ли в дереве зависимостей этого маршрута `require_own_dormitory`."""
    if getattr(dependant, "call", None) is require_own_dormitory:
        return True
    return any(_gated(child) for child in getattr(dependant, "dependencies", []))


def _schema_has_dormitory_id(schemas: dict[str, Any], name: str, seen: frozenset[str]) -> bool:
    """Есть ли в схеме (на любой глубине) поле `dormitory_id`."""
    if name in seen or name not in schemas:
        return False
    schema = schemas[name]
    properties: dict[str, Any] = schema.get("properties") or {}
    if "dormitory_id" in properties:
        return True
    nested = frozenset({*seen, name})
    return any(_value_has_dormitory_id(schemas, value, nested) for value in properties.values())


def _value_has_dormitory_id(schemas: dict[str, Any], value: Any, seen: frozenset[str]) -> bool:
    if isinstance(value, list):
        return any(_value_has_dormitory_id(schemas, item, seen) for item in value)
    if not isinstance(value, dict):
        return False
    reference = value.get("$ref")
    if (
        isinstance(reference, str)
        and reference.startswith("#/components/schemas/")
        and _schema_has_dormitory_id(schemas, reference.rsplit("/", 1)[-1], seen)
    ):
        return True
    return any(
        _value_has_dormitory_id(schemas, item, seen)
        for key, item in value.items()
        if key not in ("$ref",)
    )


def body_has_dormitory_id(operation: dict[str, Any], schemas: dict[str, Any]) -> bool:
    """Есть ли `dormitory_id` в схеме тела запроса этой операции."""
    body = operation.get("requestBody") or {}
    for media in (body.get("content") or {}).values():
        if _value_has_dormitory_id(schemas, media.get("schema") or {}, frozenset()):
            return True
    return False


def guarded_body_operations() -> set[tuple[str, str]]:
    schema = app.openapi()
    schemas = schema.get("components", {}).get("schemas", {})
    operations: set[tuple[str, str]] = set()
    for path, item in schema["paths"].items():
        for method, operation in item.items():
            if method not in ("get", "post", "put", "patch", "delete"):
                continue
            if body_has_dormitory_id(operation, schemas):
                operations.add((method, path))
    return operations


def test_walked_paths_match_the_documented_ones() -> None:
    """Обход маршрутов не протух: пути совпадают с `openapi.json` целиком.

    Проверка нужна потому, что форма хранения маршрутов в `app.routes` зависит от
    версии FastAPI: если обход перестанет видеть вложенные роутеры, остальные
    проверки этого файла станут пустыми и «зелёными». Расхождение с публичной
    схемой — единственный признак, который это ловит.
    """
    walked = {path for path, _ in api_routes()}

    assert walked == set(app.openapi()["paths"])


def test_every_dormitory_path_route_declares_the_gate() -> None:
    """Маршрут с `{dormitory_id}` в пути обязан объявлять `OwnDormitory`."""
    missing = [
        f"{sorted(route.methods or set())} {path}"
        for path, route in api_routes()
        if "{dormitory_id}" in path and not _gated(route.dependant)
    ]

    assert not missing, "маршруты без OwnDormitory: " + ", ".join(sorted(missing))


def test_every_body_with_dormitory_id_is_guarded() -> None:
    """Маршрут с `dormitory_id` в теле — под зависимостью или в белом списке."""
    by_path: dict[tuple[str, str], APIRoute] = {}
    for path, route in api_routes():
        for method in route.methods or set():
            by_path[(method.lower(), path)] = route

    unguarded = []
    for method, path in sorted(guarded_body_operations()):
        if (method, path) in BODY_GUARDED:
            continue
        guarded_route: APIRoute | None = by_path.get((method, path))
        if guarded_route is not None and _gated(guarded_route.dependant):
            continue
        unguarded.append(f"{method.upper()} {path}")

    assert not unguarded, "тело с dormitory_id без гейта: " + ", ".join(unguarded)


def test_body_guarded_list_has_no_dead_entries() -> None:
    """Белый список не копится: каждая запись — по-прежнему ручка с телом."""
    guarded = guarded_body_operations()
    dead = sorted(
        f"{method.upper()} {path}" for method, path in BODY_GUARDED if (method, path) not in guarded
    )

    assert not dead, "мёртвые записи белого списка: " + ", ".join(dead)


def test_own_dormitory_is_a_dependency_of_every_guarded_route() -> None:
    """Обратная проверка: гейт объявлен не где-то, а в зависимостях маршрута."""
    gated = [
        path for path, route in api_routes() if "{dormitory_id}" in path and _gated(route.dependant)
    ]

    assert gated, "ни один маршрут не объявляет OwnDormitory: проверка ничего не сторожит"

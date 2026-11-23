"""Контракт ответов персонала: в теле только типы JSON (#247).

`json_response` собирает тело через `json.dumps` без `default=`, поэтому дата,
`Decimal` или объект модели не «доедут» до клиента молча: сборка упадёт. Тест
держит это правило явно — и на самом обработчике, и рекурсивно на живых ответах
рабочей поверхности, страницы и рамки без карточек.
"""

import json
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api import personnel as personnel_api
from app.api.personnel import json_response
from app.personnel import today
from tests.conftest import sign_in
from tests.test_arrival_plans import create as create_arrival
from tests.test_personnel import API, create, workspace
from tests.test_reports import create_dormitory

JSON_TYPES = (str, int, float, bool, type(None))
PAGE = API + "/employees"


def json_native(value: Any, path: str = "response") -> None:
    """Рекурсивная проверка: ни дат, ни Decimal, ни объектов SQLAlchemy."""
    if isinstance(value, dict):
        for key, item in value.items():
            assert isinstance(key, str), f"{path}: ключ {key!r} — не строка"
            json_native(item, f"{path}.{key}")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            json_native(item, f"{path}[{index}]")
        return
    assert not isinstance(value, (date, datetime, Decimal)), (
        f"{path}: значение {value!r} не сериализуется без `default=`"
    )
    assert isinstance(value, JSON_TYPES), f"{path}: тип {type(value).__name__} не из JSON"


def test_json_response_writes_compact_json_and_refuses_other_types() -> None:
    """`json_response` не прячет ошибку данных за `default=str` или `NaN`."""
    response = json_response({"имя": "Иванов", "число": 1, "ok": True})
    assert (
        response.body
        == json.dumps(
            {"имя": "Иванов", "число": 1, "ok": True}, ensure_ascii=False, separators=(",", ":")
        ).encode()
    )
    assert response.media_type == "application/json"
    with pytest.raises(TypeError):
        json_response({"today": today()})
    with pytest.raises(TypeError):
        json_response({"total": Decimal("1.5")})
    with pytest.raises(ValueError):
        json_response({"ratio": float("nan")})


def test_workspace_and_page_serialise_their_bodies_themselves(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Главный выигрыш тикета держится тестом, а не честным словом.

    `return result` вместо `return json_response(result)` даёт байт в байт то же
    тело (Starlette сериализует так же), поэтому проверки содержимого этого не
    заметят, а `jsonable_encoder` вернётся незамеченным. Здесь считаются вызовы:
    и поверхность, и страница обязаны собирать тело через `json_response`, иначе
    их ответы снова уходят через энкодер FastAPI.
    """
    sign_in(client, db_session)
    create_dormitory(client)
    calls: list[Any] = []

    def counted(payload: Any) -> Any:
        calls.append(payload)
        return json_response(payload)

    monkeypatch.setattr(personnel_api, "json_response", counted)
    assert client.get(API).status_code == 200
    assert len(calls) == 1, "поверхность должна собирать тело через json_response"
    body = calls[0]
    assert set(body) >= {"employees", "dormitories", "today"}
    calls.clear()
    response = client.get(PAGE)
    assert response.status_code == 200
    assert len(calls) == 1, "страница должна собирать тело через json_response"
    # Договор прежний — поменялся только путь сборки тела.
    assert set(response.json()) == {"items", "total", "page", "per_page", "pages"}


def test_workspace_and_page_contain_only_json_types(
    client: TestClient, db_session: Session
) -> None:
    """Даты планов, заездов и настроек уходят строками, а не объектами `date`."""
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    row = create(
        client,
        dorm,
        values={
            "shift_start": str(today() - timedelta(days=10)),
            "shift_end": str(today() + timedelta(days=3)),
        },
    )
    assert (
        client.put(
            f"{API}/employees/{row['employee_id']}/next-shift",
            json={
                "date": str(today() + timedelta(days=5)),
                "end": str(today() + timedelta(days=35)),
                "dormitory_id": dorm,
                "confirmed": True,
            },
        ).status_code
        == 200
    )
    create_arrival(client, dorm, str(today() + timedelta(days=2)))
    json_native(workspace(client))
    json_native(client.get(PAGE).json())
    json_native(client.get(API, params={"employees": "none"}).json())
    # Даты в ответе — ровно `YYYY-MM-DD`, как у прежнего энкодера FastAPI.
    data = workspace(client)
    assert data["today"] == str(today())
    assert data["plans"][0]["date"] == str(today() + timedelta(days=5))
    assert data["arrival_plans"][0]["date"] == str(today() + timedelta(days=2))

"""Изоляция данных кабинета: чужое общежитие неразличимо с несуществующим.

Данные принадлежат организации, точка правды одна — `dormitories.organization_id`.
Поэтому у каждой ручки, принимающей общежитие, чужой объект отвечает **тем же**
`404` «Общежитие не найдено», что и несуществующий: иначе по коду ответа было бы
видно, что объект с таким номером существует. `403` здесь не используется
намеренно — он остаётся за неактивированным кабинетом и ролью без права правки.
"""

from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.dormitory import Dormitory
from app.models.user import User
from tests.conftest import login, sign_in

DORMITORY_NOT_FOUND = "Общежитие не найдено"
PERIOD = "from=2026-10-01&to=2026-10-02"
MONTH = "2026-10-01"

# Ядро задачи: по одному чтению на каждый модуль, у которого в пути есть
# `{dormitory_id}`. Инвентарный тест (`test_route_guard_inventory.py`) следит,
# чтобы список модулей не пришлось пополнять вручную: он идёт по маршрутам.
FOREIGN_READS = [
    "/api/dormitories/{id}",
    "/api/dormitories/{id}/tabs",
    "/api/dormitories/{id}/settings",
    f"/api/dormitories/{{id}}/hostels?{PERIOD}",
    "/api/dormitories/{id}/hostels/sources",
    f"/api/dormitories/{{id}}/inflow?{PERIOD}",
    f"/api/dormitories/{{id}}/outflow?{PERIOD}",
    f"/api/dormitories/{{id}}/payments/advance?{PERIOD}",
    f"/api/dormitories/{{id}}/payments/settlement?{PERIOD}",
    "/api/personnel/bindings/{id}/residents",
    f"/api/dormitories/{{id}}/report?{PERIOD}",
    "/api/dormitories/{id}/report-readiness",
    f"/api/dormitories/{{id}}/residents?month={MONTH}",
    "/api/dormitories/{id}/sections",
    "/api/dormitories/{id}/tables/residents/columns",
    "/api/dormitories/{id}/tables/archive/rows?from=2026-10-01&to=2026-10-02",
]


@dataclass(frozen=True)
class Cabinets:
    """Два кабинета в двух организациях: своё и чужое общежитие."""

    own: int
    foreign: int
    first: User
    second: User


def two_cabinets(client: TestClient, db_session: Session) -> Cabinets:
    """Два кабинета в двух организациях; в каждом — своё общежитие."""
    first = sign_in(client, db_session, email="first@example.com")
    own = client.post("/api/dormitories", json={"name": "Северное", "client_name": "Клиент"})
    assert own.status_code == 201, own.text
    client.post("/api/auth/logout")

    second = sign_in(client, db_session, email="second@example.com")
    foreign = client.post("/api/dormitories", json={"name": "Южное", "client_name": "Клиент"})
    assert foreign.status_code == 201, foreign.text
    client.post("/api/auth/logout")

    # Первый кабинет смотрит на общежитие второго.
    assert login(client, str(first.email)).status_code == 200
    return Cabinets(
        own=own.json()["id"],
        foreign=foreign.json()["id"],
        first=first,
        second=second,
    )


@pytest.fixture
def cabinets(client: TestClient, db_session: Session) -> Cabinets:
    return two_cabinets(client, db_session)


@pytest.mark.parametrize("template", FOREIGN_READS)
def test_foreign_dormitory_reads_as_missing(
    client: TestClient, cabinets: Cabinets, template: str
) -> None:
    foreign = cabinets.foreign
    response = client.get(template.format(id=foreign))
    missing = client.get(template.format(id=2147483647))

    assert response.status_code == 404, (template, response.text)
    assert missing.status_code == 404, (template, missing.text)
    assert response.json() == missing.json()
    assert DORMITORY_NOT_FOUND in response.json()["detail"]


@pytest.mark.parametrize("template", FOREIGN_READS)
def test_own_dormitory_stays_readable(
    client: TestClient, cabinets: Cabinets, template: str
) -> None:
    response = client.get(template.format(id=cabinets.own))

    assert response.status_code == 200, (template, response.text)


def test_foreign_dormitory_cannot_be_changed(client: TestClient, cabinets: Cabinets) -> None:
    foreign = cabinets.foreign

    patched = client.patch(f"/api/dormitories/{foreign}", json={"name": "Переименовано"})
    assert patched.status_code == 404, patched.text
    assert client.delete(f"/api/dormitories/{foreign}/sections/report").status_code == 404
    assert (
        client.patch(f"/api/dormitories/{foreign}/tabs/1", json={"is_active": False}).status_code
        == 404
    )


def test_foreign_dormitory_in_body_is_not_found(client: TestClient, cabinets: Cabinets) -> None:
    """`dormitory_id` приходит телом — зависимость на путь такие ручки не закрывает."""
    foreign = cabinets.foreign
    identity = {"mode": "new", "full_name": "Иванов Иван", "check_token": "0" * 64}

    record = client.post(
        "/api/personnel/records",
        json={"dormitory_id": foreign, "table_key": "residents", "identity": identity},
    )
    assert record.status_code == 404, record.text

    link = client.post(
        "/api/personnel/link",
        json={
            "dormitory_id": foreign,
            "table_key": "residents",
            "row_id": 1,
            "identity": identity,
        },
    )
    assert link.status_code == 404, link.text

    shift = client.put(
        f"/api/personnel/employees/{'0' * 8}-0000-0000-0000-{'0' * 12}/next-shift",
        json={
            "date": "2026-10-01",
            "end": "2026-11-01",
            "dormitory_id": foreign,
        },
    )
    assert shift.status_code == 404, shift.text

    template = client.post(
        "/api/dormitory-templates", json={"name": "Снимок", "dormitory_id": foreign}
    )
    assert template.status_code == 404, template.text

    report_template = client.post(
        "/api/report-templates", json={"name": "Отчёт", "dormitory_id": foreign}
    )
    assert report_template.status_code == 404, report_template.text

    arrival = client.post(
        "/api/personnel/arrivals",
        json={"date": "2026-10-01", "dormitory_id": foreign, "count": 1},
    )
    assert arrival.status_code == 404, arrival.text


def test_foreign_dormitory_as_a_block_source_is_not_found(
    client: TestClient, cabinets: Cabinets
) -> None:
    foreign = cabinets.foreign
    config = {
        "name": "Блок",
        "source_kind": "report",
        "sources": [{"kind": "report", "dormitory_id": foreign, "row_id": 1}],
    }

    preview = client.post(f"/api/dashboard/preview?{PERIOD}", json=config)
    assert preview.status_code == 404, preview.text

    block = client.post("/api/dashboard/blocks", json={"revision": 0, "config": config})
    assert block.status_code == 404, block.text

    # Предпросмотр статистики считает по списку общежитий своей организации:
    # чужой источник в расчёт не попадает вовсе.
    statistics = client.post(
        f"/api/statistics/preview?{PERIOD}",
        json={"id": "block", "name": "Блок", "query": config},
    )
    assert statistics.status_code == 200, statistics.text
    assert foreign not in [line["dormitory_id"] for line in statistics.json()["series"]]

    # Сохранить такой отчёт нельзя: при сохранении источники проверяются.
    saved = client.post(
        "/api/statistics/reports",
        json={
            "name": "Отчёт",
            "blocks": [{"id": "block", "name": "Блок", "query": config}],
        },
    )
    assert saved.status_code == 404, saved.text


def test_transfer_to_a_foreign_dormitory_is_not_found(
    client: TestClient, cabinets: Cabinets
) -> None:
    own = cabinets.own
    foreign = cabinets.foreign
    created = client.post(f"/api/dormitories/{own}/residents")
    assert created.status_code == 201, created.text
    resident = created.json()["id"]

    response = client.post(
        f"/api/dormitories/{own}/residents/{resident}/transfer",
        json={
            "target_dormitory_id": foreign,
            "month": MONTH,
            "preview_token": "0" * 64,
        },
    )

    assert response.status_code == 404, response.text
    assert response.json()["detail"] == DORMITORY_NOT_FOUND


def test_lists_show_only_the_own_organization(client: TestClient, cabinets: Cabinets) -> None:
    own = cabinets.own

    listed = client.get("/api/dormitories").json()
    assert [item["id"] for item in listed] == [own]

    dashboard = client.get(f"/api/dashboard?{PERIOD}").json()
    assert [int(item["id"]) for item in dashboard["dormitories"]] == [own]

    # Каталоги источников перечисляют общежития — только свои.
    for url in ("/api/statistics/sources", "/api/dashboard/sources"):
        catalog = client.get(url).json()
        assert [item["id"] for item in catalog] == [own], url

    # Каталог вкладок: варианты структуры только из своего общежития.
    catalog_ids = {
        variant["dormitory_id"]
        for item in client.get("/api/dormitory-tab-catalog").json()
        for variant in item["variants"]
        if variant["dormitory_id"] is not None
    }
    assert catalog_ids <= {own}

    # Библиотека шаблонов вкладок: чужое общежитие не упоминается.
    templates = client.get("/api/custom-tab-templates").json()
    assert all(item["dormitory_name"] != "Южное" for item in templates)


def test_personnel_workspace_shows_only_the_own_organization(
    client: TestClient, cabinets: Cabinets
) -> None:
    own = cabinets.own
    # Строка персонала в своём общежитии: карточка сотрудника видна только в нём.
    created = client.post(f"/api/dormitories/{own}/residents")
    assert created.status_code == 201, created.text

    workspace = client.get("/api/personnel").json()

    assert [item["id"] for item in workspace["dormitories"]] == [own]
    assert all(
        source["dormitory_id"] == own
        for employee in workspace["employees"]
        for source in employee["sources"]
    )


def test_dormitory_without_an_organization_cannot_exist() -> None:
    """Остаток без организации отсекает схема, а не код: колонка `NOT NULL`.

    Миграция `0043_dormitories_organization` сначала привязывает существующие
    общежития, а при остатке останавливается с перечнем `id` — тихо спрятать
    такие общежития было бы потерей данных. Поэтому в работающей схеме строки без
    организации нет, и «ничего не видно» обеспечивается на уровне ограничения.
    """
    assert Dormitory.__table__.c.organization_id.nullable is False


def test_isolation_is_one_way(client: TestClient, cabinets: Cabinets) -> None:
    """Вторая организация видит только своё — гейт не зависит от порядка входа."""
    client.post("/api/auth/logout")
    assert login(client, cabinets.second.email).status_code == 200

    assert [item["id"] for item in client.get("/api/dormitories").json()] == [cabinets.foreign]
    assert client.get(f"/api/dormitories/{cabinets.own}").status_code == 404


def as_cabinet(client: TestClient, cabinets: Cabinets, which: str) -> None:
    """Сменить активный кабинет в тесте: клиент хранит cookie сам."""
    client.post("/api/auth/logout")
    user = cabinets.second if which == "second" else cabinets.first
    assert login(client, user.email).status_code == 200


def test_foreign_tab_cannot_be_a_copy_source(client: TestClient, cabinets: Cabinets) -> None:
    """Образец вкладки приходит телом (`source_tab_id`), поэтому гейт пути его не закрывает."""
    as_cabinet(client, cabinets, "second")
    created = client.post(
        f"/api/dormitories/{cabinets.foreign}/tabs", json={"name": "Чужая вкладка"}
    )
    assert created.status_code == 201, created.text
    foreign_tab = created.json()["id"]

    as_cabinet(client, cabinets, "first")
    response = client.post(
        f"/api/dormitories/{cabinets.own}/tabs",
        json={"name": "Скопировано", "source_tab_id": foreign_tab},
    )

    assert response.status_code == 404, response.text
    assert response.json()["detail"] == DORMITORY_NOT_FOUND
    names = [tab["name"] for tab in client.get(f"/api/dormitories/{cabinets.own}/tabs").json()]
    assert "Скопировано" not in names


def test_structure_of_a_foreign_dormitory_is_not_copied(
    client: TestClient, cabinets: Cabinets
) -> None:
    """`source_id` вида `standard:<чужое id>:<раздел>` не должен находить образец."""
    foreign_variant = f"standard:{cabinets.foreign}:residents"

    rejected = client.post(
        "/api/dormitories",
        json={
            "name": "Новое из чужого",
            "client_name": "Клиент",
            "tabs": [{"source_id": foreign_variant}],
        },
    )

    # Тот же ответ, что и на несуществующий образец: чужое и отсутствующее неразличимы.
    assert rejected.status_code == 409, rejected.text
    assert [item["id"] for item in client.get("/api/dormitories").json()] == [cabinets.own]

    # Свой образец при этом работает — проверка про принадлежность, а не про формат.
    own_variant = f"standard:{cabinets.own}:residents"
    accepted = client.post(
        "/api/dormitories",
        json={
            "name": "Новое из своего",
            "client_name": "Клиент",
            "tabs": [{"source_id": own_variant}],
        },
    )
    assert accepted.status_code == 201, accepted.text


def test_foreign_structure_templates_are_invisible(client: TestClient, cabinets: Cabinets) -> None:
    """Библиотека шаблонов структуры: чужой шаблон не читается и не удаляется."""
    as_cabinet(client, cabinets, "second")
    created = client.post(
        "/api/dormitory-templates",
        json={"name": "Чужая структура", "dormitory_id": cabinets.foreign},
    )
    assert created.status_code == 201, created.text
    foreign_template = created.json()["id"]

    as_cabinet(client, cabinets, "first")
    assert [item["id"] for item in client.get("/api/dormitory-templates").json()] == []
    assert client.get(f"/api/dormitory-templates/{foreign_template}").status_code == 404
    applied = client.post(
        "/api/dormitories",
        json={
            "name": "Из чужого шаблона",
            "client_name": "Клиент",
            "structure_template_id": foreign_template,
        },
    )
    assert applied.status_code == 404, applied.text
    assert client.delete(f"/api/dormitory-templates/{foreign_template}").status_code == 404
    assert [item["id"] for item in client.get("/api/dormitories").json()] == [cabinets.own]

    # Шаблон на месте: чужая библиотека не изменилась.
    as_cabinet(client, cabinets, "second")
    assert [item["id"] for item in client.get("/api/dormitory-templates").json()] == [
        foreign_template
    ]

"""Изоляция корневых объектов без общего корня-общежития.

Шаблоны структуры (`dormitory_templates`), шаблоны отчёта (`report_templates`) и
сохранённые отчёты статистики (`statistics_reports`) живут у организации, а не у
общежития, поэтому проверка `{dormitory_id}` их не закрывает. Правило то же, что и
у остальных данных кабинета: организация берётся из сессии, чужой объект
неразличим с несуществующим — **`404`, никогда `403`** — и `organization_id` не
появляется в ответах API.

Библиотека второй организации собирается один раз (фикстура `library`), а тесты
смотрят на неё из первого кабинета: так проверяется именно граница, а не порядок
создания.
"""

from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.dormitory_template import DormitoryTemplate
from app.models.report_template import ReportTemplate
from app.models.statistics_report import StatisticsReport
from app.models.user import User
from tests.conftest import login, sign_in

REPORT_TEMPLATES = "/api/report-templates"
STRUCTURE_TEMPLATES = "/api/dormitory-templates"
REPORTS = "/api/statistics/reports"

# Один текст на «шаблона нет» и «шаблон чужой»: чужое и отсутствующее неразличимы.
TEMPLATE_NOT_FOUND = "Шаблон не найден"
REPORT_NOT_FOUND = "Отчёт не найден"
MISSING_ID = 2147483647


@dataclass(frozen=True)
class Cabinets:
    """Два кабинета в двух организациях: своё и чужое общежитие."""

    own: int
    foreign: int
    first: User
    second: User


@dataclass(frozen=True)
class Library:
    """Библиотека второй организации: её шаблоны и сохранённые отчёты."""

    report_template: int
    structure_template: int
    shared_report: int
    personal_report: int


def as_cabinet(client: TestClient, cabinets: Cabinets, which: str) -> None:
    """Сменить активный кабинет в тесте: клиент хранит cookie сам."""
    client.post("/api/auth/logout")
    user = cabinets.second if which == "second" else cabinets.first
    assert login(client, user.email).status_code == 200


@pytest.fixture
def cabinets(client: TestClient, db_session: Session) -> Cabinets:
    """Два кабинета в двух организациях; в каждом — своё общежитие."""
    first = sign_in(client, db_session, email="first@example.com")
    own = client.post("/api/dormitories", json={"name": "Северное", "client_name": "Клиент"})
    assert own.status_code == 201, own.text
    client.post("/api/auth/logout")

    second = sign_in(client, db_session, email="second@example.com")
    foreign = client.post("/api/dormitories", json={"name": "Южное", "client_name": "Клиент"})
    assert foreign.status_code == 201, foreign.text
    client.post("/api/auth/logout")

    # Первый кабинет смотрит на объекты второго.
    assert login(client, str(first.email)).status_code == 200
    return Cabinets(own=own.json()["id"], foreign=foreign.json()["id"], first=first, second=second)


@pytest.fixture
def library(client: TestClient, cabinets: Cabinets) -> Library:
    """Объекты второй организации, созданные до того, как смотрит первый кабинет."""
    as_cabinet(client, cabinets, "second")
    report_template = client.post(
        REPORT_TEMPLATES, json={"name": "Стандарт отчёта", "dormitory_id": cabinets.foreign}
    )
    assert report_template.status_code == 201, report_template.text
    structure_template = client.post(
        STRUCTURE_TEMPLATES, json={"name": "Стандарт структуры", "dormitory_id": cabinets.foreign}
    )
    assert structure_template.status_code == 201, structure_template.text
    shared = client.post(REPORTS, json={"name": "Общий отчёт", "blocks": []})
    assert shared.status_code == 201, shared.text
    personal = client.post(
        REPORTS, json={"name": "Личный отчёт", "blocks": [], "visibility": "personal"}
    )
    assert personal.status_code == 201, personal.text
    as_cabinet(client, cabinets, "first")
    return Library(
        report_template=report_template.json()["id"],
        structure_template=structure_template.json()["id"],
        shared_report=shared.json()["id"],
        personal_report=personal.json()["id"],
    )


def test_libraries_of_another_organization_are_invisible(
    client: TestClient, cabinets: Cabinets, library: Library
) -> None:
    """Списки не содержат чужих объектов, и `organization_id` в ответах нет."""
    assert client.get(REPORT_TEMPLATES).json() == []
    assert client.get(STRUCTURE_TEMPLATES).json() == []
    assert client.get(REPORTS).json() == []

    # Свой объект в ответе есть — проверка про принадлежность, а не про пустоту.
    own = client.post(REPORT_TEMPLATES, json={"name": "Свой", "dormitory_id": cabinets.own})
    assert own.status_code == 201, own.text
    listed = client.get(REPORT_TEMPLATES).json()
    assert [item["id"] for item in listed] == [own.json()["id"]]
    assert all("organization_id" not in item for item in listed)

    report = client.post(REPORTS, json={"name": "Свой отчёт", "blocks": []})
    assert report.status_code == 201, report.text
    assert "organization_id" not in report.json()


@pytest.mark.parametrize(
    ("base", "attribute"),
    [(REPORT_TEMPLATES, "report_template"), (STRUCTURE_TEMPLATES, "structure_template")],
)
def test_foreign_template_is_read_and_deleted_as_missing(
    client: TestClient, cabinets: Cabinets, library: Library, base: str, attribute: str
) -> None:
    """`GET` и `DELETE` чужого шаблона — тот же `404`, что и у несуществующего."""
    foreign = getattr(library, attribute)
    assert foreign != MISSING_ID

    read = client.get(f"{base}/{foreign}")
    missing_read = client.get(f"{base}/{MISSING_ID}")
    assert read.status_code == 404, read.text
    assert read.json() == missing_read.json()
    assert read.json()["detail"] == TEMPLATE_NOT_FOUND

    deleted = client.delete(f"{base}/{foreign}")
    missing_deleted = client.delete(f"{base}/{MISSING_ID}")
    assert deleted.status_code == 404, deleted.text
    assert deleted.json() == missing_deleted.json()

    # Чужая библиотека не изменилась: шаблон на месте.
    as_cabinet(client, cabinets, "second")
    assert client.get(f"{base}/{foreign}").status_code == 200
    as_cabinet(client, cabinets, "first")


def test_foreign_report_template_is_not_applied(
    client: TestClient, cabinets: Cabinets, library: Library
) -> None:
    """`POST /api/dormitories` с чужим `template_id` общежитие не создаёт."""
    created = client.post(
        "/api/dormitories",
        json={
            "name": "Из чужого шаблона отчёта",
            "client_name": "Клиент",
            "template_id": library.report_template,
        },
    )
    missing = client.post(
        "/api/dormitories",
        json={"name": "Из несуществующего", "client_name": "Клиент", "template_id": MISSING_ID},
    )
    assert created.status_code == 404, created.text
    assert created.json() == missing.json()
    assert created.json()["detail"] == TEMPLATE_NOT_FOUND

    created = client.post(
        "/api/dormitories",
        json={
            "name": "Из чужого шаблона структуры",
            "client_name": "Клиент",
            "structure_template_id": library.structure_template,
        },
    )
    assert created.status_code == 404, created.text
    assert created.json()["detail"] == TEMPLATE_NOT_FOUND
    assert [item["id"] for item in client.get("/api/dormitories").json()] == [cabinets.own]


def test_foreign_statistics_reports_are_invisible(client: TestClient, library: Library) -> None:
    """`shared`-отчёт чужой организации не виден, и `personal` тоже."""
    for report_id in (library.shared_report, library.personal_report):
        response = client.get(f"{REPORTS}/{report_id}")
        missing = client.get(f"{REPORTS}/{MISSING_ID}")
        assert response.status_code == 404, response.text
        assert response.json() == missing.json()
        assert response.json()["detail"] == REPORT_NOT_FOUND

        data = client.get(f"{REPORTS}/{report_id}/data?from=2026-10-01&to=2026-10-02")
        assert data.status_code == 404, data.text
        assert data.json() == missing.json()


def test_same_template_names_are_allowed_in_different_organizations(
    client: TestClient, cabinets: Cabinets, library: Library
) -> None:
    """Имя уникально внутри организации: две организации могут назвать шаблоны одинаково."""
    report = client.post(
        REPORT_TEMPLATES, json={"name": "Стандарт отчёта", "dormitory_id": cabinets.own}
    )
    assert report.status_code == 201, report.text
    structure = client.post(
        STRUCTURE_TEMPLATES, json={"name": "Стандарт структуры", "dormitory_id": cabinets.own}
    )
    assert structure.status_code == 201, structure.text

    # Внутри организации дубль по-прежнему 409.
    assert (
        client.post(
            REPORT_TEMPLATES,
            json={"name": "стандарт отчёта", "dormitory_id": cabinets.own},
        ).status_code
        == 409
    )
    assert (
        client.post(
            STRUCTURE_TEMPLATES, json={"name": "Стандарт структуры", "dormitory_id": cabinets.own}
        ).status_code
        == 409
    )


def test_root_objects_carry_an_organization_column() -> None:
    """Принадлежность — колонка у объекта; `NULL` не запрещён: объект не видно никому."""
    for model in (ReportTemplate, DormitoryTemplate, StatisticsReport):
        column = model.__table__.c.organization_id
        assert column.nullable is True, model.__tablename__
        assert column.index is True, model.__tablename__


def test_isolation_is_one_way(client: TestClient, cabinets: Cabinets, library: Library) -> None:
    """Вторая организация видит только своё — гейт не зависит от порядка входа."""
    as_cabinet(client, cabinets, "second")

    assert [item["id"] for item in client.get(REPORT_TEMPLATES).json()] == [library.report_template]
    assert [item["id"] for item in client.get(STRUCTURE_TEMPLATES).json()] == [
        library.structure_template
    ]
    assert {item["id"] for item in client.get(REPORTS).json()} == {
        library.shared_report,
        library.personal_report,
    }
    assert client.get(f"{REPORT_TEMPLATES}/{library.report_template}").status_code == 200

"""Публичные документы сервиса (issue #33).

Критерии готовности разложены по блокам:

* обе ручки открыты анониму: без cookie приходит 200, а не 401, и 401 в схеме
  у них не объявлен;
* список отсортирован по `position`, затем по `code`, и отдаёт только `code` и
  `title` — тексты документов в список не попадают;
* документ по коду отдаёт непустые `title` и `body` и `updated_at`;
* неизвестный код — 404 с текстом «Документ не найден», и код 404 объявлен в
  `/openapi.json` для этой операции (см. `tests/test_openapi_contract.py`).

Строки тест заводит сам: в тестах схема создаётся из моделей, миграции не
выполняются, и сид из `0017_documents` здесь не появится. Порядок из миграции
проверяется отдельным тестом на её данные, без базы.
"""

from datetime import datetime
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.document import Document

MIGRATION_PATH = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0017_documents.py"

# Те же три документа, что сеет миграция, но с другим порядком вставки: список
# обязан сортироваться по `position`, а не отдавать строки как попало.
SEED = [
    ("terms-of-use", "Правила использования системы", 1),
    ("offer", "Оферта для организации", 2),
    ("privacy-policy", "Политика конфиденциальности", 0),
]


def add_document(
    db_session: Session,
    code: str = "privacy-policy",
    title: str = "Политика конфиденциальности",
    body: str = "Первый абзац.\n\nВторой абзац.",
    position: int = 0,
) -> Document:
    """Документ прямо в базе: публичная ручка не требует, чтобы его кто-то создал через API."""
    document = Document(code=code, title=title, body=body, position=position)
    db_session.add(document)
    db_session.commit()
    db_session.refresh(document)
    return document


def add_seed(db_session: Session) -> None:
    """Три документа из миграции, вставленные вразнобой по `position`."""
    for code, title, position in SEED:
        db_session.add(
            Document(code=code, title=title, body=f"Текст документа {code}.", position=position)
        )
    db_session.commit()


def documented_statuses(client: TestClient, path: str, method: str) -> set[str]:
    """Коды ответов, объявленные для операции в опубликованной схеме."""
    schema = client.get("/openapi.json").json()
    return set(schema["paths"][path][method]["responses"])


# --- GET /api/documents ------------------------------------------------------


def test_list_is_open_to_anonymous(client: TestClient, db_session: Session) -> None:
    """Без cookie список отдаётся: 401 здесь сломал бы страницу документа у анонима."""
    add_seed(db_session)

    response = client.get("/api/documents")

    assert response.status_code == 200, response.text
    assert "401" not in documented_statuses(client, "/api/documents", "get")
    # 403 у публичной ручки не документируется: кабинет не активирован — это про
    # рабочие ручки, а документы открыты всем (см. tests/test_inactive_guard.py).
    assert "403" not in documented_statuses(client, "/api/documents", "get")


def test_list_is_ordered_by_position(db_session: Session, client: TestClient) -> None:
    add_seed(db_session)

    payload = client.get("/api/documents").json()

    assert [item["code"] for item in payload] == ["privacy-policy", "terms-of-use", "offer"]
    assert [item["title"] for item in payload] == [
        "Политика конфиденциальности",
        "Правила использования системы",
        "Оферта для организации",
    ]


def test_list_breaks_position_ties_by_code(client: TestClient, db_session: Session) -> None:
    """Одинаковый `position` — порядок всё равно устойчив: вторым ключом идёт `code`."""
    add_document(db_session, code="offer", title="Оферта", position=5)
    add_document(db_session, code="privacy-policy", title="Политика", position=5)

    payload = client.get("/api/documents").json()

    assert [item["code"] for item in payload] == ["offer", "privacy-policy"]


def test_list_keeps_bodies_out(client: TestClient, db_session: Session) -> None:
    """Список — оглавление: текст документа в нём не нужен и не отдаётся."""
    add_seed(db_session)

    payload = client.get("/api/documents").json()

    assert payload
    assert all(set(item) == {"code", "title"} for item in payload)


def test_list_is_empty_without_documents(client: TestClient) -> None:
    """Пустая таблица — пустой массив, а не 404: оглавление просто ничего не показывает."""
    response = client.get("/api/documents")

    assert response.status_code == 200
    assert response.json() == []


# --- GET /api/documents/{code} ----------------------------------------------


def test_document_is_open_to_anonymous(client: TestClient, db_session: Session) -> None:
    add_document(db_session)

    response = client.get("/api/documents/privacy-policy")

    assert response.status_code == 200, response.text
    assert "401" not in documented_statuses(client, "/api/documents/{code}", "get")
    assert "403" not in documented_statuses(client, "/api/documents/{code}", "get")


def test_document_returns_title_body_and_updated_at(
    client: TestClient, db_session: Session
) -> None:
    add_document(
        db_session,
        title="Политика конфиденциальности",
        body="Первый абзац.\n\nВторой абзац.",
    )

    payload = client.get("/api/documents/privacy-policy").json()

    assert payload["code"] == "privacy-policy"
    assert payload["title"] == "Политика конфиденциальности"
    assert payload["body"] == "Первый абзац.\n\nВторой абзац."
    assert payload["updated_at"]


def test_document_updated_at_is_stored_time(client: TestClient, db_session: Session) -> None:
    """`updated_at` отдаёт база: клиент его не присылает и не подменяет.

    Сравнение идёт по моменту времени, а не по тексту ответа: на стенде PostgreSQL
    возвращает значение с зоной, а в юнит-тестах SQLite — без неё, и требовать
    `+00:00` в строке значило бы проверять диалект базы, а не поведение ручки.
    """
    moment = datetime(2026, 5, 1, 12, 0)
    document = add_document(db_session)
    document.updated_at = moment
    db_session.commit()

    payload = client.get(f"/api/documents/{document.code}").json()

    assert datetime.fromisoformat(payload["updated_at"]).replace(tzinfo=None) == moment


def test_unknown_code_is_404_with_detail(client: TestClient, db_session: Session) -> None:
    add_seed(db_session)

    response = client.get("/api/documents/unknown")

    assert response.status_code == 404
    assert response.json()["detail"] == "Документ не найден"
    assert "404" in documented_statuses(client, "/api/documents/{code}", "get")


def test_unknown_code_is_404_without_401(client: TestClient) -> None:
    """Аноним получает 404, а не 401.

    Без этого клиент не отличил бы «нет документа» от «нет сессии» и показал бы
    страницу входа вместо понятного «Документ не найден».
    """
    response = client.get("/api/documents/unknown")

    assert response.status_code == 404
    assert response.headers.get("www-authenticate") is None


def test_document_code_is_case_sensitive(client: TestClient, db_session: Session) -> None:
    """Код приходит из адреса: регистр значим, иначе ссылка из подвала вела бы не туда."""
    add_document(db_session, code="offer", title="Оферта")

    assert client.get("/api/documents/offer").status_code == 200
    assert client.get("/api/documents/Offer").status_code == 404


# --- Сид миграции ------------------------------------------------------------


def load_migration() -> ModuleType:
    """Прочитать ревизию по пути, а не импортом: `alembic` — имя установленного пакета.

    Каталог `alembic/versions` в проекте не пакет, и импорт по имени разрешился бы
    в библиотеку alembic из site-packages, а не в файл миграции.
    """
    spec = spec_from_file_location("documents_migration", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_seeds_three_documents_in_order() -> None:
    """Сид из `0017_documents`: коды, заголовки и порядок — по данным ревизии."""
    migration = load_migration()

    assert [row["code"] for row in migration.DOCUMENT_ROWS] == [
        "privacy-policy",
        "terms-of-use",
        "offer",
    ]
    assert [row["position"] for row in migration.DOCUMENT_ROWS] == [0, 1, 2]
    assert [row["title"] for row in migration.DOCUMENT_ROWS] == [
        "Политика конфиденциальности",
        "Правила использования системы",
        "Оферта для организации",
    ]


def test_migration_seeds_documents_with_paragraphs() -> None:
    """Текст каждого документа — 3–5 абзацев plain text, разделённых пустой строкой."""
    migration = load_migration()

    for row in migration.DOCUMENT_ROWS:
        paragraphs = row["body"].split("\n\n")
        assert 3 <= len(paragraphs) <= 5, row["code"]
        assert all(paragraph.strip() for paragraph in paragraphs), row["code"]
        assert "<" not in row["body"]


def test_migration_sits_on_top_of_current_head() -> None:
    """Ревизия продолжает текущую голову: в develop-m уже есть своя `0017_tariffs`."""
    migration = load_migration()

    assert migration.revision == "0025_documents"
    assert migration.down_revision == "0024_merge_develop_s"
    assert len(migration.revision) < 32

"""Неактивный аккаунт: кабинет закрыт 403, открыты только /api/me и активация.

Список рабочих ручек не дублируется руками: он берётся из `/openapi.json`,
поэтому новая ручка без `ActiveUser` уронит этот тест.
"""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.security import ACTIVATION_REQUIRED_DETAIL, issue_activation_token
from tests.conftest import create_user, login, organizations_for

# Свободные от guard адреса: вход, регистрация, активация, здоровье, /api/me,
# публичный прайс (`GET /api/tariffs`, страница `/pricing`) и его параметры
# докупки мест (`GET /api/tariffs/extra-seats`, #177 — та же публичная страница
# показывает таблицу ступеней), а также публичные документы
# (`GET /api/documents`, `/api/documents/{code}`, страница `/documents/<код>`).
# Всё это открыто анониму, и неактивированный кабинет здесь ничего не меняет.
EXEMPT_PREFIXES = ("/api/auth", "/api/health")
EXEMPT_PATHS = frozenset(
    {
        "/api/me",
        "/api/tariffs",
        # Ступени скидки за места — часть публичного прайса: их читает страница
        # `/pricing`, открытая анониму. Закрывать их guard'ом кабинета значило бы
        # спрятать половину витрины от человека без аккаунта.
        "/api/tariffs/extra-seats",
        "/api/documents",
        "/api/documents/{code}",
        # Ручки бота Telegram: это не операции кабинета, а служебный интерфейс
        # бота. Авторизация у них своя — сервисный токен в заголовке
        # `X-Bot-Token` (401 на неверный токен), — поэтому cookie и guard
        # неактивного кабинета к ним неприменимы. Ручки кабинета того же
        # префикса (`/api/telegram/status`, `/connect`, `/disconnect`,
        # `/test-message`) остаются под guard и проверяются.
        "/api/telegram/chat",
        "/api/telegram/chats",
        "/api/telegram/feed",
        "/api/telegram/feed/{delivery_id}/failed",
        # Ручки платформенного контура кабинета оператора: это не операции
        # кабинета клиента, а служебный интерфейс оператора. Авторизация у них
        # своя — сервисный токен в заголовке `X-Operator-Token` (401 на любой
        # неверный токен, включая пустой настроенный секрет), — поэтому cookie и
        # guard неактивного кабинета к ним неприменимы.
        "/api/platform/organizations",
        "/api/platform/organizations/{organization_id}",
        # Пользователи платформы — второй раздел того же контура: авторизация
        # тоже заголовком `X-Operator-Token`, cookie и guard кабинета клиента
        # к ним неприменимы.
        "/api/platform/users",
        "/api/platform/users/{user_id}",
        # Счета платформы — третий раздел того же контура: список всех
        # организаций, оплата, отмена и печатные формы. Авторизация тоже
        # заголовком `X-Operator-Token`, поэтому cookie и guard кабинета
        # клиента к ним неприменимы.
        "/api/platform/invoices",
        "/api/platform/invoices/{invoice_id}",
        "/api/platform/invoices/{invoice_id}/file",
        "/api/platform/invoices/{invoice_id}/act-file",
        # Тарифы платформы — четвёртый раздел того же контура: весь прайс,
        # правка полей и снятие с продажи. Авторизация тоже заголовком
        # `X-Operator-Token`, поэтому cookie и guard кабинета клиента к ним
        # неприменимы.
        "/api/platform/tariffs",
        "/api/platform/tariffs/{tariff_id}",
        # Реквизиты поставщика — пятый раздел того же контура: их правят в
        # кабинете оператора, печатные формы берут оттуда блок «Поставщик» и
        # строку про НДС (#179). Авторизация тоже заголовком
        # `X-Operator-Token`, поэтому cookie и guard кабинета клиента к ним
        # неприменимы.
        "/api/platform/company-details",
        # Каталог решений магазина — шестой раздел того же контура: весь каталог,
        # правка полей и снятие с продажи (#188). Авторизация тоже заголовком
        # `X-Operator-Token`, поэтому cookie и guard кабинета клиента к ним
        # неприменимы.
        "/api/platform/solutions",
        "/api/platform/solutions/{solution_id}",
        # Тариф и расширения организации — седьмой раздел того же контура: чтение
        # слотов, правка срока и снятие активности тарифа и права (#189).
        # Авторизация тоже заголовком `X-Operator-Token`, поэтому cookie и guard
        # кабинета клиента к ним неприменимы.
        "/api/platform/organizations/{organization_id}/subscription",
        "/api/platform/organizations/{organization_id}/subscription/deactivate",
        "/api/platform/organizations/{organization_id}/solutions/{code}/deactivate",
        # Раздача файлов: это не операция кабинета, а ссылка на файл, и она живёт
        # вне `/api`. Отказы там свои и закреплены контрактом: аноним получает
        # `404` (существование файла не подтверждается), вошедший без прав —
        # `403` «Нет доступа к файлу», и текста активации среди них нет. Право
        # чтения решают правила файла (`app/file_access.can_read`), а не состояние
        # кабинета: файл принадлежит организации и остаётся доступен, даже если
        # кабинет закрыт пробным периодом.
        "/uploads/{key}",
    }
)

NEW_PASSWORD = "new-password-123"


def is_exempt(path: str) -> bool:
    return path.startswith(EXEMPT_PREFIXES) or path in EXEMPT_PATHS


def working_operations(client: TestClient) -> list[tuple[str, str]]:
    """Все объявленные операции, кроме свободных от guard."""
    paths = client.get("/openapi.json").json()["paths"]
    return [
        (method.upper(), path)
        for path, methods in paths.items()
        if not is_exempt(path)
        for method in methods
    ]


def concrete(path: str) -> str:
    """`/api/dormitories/{dormitory_id}/report` → `/api/dormitories/1/report`."""
    while "{" in path:
        start = path.index("{")
        end = path.index("}", start)
        path = f"{path[:start]}1{path[end + 1 :]}"
    return path


def test_openapi_covers_the_working_surface(client: TestClient) -> None:
    operations = working_operations(client)
    assert len(operations) >= 20
    assert ("GET", "/api/dormitories") in operations
    assert ("GET", "/api/me") not in operations


def test_every_working_operation_documents_403(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()["paths"]

    missing = [
        f"{method.upper()} {path}"
        for path, methods in schema.items()
        if not is_exempt(path)
        for method, operation in methods.items()
        if "403" not in operation["responses"]
    ]

    assert missing == []
    assert "403" not in schema["/api/me"]["get"]["responses"]


def test_inactive_user_gets_403_with_the_activation_hint(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, is_active=False)
    assert login(client, user.email).status_code == 200

    for method, path in working_operations(client):
        response = client.request(method, concrete(path))
        assert response.status_code == 403, f"{method} {path}: {response.status_code}"
        assert response.json()["detail"] == ACTIVATION_REQUIRED_DETAIL, f"{method} {path}"


def test_active_user_passes_the_guard(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session)
    # Данные кабинета принадлежат организации: без неё рабочие разделы отвечают
    # 404 «Организация не найдена», и проверка «активный проходит» не о том.
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    assert client.get("/api/dormitories").status_code == 200
    assert client.get("/api/dashboard?from=2025-09-01&to=2025-09-02").status_code == 200


def test_me_stays_open_for_inactive_user(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, is_active=False, full_name="Неактивный Пользователь")
    assert login(client, user.email).status_code == 200

    response = client.get("/api/me")

    assert response.status_code == 200
    assert response.json() == {
        "email": user.email,
        "full_name": "Неактивный Пользователь",
        "created_at": response.json()["created_at"],
        "is_active": False,
        # Роль в организации (issue #74): у неактивированного кабинета её нет.
        "role": None,
    }


def test_activation_opens_the_working_endpoints(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, is_active=False)
    raw_token = issue_activation_token(db_session, user.id)
    db_session.commit()
    assert login(client, user.email).status_code == 200
    assert client.get("/api/dormitories").status_code == 403

    activated = client.post(
        "/api/auth/activate",
        json={
            "token": raw_token,
            "password": NEW_PASSWORD,
            "consent": True,
            "terms_accepted": True,
        },
    )

    assert activated.status_code == 200
    assert client.get("/api/dormitories").status_code == 200

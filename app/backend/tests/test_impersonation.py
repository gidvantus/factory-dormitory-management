"""Вход под пользователем из кабинета оператора (#201): ссылка, вход и молчание.

Две ручки основного API и то, что за ними:

* `POST /api/platform/users/{user_id}/impersonation-link` — выдача ссылки
  кабинету оператора по сервисному токену. Адрес собирается из
  `frontend_base_url`, поэтому сайт кабинету знать не нужно;
* `POST /api/auth/impersonate` — вход по ссылке: cookie `crm_session` и тело
  `UserResponse`, как у обычного входа. Cookie ставит только основной API и
  только на своём origin.

Молчание — вторая половина задачи, и проверяется она здесь же: в сессии
поддержки строка журнала пишется с пустой организацией (след в `audit_events`
есть, у владельца в `GET /api/journal` строки нет), а правила уведомлений не
создают доставок (отдельный кейс — `test_notification_rules.py`).

Тесты герметичны: SQLite в памяти, писем и сети нет.
"""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.api.platform_users import USER_NOT_FOUND_DETAIL
from app.config import get_settings
from app.models.audit import AuditEvent
from app.security import (
    CABINET_NOT_ACTIVATED_DETAIL,
    IMPERSONATION_CLAIM,
    IMPERSONATION_CLAIM_VALUE,
    IMPERSONATION_LINK_INVALID_DETAIL,
    IMPERSONATION_LINK_TYPE,
    IMPERSONATION_TYPE_CLAIM,
    INVALID_OPERATOR_TOKEN_DETAIL,
    create_access_token,
    create_impersonation_token,
    decode_access_token,
    decode_impersonation_token,
)
from tests.conftest import (
    JOURNAL_CODE,
    create_user,
    give_solution,
    login,
    organizations_for,
)

# Заведомо ненастоящий секрет: настоящий в тестах не нужен.
SERVICE_TOKEN = "unit-test-operator-service-token"
OPERATOR_HEADERS = {"X-Operator-Token": SERVICE_TOKEN}
WRONG_HEADERS = {"X-Operator-Token": "not-the-token"}

PLATFORM = "/api/platform/users"
IMPERSONATE = "/api/auth/impersonate"
LINK_PATH = PLATFORM + "/{user_id}/impersonation-link"

# Адрес сайта, к которому приписывается `/su/<токен>`. Он же — ожидаемый префикс
# ссылки: адрес собирает основной API, а не кабинет.
FRONTEND_BASE_URL = "http://stands.example.com"

# Тело создания общежития: самая простая запись кабинета, которая оставляет
# строку журнала. Своей ручки у неё нет, и она же есть в тестах журнала.
DORMITORY_PAYLOAD = {"name": "Северное", "client_name": "Стройкомплект"}

# Поля тела ответа входа: ровно `UserResponse`, как у `POST /api/auth/login`.
LOGIN_FIELDS = {"email", "full_name", "created_at", "is_active"}


@pytest.fixture
def platform(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Сервисный токен и адрес сайта заданы. Кеш настроек сбрасывается до и после.

    Значения выставляются жёстко, а не `setdefault`: на стенде те же переменные
    приходят из compose, а тест проверяет контракт, а не настройку стенда.
    """
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", SERVICE_TOKEN)
    monkeypatch.setenv("FRONTEND_BASE_URL", FRONTEND_BASE_URL)
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


def link(client: TestClient, user_id: int, headers: dict[str, str] | None = None) -> Any:
    """Запрос ссылки так, как его делает кабинет оператора: тела нет.

    `headers=None` — заголовка сервисного контура нет вовсе: это отдельный
    случай отказа, и подставлять туда рабочий токен нельзя.
    """
    return client.post(
        f"{PLATFORM}/{user_id}/impersonation-link",
        headers=OPERATOR_HEADERS if headers is None else headers,
    )


def link_token(url: str) -> str:
    """Токен из выданной ссылки: последний сегмент пути `/su/<токен>`."""
    return url.rsplit("/", 1)[-1]


def session_payload(client: TestClient) -> dict[str, Any]:
    """Payload cookie сессии этого клиента: по нему видно признак поддержки."""
    token = client.cookies.get(get_settings().session_cookie_name)
    assert token is not None
    payload = decode_access_token(token)
    assert payload is not None
    return payload


def events(db_session: Session) -> list[AuditEvent]:
    """Строки журнала в порядке появления."""
    db_session.expire_all()
    return list(db_session.scalars(select(AuditEvent).order_by(AuditEvent.id)))


def private_token(**claims: Any) -> str:
    """Токен, собранный вручную: тесты подменяют им claim'ы и секрет подписи.

    По умолчанию собран как настоящая ссылка — с признаком `imp` и видом
    `impersonation_link`: иначе каждый кейс проверял бы ещё и отсутствие вида, а
    не то, что названо в его имени. Подменить вид можно через `claims`.
    """
    settings = get_settings()
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": "1",
        "iat": now,
        "exp": now + timedelta(seconds=60),
        IMPERSONATION_CLAIM: IMPERSONATION_CLAIM_VALUE,
        IMPERSONATION_TYPE_CLAIM: IMPERSONATION_LINK_TYPE,
        **claims,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


# --- Выдача ссылки -----------------------------------------------------------


def test_link_is_issued_for_an_active_user(
    client: TestClient, db_session: Session, platform: None
) -> None:
    """`200 {"url"}`: адрес сайта плюс `/su/` и токен, которым входят этим же id."""
    user = create_user(db_session)

    response = link(client, user.id)

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"url"}
    assert body["url"].startswith(f"{FRONTEND_BASE_URL}/su/")
    assert decode_impersonation_token(link_token(body["url"])) == user.id


def test_link_token_carries_the_impersonation_claim(
    client: TestClient, db_session: Session, platform: None
) -> None:
    """Признак стоит в ссылке: без него вход по ссылке не отличить от обычного.

    Вместе с признаком ссылка несёт свой вид: по нему её и отличают от сессии.
    """
    user = create_user(db_session)

    payload = decode_access_token(link_token(link(client, user.id).json()["url"]))

    assert payload is not None
    assert payload[IMPERSONATION_CLAIM] is IMPERSONATION_CLAIM_VALUE
    assert payload[IMPERSONATION_TYPE_CLAIM] == IMPERSONATION_LINK_TYPE
    assert payload["sub"] == str(user.id)
    assert payload["exp"] - payload["iat"] == get_settings().impersonation_token_ttl_seconds


def test_trailing_slash_in_the_site_address_does_not_double(
    client: TestClient,
    db_session: Session,
    platform: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`FRONTEND_BASE_URL` с хвостовым слэшем даёт один слэш, а не два."""
    monkeypatch.setenv("FRONTEND_BASE_URL", FRONTEND_BASE_URL + "/")
    get_settings.cache_clear()
    user = create_user(db_session)

    url = link(client, user.id).json()["url"]

    assert url.startswith(f"{FRONTEND_BASE_URL}/su/")
    assert "//su/" not in url


def test_unknown_user_gives_404(client: TestClient, platform: None) -> None:
    response = link(client, 999999)

    assert response.status_code == 404
    assert response.json() == {"detail": USER_NOT_FOUND_DETAIL}


def test_inactive_cabinet_gives_409(
    client: TestClient, db_session: Session, platform: None
) -> None:
    """Неактивированному кабинету ссылка не выдаётся: входить в него некуда."""
    user = create_user(db_session, is_active=False)

    response = link(client, user.id)

    assert response.status_code == 409
    assert response.json() == {"detail": CABINET_NOT_ACTIVATED_DETAIL}


@pytest.mark.parametrize("headers", [None, WRONG_HEADERS])
def test_link_is_closed_without_the_service_token(
    client: TestClient, db_session: Session, platform: None, headers: dict[str, str] | None
) -> None:
    """Сессия основного кабинета сервисный токен не заменяет."""
    user = create_user(db_session)
    assert login(client, user.email).status_code == 200

    response = link(client, user.id, headers=headers if headers is not None else {})

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


# --- Вход по ссылке ----------------------------------------------------------


def test_impersonate_sets_the_session_cookie_and_returns_the_user(
    client: TestClient, db_session: Session, platform: None
) -> None:
    """Ответ — как у входа по паролю, cookie — обычная, но с признаком сессии."""
    user = create_user(db_session)

    response = client.post(IMPERSONATE, json={"token": create_impersonation_token(user.id)})

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == LOGIN_FIELDS
    assert body["email"] == user.email
    assert body["full_name"] == user.full_name

    cookie_header = response.headers["set-cookie"]
    assert "HttpOnly" in cookie_header
    assert "SameSite=lax" in cookie_header
    assert get_settings().session_cookie_name in cookie_header

    payload = session_payload(client)
    assert payload["sub"] == str(user.id)
    assert payload[IMPERSONATION_CLAIM] is IMPERSONATION_CLAIM_VALUE

    # Дальше это обычная сессия: `/api/me` отдаёт выбранного пользователя.
    assert client.get("/api/me").json()["email"] == user.email


def test_impersonate_accepts_the_token_from_the_issued_link(
    client: TestClient, db_session: Session, platform: None
) -> None:
    """Сквозной путь ручки: ссылка выдана там, токен из неё — здесь."""
    user = create_user(db_session)

    token = link_token(link(client, user.id).json()["url"])
    response = client.post(IMPERSONATE, json={"token": token})

    assert response.status_code == 200, response.text
    assert response.json()["email"] == user.email


def test_ordinary_login_carries_no_impersonation_claim(
    client: TestClient, db_session: Session
) -> None:
    """Обычный вход признака не несёт: иначе журнал молчал бы у всех."""
    user = create_user(db_session)

    assert login(client, user.email).status_code == 200

    assert IMPERSONATION_CLAIM not in session_payload(client)


def test_expired_link_is_refused(client: TestClient, db_session: Session, platform: None) -> None:
    """Срок — часть контракта: просроченная ссылка это `400`, а не `500`."""
    user = create_user(db_session)
    expired_after = get_settings().impersonation_token_ttl_seconds + 1
    token = create_impersonation_token(
        user.id, now=datetime.now(UTC) - timedelta(seconds=expired_after)
    )

    response = client.post(IMPERSONATE, json={"token": token})

    assert response.status_code == 400
    assert response.json() == {"detail": IMPERSONATION_LINK_INVALID_DETAIL}
    assert "set-cookie" not in response.headers


def test_ordinary_session_token_is_not_an_invitation(
    client: TestClient, db_session: Session, platform: None
) -> None:
    """Обычная сессия — не ссылка поддержки: у неё нет признака."""
    user = create_user(db_session)

    response = client.post(IMPERSONATE, json={"token": create_access_token(str(user.id))})

    assert response.status_code == 400
    assert response.json() == {"detail": IMPERSONATION_LINK_INVALID_DETAIL}
    assert "set-cookie" not in response.headers


def test_impersonated_session_token_is_not_an_invitation(
    client: TestClient, db_session: Session, platform: None
) -> None:
    """Имперсонированная сессия — тоже не ссылка, хотя признак `imp` у неё есть.

    Иначе cookie со сроком 7 дней продлевала бы себя входом по ней самой: «2
    минуты» ограничивали бы вход, а не доступ, и держатель cookie выключал бы
    себе журнал и уведомления навсегда. Ссылку как cookie предъявить по-прежнему
    можно — это ограничение из постановки остаётся.
    """
    user = create_user(db_session)

    response = client.post(
        IMPERSONATE,
        json={"token": create_access_token(str(user.id), impersonated=True)},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": IMPERSONATION_LINK_INVALID_DETAIL}
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize(
    "token",
    [
        "не.токен",
        # Чужой секрет подписи: токен собран тем же составом claims, но не нами.
        jwt.encode(
            {
                "sub": "1",
                "exp": datetime.now(UTC) + timedelta(seconds=60),
                IMPERSONATION_CLAIM: IMPERSONATION_CLAIM_VALUE,
                IMPERSONATION_TYPE_CLAIM: IMPERSONATION_LINK_TYPE,
            },
            "another-secret-value-0123456789-abcdef",
            algorithm="HS256",
        ),
        # Тот же секрет, но признака нет или он не «истина».
        private_token(**{IMPERSONATION_CLAIM: False}),
        private_token(**{IMPERSONATION_CLAIM: "true"}),
        # Признак есть, а вида токена нет или он чужой: это сессия, а не ссылка.
        private_token(**{IMPERSONATION_TYPE_CLAIM: None}),
        private_token(**{IMPERSONATION_TYPE_CLAIM: "session"}),
        # Признак есть, а субъект не число: разбирать его в id нельзя.
        private_token(**{"sub": "abc"}),
        private_token(**{"sub": None}),
    ],
)
def test_broken_link_is_refused_with_400(client: TestClient, platform: None, token: str) -> None:
    """Битое тело, подпись, claim, вид токена и субъект — всё один отказ `400`."""
    response = client.post(IMPERSONATE, json={"token": token})

    assert response.status_code == 400
    assert response.json() == {"detail": IMPERSONATION_LINK_INVALID_DETAIL}


def test_link_of_unknown_user_gives_404(client: TestClient, platform: None) -> None:
    """Подпись сошлась, но пользователя уже нет — `404` тем же текстом."""
    response = client.post(IMPERSONATE, json={"token": create_impersonation_token(999999)})

    assert response.status_code == 404
    assert response.json() == {"detail": USER_NOT_FOUND_DETAIL}
    assert "set-cookie" not in response.headers


def test_link_of_inactive_cabinet_gives_409(
    client: TestClient, db_session: Session, platform: None
) -> None:
    """Кабинет погасили после выдачи ссылки — входа нет."""
    user = create_user(db_session, is_active=False)

    response = client.post(IMPERSONATE, json={"token": create_impersonation_token(user.id)})

    assert response.status_code == 409
    assert response.json() == {"detail": CABINET_NOT_ACTIVATED_DETAIL}
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"token": ""},
        {"token": None},
        {"token": "x", "extra": True},
        # Верхняя граница — как у ссылки активации: ручка открыта анониму, и тело
        # произвольного размера (до 20 МБ по лимиту nginx) до разбора не доходит.
        {"token": "x" * 513},
    ],
)
def test_broken_request_body_is_422(
    client: TestClient, platform: None, payload: dict[str, Any]
) -> None:
    """Токена нет, он пустой, длинный или в теле лишнее поле — это `422` схемы."""
    response = client.post(IMPERSONATE, json=payload)

    assert response.status_code == 422


def test_broken_json_body_is_400(client: TestClient, platform: None) -> None:
    """Неразбираемое тело — это `400` Starlette, а не отказ ссылки.

    Ручка объявляет `400` и для этого случая тоже: кодовая точка та же, а текст
    приходит от ASGI-сервера, и подменять его своим нельзя.
    """
    response = client.post(
        IMPERSONATE,
        content=b'{"token": "\xff"}',
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 400


# --- Молчание журнала --------------------------------------------------------


def test_impersonated_action_is_written_without_an_organization(
    client: TestClient, db_session: Session, platform: None
) -> None:
    """След остаётся: строка есть, актор — пользователь, организации нет.

    Это и есть «молчание»: `GET /api/journal` фильтрует по организации, поэтому
    владелец такой строки не увидит, а разбор инцидента её найдёт.
    """
    user = create_user(db_session)
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200
    assert (
        client.post(IMPERSONATE, json={"token": create_impersonation_token(user.id)}).status_code
        == 200
    )

    created = client.post("/api/dormitories", json=DORMITORY_PAYLOAD)

    assert created.status_code == 201, created.text
    written = next(row for row in events(db_session) if row.action == "post_dormitories")
    assert written.organization_id is None
    assert written.actor_id == user.id
    assert written.actor_name == user.full_name
    # Строка за сам вход в журнале тоже есть — без актора и без организации.
    assert any(row.action == "post_auth_impersonate" for row in events(db_session))


def test_regular_session_still_writes_the_organization(
    client: TestClient, db_session: Session
) -> None:
    """Обратная сторона: обычная сессия пишет организацию, как раньше."""
    user = create_user(db_session)
    organization, _member = organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    assert client.post("/api/dormitories", json=DORMITORY_PAYLOAD).status_code == 201

    written = next(row for row in events(db_session) if row.action == "post_dormitories")
    assert written.organization_id == organization.id
    assert written.actor_id == user.id


def test_owner_journal_does_not_show_the_impersonated_action(
    client: TestClient, db_session: Session, platform: None
) -> None:
    """Владелец читает журнал в той же сессии — строки поддержки в нём нет."""
    user = create_user(db_session)
    organization, _member = organizations_for(db_session, user)
    give_solution(db_session, organization, code=JOURNAL_CODE)
    assert login(client, user.email).status_code == 200
    assert client.post("/api/dormitories", json=DORMITORY_PAYLOAD).status_code == 201

    assert (
        client.post(IMPERSONATE, json={"token": create_impersonation_token(user.id)}).status_code
        == 200
    )
    assert (
        client.post(
            "/api/dormitories", json={"name": "Южное", "client_name": "Стройкомплект"}
        ).status_code
        == 201
    )

    response = client.get("/api/journal")

    assert response.status_code == 200, response.text
    actions = [item["action"] for item in response.json()["items"]]
    # Обе записи — одно действие `post_dormitories`, поэтому в журнале видна одна
    # строка: вторая попала в `audit_events` с пустой организацией.
    assert actions.count("post_dormitories") == 1
    assert [
        row.organization_id for row in events(db_session) if row.action == "post_dormitories"
    ] == [
        organization.id,
        None,
    ]


def test_link_issue_row_has_no_actor_and_no_organization(
    client: TestClient, db_session: Session, platform: None
) -> None:
    """Строка за выпуск ссылки — как у входа: без актора и организации.

    Проверяется, а не программируется: у ручки нет коммита, поэтому её пишет
    best-effort путь middleware (`app.audit.write_best_effort`). Актора у запроса
    нет вовсе — его открывает сервисный токен, а не cookie.
    """
    user = create_user(db_session)

    assert link(client, user.id).status_code == 200

    written = next(
        row for row in events(db_session) if row.action == "post_platform_users_impersonation_link"
    )
    assert written.actor_id is None
    assert written.organization_id is None
    assert written.status == 200


def test_record_actor_clears_the_organization_only_in_an_impersonated_session() -> None:
    """`record_actor` — одно место, где организация журнала становится пустой.

    История общежития при этом получает настоящую организацию: это её
    собственный журнал, и автором правки там остаётся пользователь.
    """
    context = audit.AuditContext(
        request_id="unit-test",
        method="PATCH",
        scope={},
        ip=None,
        user_agent=None,
        request_body=None,
        started=0.0,
    )
    token = audit.start_context(context)
    try:
        audit.record_actor(
            actor_id=7, organization_id=3, actor_name="Иванов Иван", impersonated=True
        )
        values = context.values(status=None, duration_ms=None)
        assert audit.is_impersonated() is True
    finally:
        audit.finish_context(token)

    assert values["organization_id"] is None
    assert values["actor_id"] == 7
    assert values["actor_name"] == "Иванов Иван"
    assert audit.is_impersonated() is False


def test_regular_session_context_keeps_the_organization() -> None:
    """Обычная сессия не задевается: организация остаётся в контексте."""
    context = audit.AuditContext(
        request_id="unit-test",
        method="PATCH",
        scope={},
        ip=None,
        user_agent=None,
        request_body=None,
        started=0.0,
    )
    token = audit.start_context(context)
    try:
        audit.record_actor(actor_id=7, organization_id=3, actor_name="Иванов Иван")
        values = context.values(status=None, duration_ms=None)
    finally:
        audit.finish_context(token)

    assert values["organization_id"] == 3
    assert context.impersonated is False


# --- Контракт схемы ----------------------------------------------------------


def test_new_actions_have_readable_titles() -> None:
    """Оба новых действия названы по-человечески, а не своим кодом."""
    actions = [
        audit.action_code("POST", "/api/auth/impersonate"),
        audit.action_code("POST", "/api/platform/users/{user_id}/impersonation-link"),
    ]

    assert actions == ["post_auth_impersonate", "post_platform_users_impersonation_link"]
    for action in actions:
        assert audit.action_title(action) != action


def test_schema_documents_every_status_the_routes_return(client: TestClient) -> None:
    """Коды, которые ручки возвращают, объявлены в опубликованной схеме."""
    schema = client.get("/openapi.json").json()

    link_responses = schema["paths"][LINK_PATH]["post"]["responses"]
    assert {"200", "401", "404", "409"} <= set(link_responses)

    impersonate_responses = schema["paths"][IMPERSONATE]["post"]["responses"]
    assert {"200", "400", "404", "409", "422"} <= set(impersonate_responses)


def test_schema_names_both_bad_request_cases(client: TestClient) -> None:
    """У `400` два случая: отказ ссылки и неразбираемое тело (как у `login`).

    Схема — контракт с фронтом, который показывает `detail` дословно: если тело
    не разобралось, текст придёт от Starlette, и он обязан быть объявлен.
    """
    description = client.get("/openapi.json").json()["paths"][IMPERSONATE]["post"]["responses"][
        "400"
    ]["description"]

    assert IMPERSONATION_LINK_INVALID_DETAIL in description
    assert "JSON" in description

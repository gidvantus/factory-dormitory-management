"""Telegram: клиент Bot API, секреты в логе и ручки бота и кабинета.

Сети нет: HTTP-клиент собирается на `httpx.MockTransport` (как в
`tests/test_dadata.py`), поэтому проверяется ровно разбор ответа и обработка
сбоев. Настройки Telegram передаются в модуль явно там, где это возможно; для
ручек они выставляются в окружении и кеш настроек сбрасывается.

Ручки кабинета закрыты правом организации на решение `telegram_notifications`
(issue #61), поэтому пользователь кабинета в тестах заводится помощником
`cabinet_user`: он заводит организацию и выдаёт ей право. Без права все пять
ручек отвечают 403, и это проверяется отдельным блоком.
"""

import logging
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import notifications, telegram
from app.config import Settings, get_settings
from app.models.activation import ActivationToken
from app.models.telegram import RESIDENT_OUTFLOW_KIND, NotificationDelivery, TelegramLink
from app.models.user import User
from app.solutions import SOLUTION_REQUIRED_DETAIL
from tests.conftest import give_solution, organizations_for, sign_in

# Заведомо ненастоящие значения: реальные токены в тестах не нужны.
BOT_TOKEN = "111111:unit-test-bot-token"
SERVICE_TOKEN = "unit-test-service-token"
BOT_USERNAME = "DormitoryNotifyBot"
CHAT_ID = "987654321"

BOT_HEADERS = {"X-Bot-Token": SERVICE_TOKEN}


def make_settings(
    *,
    bot_token: str = BOT_TOKEN,
    service_token: str = SERVICE_TOKEN,
    bot_username: str = BOT_USERNAME,
) -> Settings:
    """Настройки с явными значениями: окружение машины в тестах не участвует.

    Именованные аргументы, а не словарь с `**`: так значения проверяет mypy, и
    опечатка в имени настройки не превращается в молчаливый дефолт.
    """
    return Settings(
        database_url="sqlite+pysqlite:///:memory:",
        jwt_secret="unit-test-secret-value-0123456789",
        telegram_bot_token=bot_token,
        telegram_bot_username=bot_username,
        telegram_service_token=service_token,
        telegram_api_base_url="https://api.telegram.test",
        telegram_request_timeout_seconds=1.0,
    )


@pytest.fixture
def telegram_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Настроенный Telegram для ручек. Кеш настроек сбрасывается до и после."""
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", BOT_TOKEN)
    monkeypatch.setenv("TELEGRAM_BOT_USERNAME", BOT_USERNAME)
    monkeypatch.setenv("TELEGRAM_SERVICE_TOKEN", SERVICE_TOKEN)
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


def client_with(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def ok_response(result: object) -> httpx.Response:
    return httpx.Response(200, json={"ok": True, "result": result})


def cabinet_user(
    client: TestClient,
    db_session: Session,
    *,
    email: str = "worker@example.com",
    is_active: bool = True,
    with_solution: bool = True,
) -> User:
    """Войти пользователем кабинета: организация и (по умолчанию) право на решение.

    Ручки кабинета Telegram закрыты правом организации на решение
    `telegram_notifications`, а `sign_in` организации не заводит вовсе. Поэтому
    обычный пользователь кабинета в этих тестах получает её вместе с правом, а
    `with_solution=False` оставляет только организацию — для проверок 403.
    """
    user = sign_in(client, db_session, email=email, is_active=is_active)
    organization, _ = organizations_for(db_session, user)
    if with_solution:
        give_solution(db_session, organization)
    return user


# --- Клиент Bot API ---


def test_send_message_without_a_token_does_not_touch_the_network() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return ok_response({})

    with client_with(handler) as client:
        sent = telegram.send_message(
            chat_id=CHAT_ID,
            text="привет",
            client=client,
            settings=make_settings(bot_token=""),
        )

    assert sent is False
    assert calls == []


def test_network_failure_is_swallowed_and_leaves_no_secrets_in_the_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with (
        caplog.at_level(logging.ERROR, logger="app.telegram"),
        client_with(handler) as client,
    ):
        sent = telegram.send_message(
            chat_id=CHAT_ID,
            text="секретный текст сообщения",
            client=client,
            settings=make_settings(),
        )

    assert sent is False
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert BOT_TOKEN not in logged
    assert SERVICE_TOKEN not in logged
    assert CHAT_ID not in logged
    assert "секретный текст сообщения" not in logged


def test_http_error_status_and_broken_json_are_swallowed(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.ERROR, logger="app.telegram"):
        with client_with(lambda request: httpx.Response(500, text="boom")) as client:
            assert (
                telegram.send_message(
                    chat_id=CHAT_ID, text="привет", client=client, settings=make_settings()
                )
                is False
            )

        with client_with(lambda request: httpx.Response(200, text="не json")) as client:
            assert (
                telegram.send_message(
                    chat_id=CHAT_ID, text="привет", client=client, settings=make_settings()
                )
                is False
            )

        with client_with(
            lambda request: httpx.Response(200, json={"ok": False, "error_code": 403})
        ) as client:
            assert (
                telegram.send_message(
                    chat_id=CHAT_ID, text="привет", client=client, settings=make_settings()
                )
                is False
            )

    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert BOT_TOKEN not in logged
    assert CHAT_ID not in logged


def test_get_updates_returns_parsed_items_and_skips_missing_result() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok_response([{"update_id": 5, "message": {"text": "/start"}}])

    with client_with(handler) as client:
        updates = telegram.get_updates(offset=4, client=client, settings=make_settings())

    assert updates == [{"update_id": 5, "message": {"text": "/start"}}]
    assert len(seen) == 1
    request = seen[0]
    assert request.url.path == f"/bot{BOT_TOKEN}/getUpdates"
    assert b'"offset":4' in request.content

    with client_with(lambda request: httpx.Response(500, text="boom")) as client:
        assert telegram.get_updates(offset=None, client=client, settings=make_settings()) == []


def test_render_message_joins_title_and_body_without_markup() -> None:
    delivery = NotificationDelivery(
        user_id=1,
        chat_id=CHAT_ID,
        kind=RESIDENT_OUTFLOW_KIND,
        event_key="resident_outflow:1",
        title="Выселение проживающего",
        body="  Иванов Иван *тест* <b>  ",
        status="pending",
    )
    assert telegram.render_message(delivery) == "Выселение проживающего\n\nИванов Иван *тест* <b>"

    delivery.title = ""
    assert telegram.render_message(delivery) == "Иванов Иван *тест* <b>"


# --- Ручки бота ---


def test_bot_routes_require_the_service_token(client: TestClient) -> None:
    assert (
        client.post(
            "/api/telegram/chat", json={"code": "x", "chat_id": CHAT_ID, "username": None}
        ).status_code
        == 401
    )
    assert client.get("/api/telegram/feed", params={"chat_id": CHAT_ID}).status_code == 401
    assert client.post("/api/telegram/feed/1/failed", json={"error": "x"}).status_code == 401
    assert (
        client.post(
            "/api/telegram/chat",
            json={"code": "x", "chat_id": CHAT_ID, "username": None},
            headers={"X-Bot-Token": "wrong-service-token"},
        ).status_code
        == 401
    )


def test_connect_is_unavailable_while_the_bot_is_not_configured(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "")
    monkeypatch.setenv("TELEGRAM_BOT_USERNAME", "")
    get_settings.cache_clear()
    cabinet_user(client, db_session)

    response = client.post("/api/telegram/connect")

    assert response.status_code == 503
    assert response.json() == {"detail": "Telegram не настроен"}


def test_connect_link_and_status_share_one_contract(
    client: TestClient, db_session: Session, telegram_env: None
) -> None:
    user = cabinet_user(client, db_session)

    connect = client.post("/api/telegram/connect")
    assert connect.status_code == 200, connect.text
    payload = connect.json()
    assert payload["code"]
    assert payload["deep_link"] == f"https://t.me/{BOT_USERNAME}?start={payload['code']}"
    assert payload["expires_at"]

    linked = client.post(
        "/api/telegram/chat",
        json={"code": payload["code"], "chat_id": CHAT_ID, "username": "ivan"},
        headers=BOT_HEADERS,
    )
    assert linked.status_code == 200
    assert linked.json() == {"linked": True, "full_name": user.full_name}

    # Тот же код второй раз — 410 без подробностей.
    again = client.post(
        "/api/telegram/chat",
        json={"code": payload["code"], "chat_id": CHAT_ID, "username": None},
        headers=BOT_HEADERS,
    )
    assert again.status_code == 410
    assert again.json() == {"linked": False, "reason": "invalid_code"}

    # Случайная строка — тоже 410.
    assert (
        client.post(
            "/api/telegram/chat",
            json={"code": "случайная-строка", "chat_id": CHAT_ID},
            headers=BOT_HEADERS,
        ).status_code
        == 410
    )

    status = client.get("/api/telegram/status")
    assert status.status_code == 200
    assert status.json() == {
        "connected": True,
        "username": "ivan",
        "bot_username": BOT_USERNAME,
        "subscriptions": [
            {
                "kind": RESIDENT_OUTFLOW_KIND,
                "title": "Выселение проживающего",
                "is_enabled": True,
            }
        ],
    }


def test_second_link_of_the_same_user_keeps_a_single_row(
    client: TestClient, db_session: Session, telegram_env: None
) -> None:
    cabinet_user(client, db_session)

    for _ in range(2):
        code = client.post("/api/telegram/connect").json()["code"]
        assert (
            client.post(
                "/api/telegram/chat",
                json={"code": code, "chat_id": CHAT_ID, "username": "ivan"},
                headers=BOT_HEADERS,
            ).status_code
            == 200
        )

    assert len(list(db_session.scalars(select(TelegramLink)))) == 1


def test_chats_lists_only_live_links(
    client: TestClient, db_session: Session, telegram_env: None
) -> None:
    """Бот обходит ленты этих чатов — иначе готовые доставки не уходят."""
    assert client.get("/api/telegram/chats").status_code == 401

    cabinet_user(client, db_session)
    assert client.get("/api/telegram/chats", headers=BOT_HEADERS).json() == {"items": []}

    code = client.post("/api/telegram/connect").json()["code"]
    client.post(
        "/api/telegram/chat",
        json={"code": code, "chat_id": CHAT_ID, "username": None},
        headers=BOT_HEADERS,
    )
    assert client.get("/api/telegram/chats", headers=BOT_HEADERS).json() == {"items": [CHAT_ID]}

    client.post("/api/telegram/disconnect")

    assert client.get("/api/telegram/chats", headers=BOT_HEADERS).json() == {"items": []}


def test_unreadable_body_answers_400_as_declared(client: TestClient, telegram_env: None) -> None:
    """400 от Starlette объявлен в схеме, иначе обещание «только 422» расходится с ответом.

    Схема обещает 422 на тело, не подходящее под модель, но тело, которое вообще
    не декодируется в UTF-8, отвергается раньше — до валидации pydantic. Это тот
    же 400, что нашёл `schemathesis status_code_conformance`.
    """
    response = client.post(
        "/api/telegram/chat",
        content=b"\x80",
        headers={**BOT_HEADERS, "Content-Type": "application/json"},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "There was an error parsing the body"}


def add_delivery(db_session: Session, user: User, *, event_key: str = "resident_outflow:1") -> int:
    delivery = NotificationDelivery(
        user_id=user.id,
        chat_id=CHAT_ID,
        kind=RESIDENT_OUTFLOW_KIND,
        event_key=event_key,
        title="Выселение проживающего",
        body="Иванов Иван",
        status="pending",
    )
    db_session.add(delivery)
    db_session.commit()
    return delivery.id


def test_feed_gives_items_once_and_marks_them_sent(
    client: TestClient, db_session: Session, telegram_env: None
) -> None:
    # Ручки бота права организации не требуют: у них своя авторизация.
    user = sign_in(client, db_session)
    delivery_id = add_delivery(db_session, user)

    first = client.get("/api/telegram/feed", params={"chat_id": CHAT_ID}, headers=BOT_HEADERS)
    assert first.status_code == 200
    assert first.json() == {
        "items": [{"id": delivery_id, "text": "Выселение проживающего\n\nИванов Иван"}]
    }

    second = client.get("/api/telegram/feed", params={"chat_id": CHAT_ID}, headers=BOT_HEADERS)
    assert second.json() == {"items": []}

    db_session.expire_all()
    sent = db_session.get(NotificationDelivery, delivery_id)
    assert sent is not None and sent.status == "sent"


def test_failed_marks_the_delivery_and_truncates_the_error(
    client: TestClient, db_session: Session, telegram_env: None
) -> None:
    user = sign_in(client, db_session)
    delivery_id = add_delivery(db_session, user)

    response = client.post(
        f"/api/telegram/feed/{delivery_id}/failed",
        json={"error": "о" * 400},
        headers=BOT_HEADERS,
    )
    assert response.status_code == 204

    db_session.expire_all()
    delivery = db_session.get(NotificationDelivery, delivery_id)
    assert delivery is not None
    assert delivery.status == "failed"
    assert delivery.error is not None and len(delivery.error) == 255

    missing = client.post(
        "/api/telegram/feed/999999/failed", json={"error": "x"}, headers=BOT_HEADERS
    )
    assert missing.status_code == 404


def test_subscriptions_can_be_switched_and_unknown_kinds_are_rejected(
    client: TestClient, db_session: Session, telegram_env: None
) -> None:
    cabinet_user(client, db_session)

    assert (
        client.patch(
            "/api/telegram/subscriptions", json={"kind": "неизвестный", "is_enabled": False}
        ).status_code
        == 422
    )

    off = client.patch(
        "/api/telegram/subscriptions", json={"kind": RESIDENT_OUTFLOW_KIND, "is_enabled": False}
    )
    assert off.status_code == 200
    assert off.json() == [
        {"kind": RESIDENT_OUTFLOW_KIND, "title": "Выселение проживающего", "is_enabled": False}
    ]

    on = client.patch(
        "/api/telegram/subscriptions", json={"kind": RESIDENT_OUTFLOW_KIND, "is_enabled": True}
    )
    assert on.json()[0]["is_enabled"] is True


def test_disconnect_revokes_the_link(
    client: TestClient, db_session: Session, telegram_env: None
) -> None:
    cabinet_user(client, db_session)
    code = client.post("/api/telegram/connect").json()["code"]
    client.post(
        "/api/telegram/chat",
        json={"code": code, "chat_id": CHAT_ID, "username": "ivan"},
        headers=BOT_HEADERS,
    )

    response = client.post("/api/telegram/disconnect")

    assert response.status_code == 200
    assert response.json() == {"connected": False}
    assert client.get("/api/telegram/status").json()["connected"] is False
    row = db_session.scalar(select(TelegramLink))
    assert row is not None and row.revoked_at is not None


def test_test_message_requires_a_connected_chat(
    client: TestClient, db_session: Session, telegram_env: None
) -> None:
    cabinet_user(client, db_session)

    response = client.post("/api/telegram/test-message")

    assert response.status_code == 409
    assert response.json() == {"detail": "Telegram не подключён"}
    assert not list(db_session.scalars(select(NotificationDelivery)))


def test_test_message_reaches_the_feed(
    client: TestClient, db_session: Session, telegram_env: None
) -> None:
    cabinet_user(client, db_session)
    code = client.post("/api/telegram/connect").json()["code"]
    client.post(
        "/api/telegram/chat",
        json={"code": code, "chat_id": CHAT_ID, "username": None},
        headers=BOT_HEADERS,
    )

    assert client.post("/api/telegram/test-message").json() == {"queued": True}

    items = client.get(
        "/api/telegram/feed", params={"chat_id": CHAT_ID}, headers=BOT_HEADERS
    ).json()["items"]
    assert len(items) == 1
    # Первой строкой идёт человеческий заголовок, а не код вида события.
    assert items[0]["text"].startswith("Тестовое уведомление\n\n")
    assert "telegram_test" not in items[0]["text"]
    assert "Проверка связи" in items[0]["text"]
    assert notifications.pending_for_chat(db_session, CHAT_ID) == []


# --- Гейт решения `telegram_notifications` (issue #61) -------------------------

# Пять ручек кабинета: без права организации все они отвечают 403, и ни одна не
# делает того, что делает с правом. Метод, путь и тело запроса — как у рабочего
# вызова, иначе отказ пришёл бы от валидатора, а не от гейта.
CABINET_ROUTES = (
    ("GET", "/api/telegram/status", None),
    ("POST", "/api/telegram/connect", None),
    ("POST", "/api/telegram/disconnect", None),
    (
        "PATCH",
        "/api/telegram/subscriptions",
        {"kind": RESIDENT_OUTFLOW_KIND, "is_enabled": False},
    ),
    ("POST", "/api/telegram/test-message", None),
)


def test_every_cabinet_route_requires_the_solution(
    client: TestClient, db_session: Session, telegram_env: None
) -> None:
    """Организация без права: все пять ручек отвечают 403 про магазин."""
    cabinet_user(client, db_session, with_solution=False)

    for method, path, body in CABINET_ROUTES:
        response = client.request(method, path, json=body)
        assert response.status_code == 403, f"{method} {path}: {response.status_code}"
        assert response.json()["detail"] == SOLUTION_REQUIRED_DETAIL, f"{method} {path}"


def test_expired_right_closes_every_cabinet_route(
    client: TestClient, db_session: Session, telegram_env: None
) -> None:
    """Истёкшее право закрывает ровно то же, что и отсутствующее."""
    user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, user)
    give_solution(db_session, organization, expires_at=datetime.now(UTC) - timedelta(minutes=1))

    for method, path, body in CABINET_ROUTES:
        response = client.request(method, path, json=body)
        assert response.status_code == 403, f"{method} {path}: {response.status_code}"
        assert response.json()["detail"] == SOLUTION_REQUIRED_DETAIL, f"{method} {path}"


def test_cabinet_routes_do_nothing_without_the_solution(
    client: TestClient, db_session: Session, telegram_env: None
) -> None:
    """403 — это отказ, а не «выполнили и не сказали»: следов в базе нет."""
    user = cabinet_user(client, db_session, with_solution=False)
    assert notifications.link_status(db_session, user) == (False, None)

    assert client.post("/api/telegram/connect").status_code == 403

    issued = select(ActivationToken).where(ActivationToken.user_id == user.id)
    assert db_session.scalar(issued) is None
    assert list(db_session.scalars(select(NotificationDelivery))) == []


def test_inactive_cabinet_keeps_the_activation_detail(
    client: TestClient, db_session: Session, telegram_env: None
) -> None:
    """Порядок проверок: неактивированный получает 403 про активацию, не про магазин."""
    cabinet_user(client, db_session, email="inactive@example.com", is_active=False)

    for method, path, body in CABINET_ROUTES:
        response = client.request(method, path, json=body)
        assert response.status_code == 403, f"{method} {path}: {response.status_code}"
        assert response.json()["detail"] == "Активируйте личный кабинет", f"{method} {path}"

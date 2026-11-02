"""Вход, проверка сессии и выход — контракт из постановки, построчно.

Проверяется то, что видит клиент: коды, тела, `detail` дословно и атрибуты
cookie. Устройство токена проверяется отдельно — тестами, которые портят его
руками и ждут `401`, а не `500`.
"""

from datetime import UTC, datetime, timedelta

import jwt
import pytest
from fastapi.testclient import TestClient
from httpx import Response

from app.config import get_settings
from app.security import LOGIN_FAILED_DETAIL, UNAUTHORIZED_DETAIL
from tests.conftest import (
    TEST_OPERATOR_PASSWORD,
    TEST_OPERATOR_TOKEN_SECRET,
    TEST_OPERATOR_USERNAME,
)

API = "/api"
COOKIE_NAME = "operator_session"
# Срок жизни сессии из conftest (`OPERATOR_TOKEN_TTL_HOURS=12`) в секундах.
EXPECTED_MAX_AGE = 12 * 60 * 60
ALGORITHM = "HS256"


def _login(
    client: TestClient,
    username: str = TEST_OPERATOR_USERNAME,
    password: str = TEST_OPERATOR_PASSWORD,
) -> Response:
    """Войти тем же запросом, что отправит фронтенд."""
    return client.post(f"{API}/auth/login", json={"username": username, "password": password})


def _make_token(payload: dict[str, object], secret: str = TEST_OPERATOR_TOKEN_SECRET) -> str:
    """Собрать токен вручную: так проверяются испорченные и чужие сессии."""
    return jwt.encode(payload, secret, algorithm=ALGORITHM)


def _set_session_cookie(client: TestClient, token: str) -> None:
    """Положить cookie в клиент так, как это сделал бы браузер."""
    client.cookies.set(COOKIE_NAME, token)


# --- Вход ------------------------------------------------------------------


def test_login_returns_operator(client: TestClient) -> None:
    response = _login(client)

    assert response.status_code == 200
    assert response.json() == {"username": TEST_OPERATOR_USERNAME}


def test_login_sets_httponly_session_cookie(client: TestClient) -> None:
    response = _login(client)

    header = response.headers["set-cookie"]
    assert header.startswith(f"{COOKIE_NAME}=")
    assert "HttpOnly" in header
    assert "SameSite=lax" in header
    assert "Path=/" in header
    assert f"Max-Age={EXPECTED_MAX_AGE}" in header
    # Secure в тестах выключен (conftest), но атрибут в контракте есть — на стенде
    # с https он появляется из `OPERATOR_SESSION_COOKIE_SECURE`.
    assert "Secure" not in header
    assert response.cookies[COOKIE_NAME]


def test_login_token_payload_is_sub_iat_exp(client: TestClient) -> None:
    token = _login(client).cookies[COOKIE_NAME]
    payload = jwt.decode(token, TEST_OPERATOR_TOKEN_SECRET, algorithms=[ALGORITHM])

    assert payload["sub"] == TEST_OPERATOR_USERNAME
    assert payload["exp"] - payload["iat"] == EXPECTED_MAX_AGE


def test_login_wrong_password_is_401(client: TestClient) -> None:
    response = _login(client, password="wrong-password")

    assert response.status_code == 401
    assert response.json() == {"detail": LOGIN_FAILED_DETAIL}
    assert "set-cookie" not in response.headers


def test_login_wrong_username_is_401(client: TestClient) -> None:
    response = _login(client, username="nobody")

    assert response.status_code == 401
    assert response.json() == {"detail": LOGIN_FAILED_DETAIL}
    assert "set-cookie" not in response.headers


def test_login_invalid_pair_response_is_byte_identical(client: TestClient) -> None:
    wrong_password = _login(client, password="wrong-password")
    wrong_username = _login(client, username="nobody")

    assert wrong_password.status_code == wrong_username.status_code == 401
    assert wrong_password.content == wrong_username.content


@pytest.mark.parametrize(
    ("username", "password"),
    [
        ("", TEST_OPERATOR_PASSWORD),
        (TEST_OPERATOR_USERNAME, ""),
        ("", ""),
    ],
)
def test_login_empty_values_are_401_not_422(
    client: TestClient, username: str, password: str
) -> None:
    """Пустая строка — неверная пара, а не отсутствующее поле."""
    response = _login(client, username=username, password=password)

    assert response.status_code == 401
    assert response.json() == {"detail": LOGIN_FAILED_DETAIL}


@pytest.mark.parametrize(
    "payload",
    [{}, {"username": TEST_OPERATOR_USERNAME}, {"password": TEST_OPERATOR_PASSWORD}],
)
def test_login_missing_field_is_422(client: TestClient, payload: dict[str, str]) -> None:
    """Отсутствие поля — стандартная валидация FastAPI, это не отказ входа."""
    response = client.post(f"{API}/auth/login", json=payload)

    assert response.status_code == 422


def test_login_accepts_non_ascii_username(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, settings_cache: None
) -> None:
    """Логин оператора может быть не-ASCII: сверка идёт по UTF-8 байтам."""
    monkeypatch.setenv("OPERATOR_USERNAME", "оператор")
    get_settings.cache_clear()

    response = _login(client, username="оператор")

    assert response.status_code == 200
    assert response.json() == {"username": "оператор"}


# --- Проверка сессии -------------------------------------------------------


def test_me_without_cookie_is_401(client: TestClient) -> None:
    response = client.get(f"{API}/auth/me")

    assert response.status_code == 401
    assert response.json() == {"detail": UNAUTHORIZED_DETAIL}


def test_me_with_session_returns_operator(client: TestClient) -> None:
    _login(client)

    response = client.get(f"{API}/auth/me")

    assert response.status_code == 200
    assert response.json() == {"username": TEST_OPERATOR_USERNAME}


def test_me_with_garbage_token_is_401(client: TestClient) -> None:
    _set_session_cookie(client, "not-a-jwt")

    response = client.get(f"{API}/auth/me")

    assert response.status_code == 401
    assert response.json() == {"detail": UNAUTHORIZED_DETAIL}


def test_me_with_token_signed_by_foreign_secret_is_401(client: TestClient) -> None:
    """Сессия основного приложения (другой секрет) кабинет не пускает."""
    token = _make_token(
        {"sub": TEST_OPERATOR_USERNAME, "iat": datetime.now(UTC), "exp": datetime.now(UTC)},
        secret="foreign-secret-value-0123456789ab",
    )
    _set_session_cookie(client, token)

    response = client.get(f"{API}/auth/me")

    assert response.status_code == 401


def test_me_with_expired_token_is_401(client: TestClient) -> None:
    now = datetime.now(UTC)
    token = _make_token(
        {
            "sub": TEST_OPERATOR_USERNAME,
            "iat": now - timedelta(hours=2),
            "exp": now - timedelta(hours=1),
        }
    )
    _set_session_cookie(client, token)

    response = client.get(f"{API}/auth/me")

    assert response.status_code == 401


def test_me_with_foreign_subject_is_401(client: TestClient) -> None:
    """Токен с нашим секретом, но выпущенный не тому оператору, — не сессия."""
    now = datetime.now(UTC)
    token = _make_token({"sub": "someone-else", "iat": now, "exp": now + timedelta(hours=1)})
    _set_session_cookie(client, token)

    response = client.get(f"{API}/auth/me")

    assert response.status_code == 401


def test_me_with_token_without_subject_is_401(client: TestClient) -> None:
    now = datetime.now(UTC)
    token = _make_token({"iat": now, "exp": now + timedelta(hours=1)})
    _set_session_cookie(client, token)

    response = client.get(f"{API}/auth/me")

    assert response.status_code == 401


# --- Выход -----------------------------------------------------------------


def test_logout_is_204_and_drops_cookie(client: TestClient) -> None:
    _login(client)

    response = client.post(f"{API}/auth/logout")

    assert response.status_code == 204
    assert response.content == b""
    header = response.headers["set-cookie"]
    assert header.startswith(f"{COOKIE_NAME}=")
    assert "Max-Age=0" in header
    assert "HttpOnly" in header
    assert "SameSite=lax" in header
    assert client.cookies.get(COOKIE_NAME) in (None, "")


def test_me_after_logout_is_401(client: TestClient) -> None:
    _login(client)
    client.post(f"{API}/auth/logout")

    response = client.get(f"{API}/auth/me")

    assert response.status_code == 401


def test_repeated_logout_without_session_is_204(client: TestClient) -> None:
    """Повторный выход — не ошибка: сессии уже нет, но ответ тот же `204`."""
    client.post(f"{API}/auth/logout")

    response = client.post(f"{API}/auth/logout")

    assert response.status_code == 204
    assert response.content == b""

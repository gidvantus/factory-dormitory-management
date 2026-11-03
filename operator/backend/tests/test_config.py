"""Настройки: без пароля и без секрета сервис не стартует.

Проверка, которой не хватало: `OPERATOR_PASSWORD=` (строку в `.env` забыли
заполнить) раньше поднимал сервис, который затем пускал по пустому паролю —
`compare_digest` сравнивал пустое с пустым. Теперь это ошибка конфигурации:
`Settings()` падает при старте, до первого запроса.

`_env_file=None` — тесты не зависят от `.env` в рабочем каталоге: значения
приходят только из окружения, выставленного `conftest.py` и `monkeypatch`.
"""

import pytest
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.main import create_app


@pytest.mark.parametrize(
    "variable",
    ["OPERATOR_PASSWORD", "OPERATOR_USERNAME", "OPERATOR_TOKEN_SECRET"],
)
def test_empty_variable_stops_startup(monkeypatch: pytest.MonkeyPatch, variable: str) -> None:
    """Пустое значение в `.env` — ошибка конфигурации, а не «входа без пароля»."""
    monkeypatch.setenv(variable, "")

    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_short_token_secret_stops_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    """Секрет короче 16 символов подбирается, поэтому тоже роняет старт."""
    monkeypatch.setenv("OPERATOR_TOKEN_SECRET", "too-short")

    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_app_does_not_start_with_empty_password(
    monkeypatch: pytest.MonkeyPatch, settings_cache: None
) -> None:
    """Сборка приложения падает, а не поднимает сервис с пустым паролем.

    Иначе `OPERATOR_PASSWORD=` в `.env` дал бы живой `operator-api` с зелёным
    healthcheck и входом по пустому паролю: `compare_digest` сравнил бы пустое
    с пустым.
    """
    monkeypatch.setenv("OPERATOR_PASSWORD", "")
    get_settings.cache_clear()

    with pytest.raises(ValidationError):
        create_app()


def test_defaults_describe_one_operator() -> None:
    """Умолчания, на которые опирается контракт: имя, имя cookie и срок сессии."""
    settings = Settings(_env_file=None)

    assert settings.operator_username == "operator"
    assert settings.operator_session_cookie_name == "operator_session"
    assert settings.operator_token_ttl_hours == 12
    # `Max-Age` cookie равен этому значению — 12 ч в секундах.
    assert settings.operator_token_ttl_seconds == 12 * 60 * 60

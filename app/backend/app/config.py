"""Настройки сервиса. Всё, что является секретом, приходит только из окружения."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Минимальная длина секрета подписи: короткий секрет подбирается.
MIN_JWT_SECRET_LENGTH = 16


class Settings(BaseSettings):
    """Конфигурация приложения, собранная из переменных окружения."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str
    jwt_secret: str = Field(min_length=MIN_JWT_SECRET_LENGTH)
    jwt_algorithm: str = "HS256"
    jwt_expire_days: int = 7

    session_cookie_name: str = "crm_session"
    session_cookie_secure: bool = False

    # Длительность пробного периода в сутках: он начинается активацией кабинета
    # и не продлевается правкой данных — только выбором тарифа.
    trial_days: int = 30

    # Срок жизни ссылки активации в часах.
    activation_token_ttl_hours: int = 24
    # Абсолютный адрес фронта: из него собирается ссылка в письме.
    frontend_base_url: str = "http://localhost:8080"

    # --- Почта ---
    # Пароль SMTP приходит только из окружения: в коде дефолта нет.
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_use_tls: bool = True

    # --- DaData ---
    # Токен подстановки (suggestions). Пустая строка — нормальное состояние:
    # приложение импортируется и работает, а поиск организации отвечает
    # «сервис недоступен». Токен берётся как есть: в переменной окружения
    # лежит только сам токен, без имени переменной из личного кабинета.
    dadata_api_key: str = ""
    dadata_url: str = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party"
    dadata_timeout_seconds: float = 5.0


@lru_cache
def get_settings() -> Settings:
    """Настройки читаются один раз на процесс."""
    return Settings()

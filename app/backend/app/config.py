"""Настройки сервиса. Всё, что является секретом, приходит только из окружения."""

from functools import lru_cache
from typing import Literal

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
    # и не продлевается правкой данных — только выбором тарифа. Уже выданные
    # периоды смена настройки не пересчитывает: конец периода лежит в базе.
    trial_days: int = 14
    # Предел сотрудников на пробном периоде, кроме владельца. Незаданное
    # значение (`None`) — предела нет, и это умолчание: снять ограничение
    # правкой кода не нужно, а вернуть его можно значением `TRIAL_MEMBER_LIMIT`
    # в `.env` (например, `3`), без выкатки новой версии.
    # Заданное значение обязано быть положительным: `0` не «предела нет», а
    # невозможное состояние, поэтому валидация роняет старт. Пустую строку
    # (`TRIAL_MEMBER_LIMIT=`) в `.env` писать нельзя по той же причине —
    # в `.env.example` строка закомментирована.
    trial_member_limit: int | None = Field(default=None, ge=1)

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

    # --- S3 (облачное хранилище файлов) ---
    # Единый механизм хранения (`app/storage.py`) использует S3, когда заданы
    # endpoint, бакет и ключи активной среды. Ключи задаются ТОЛЬКО в `.env`
    # (файл в `.gitignore`, в репозиторий не попадает) и в коде их нет никогда.
    s3_endpoint: str = "https://s3.twcstorage.ru"
    s3_bucket: str = ""  # имя бакета, задаётся только в .env
    # `Literal`, а не `str`: опечатка (`production`, `Prod`) роняет приложение на
    # старте с внятным отказом. Свободная строка молча давала бы пустые ключи,
    # `s3_enabled = False` и хранилище переключалось бы на локальный диск —
    # импорты легли бы в `/app/uploads` вместо бакета `crm-prod`.
    s3_env: Literal["test", "prod"] = "test"
    # Тестовая среда → префикс crm-agent-test
    s3_access_key_test: str = ""
    s3_secret_key_test: str = ""
    s3_prefix_test: str = "crm-agent-test"
    # Боевая среда → префикс crm-prod
    s3_access_key_prod: str = ""
    s3_secret_key_prod: str = ""
    s3_prefix_prod: str = "crm-prod"

    # --- DaData ---
    # Токен подстановки (suggestions). Пустая строка — нормальное состояние:
    # приложение импортируется и работает, а поиск организации отвечает
    # «сервис недоступен». Токен берётся как есть: в переменной окружения
    # лежит только сам токен, без имени переменной из личного кабинета.
    dadata_api_key: str = ""
    dadata_url: str = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party"
    dadata_timeout_seconds: float = 5.0

    # --- Журнал действий ---
    # Журнал пишется middleware на каждый write-запрос (`app/audit.py`). Выключение
    # нужно для отладки и для стенда без базы: тогда в `audit_events` не пишется
    # ничего, а сами ручки работают как раньше.
    audit_enabled: bool = True
    # Сколько байт тела запроса хранится в журнале. Больше — вместо тела остаётся
    # заглушка с исходным размером: пароль и токены из тела уже вырезаны.
    audit_body_limit_bytes: int = 2048
    # Тело больше этого размера не читается вообще: иначе импорт «Мест» (до 20 МБ
    # по лимиту nginx) материализуется в памяти только ради записи в журнал.
    audit_body_read_limit_bytes: int = 65536
    # Сроки хранения строк журнала: два года для действий с безопасностью кабинета
    # (вход, активация, счета, права, настройки) и квартал для остальных.
    audit_retention_days_security: int = 730
    audit_retention_days_noise: int = 90
    # На сколько месяцев вперёд создаются месячные партиции `audit_events`.
    # Месяц без партиции — потерянная запись журнала, поэтому запас — год.
    audit_partitions_ahead: int = 12
    # Потолок `User-Agent` в журнале: длину задаёт клиент, а не мы.
    audit_user_agent_limit: int = 200
    # Сети доверенных прокси через запятую — единственные, от кого читаются
    # заголовки `X-Forwarded-For` (`app/main.py:client_ip`). Умолчание покрывает
    # loopback и типичные сети контейнеров compose: на стенде перед API стоят
    # nginx и caddy, а клиент снаружи в доверенную сеть не попадает. Стенд с
    # прокси в публичной сети выставляет здесь его адрес.
    trusted_proxy_networks: str = "127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12"
    # Отпустить запись на диск внутри транзакции журнала (`SET LOCAL
    # synchronous_commit = off`, только PostgreSQL): клиент уже получил ответ,
    # и ждать fsync ради строки журнала незачем.
    audit_async_commit: bool = True

    # --- Telegram ---
    # Токен бота от @BotFather: только окружение, в коде дефолта нет. Пустая
    # строка — нормальное состояние: приложение работает как раньше, кабинет
    # отвечает 503 на подключение, а бот пишет в лог и выходит.
    telegram_bot_token: str = ""
    # Имя бота без «@»: из него собирается ссылка t.me. Фронт имени не знает.
    telegram_bot_username: str = ""
    # Адрес Bot API. Отдельной настройкой, а не константой: тесты подменяют его
    # на локальный транспорт.
    telegram_api_base_url: str = "https://api.telegram.org"
    # Свой случайный секрет, которым бот доказывает CRM, что он бот. Это НЕ токен
    # BotFather, и в логи он не попадает.
    telegram_service_token: str = ""
    # Сколько минут живёт код привязки, выданный в кабинете.
    telegram_link_ttl_minutes: int = 15
    # Пауза между опросами Bot API в боте.
    telegram_poll_interval_seconds: int = 3
    # Потолок одного запроса к Bot API.
    telegram_request_timeout_seconds: float = 10.0
    # Адрес CRM для бота: бот ходит в тот же API, что и фронт, но по внутренней
    # сети compose. Публичного адреса у бота нет.
    telegram_crm_api_url: str = "http://api:8000"

    @property
    def s3_region(self) -> str:
        """Регион подписи SigV4 для Timeweb Cloud S3."""
        return "ru-1"

    @property
    def s3_access_key(self) -> str:
        """Ключ активной среды: `s3_access_key_test` или `s3_access_key_prod`."""
        return getattr(self, f"s3_access_key_{self.s3_env}", "")

    @property
    def s3_secret_key(self) -> str:
        """Секрет активной среды: `s3_secret_key_test` или `s3_secret_key_prod`."""
        return getattr(self, f"s3_secret_key_{self.s3_env}", "")

    @property
    def s3_prefix(self) -> str:
        """Префикс среды в бакете: `crm-agent-test` или `crm-prod`."""
        return getattr(self, f"s3_prefix_{self.s3_env}", "")

    @property
    def s3_enabled(self) -> bool:
        """S3 активен, когда заданы endpoint, бакет и ключи активной среды."""
        return bool(
            self.s3_endpoint and self.s3_bucket and self.s3_access_key and self.s3_secret_key
        )


@lru_cache
def get_settings() -> Settings:
    """Настройки читаются один раз на процесс."""
    return Settings()

"""Настройки сервиса кабинета оператора.

Всё, что является секретом, приходит только из окружения: пароля оператора и
секрета подписи сессии в коде нет. Дефолт есть только у имени оператора — это
не секрет, а имя по умолчанию.
"""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Минимальная длина секрета подписи: короткий секрет подбирается.
MIN_TOKEN_SECRET_LENGTH = 16


class Settings(BaseSettings):
    """Конфигурация приложения, собранная из переменных окружения."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Логин единственного оператора. Не секрет: имя по умолчанию допустимо в коде.
    # Пустая строка — не имя: `OPERATOR_USERNAME=` в `.env` роняет старт, а не
    # пускает в кабинет безымянного оператора.
    operator_username: str = Field(default="operator", min_length=1)
    # Пароль оператора. Дефолта нет: пароль не хранится в репозитории, его кладут
    # только в `.env`. Без `OPERATOR_PASSWORD` приложение не стартует — это
    # намеренно: иначе стенд поднялся бы с пустым или подставным паролем.
    # `min_length=1` закрывает второй случай того же: строку в `.env` забыли
    # заполнить (`OPERATOR_PASSWORD=`). Без этого проверка `compare_digest`
    # сравнила бы пустое с пустым, и кабинет пускал бы по пустому паролю в обход
    # клиентской проверки полей.
    operator_password: str = Field(min_length=1)
    # Свой секрет подписи сессии кабинета. Обязателен и НЕ равен `JWT_SECRET`
    # основного приложения: иначе сессии двух приложений стали бы
    # взаимозаменяемыми и кабинет принимал бы cookie основного кабинета.
    operator_token_secret: str = Field(min_length=MIN_TOKEN_SECRET_LENGTH)
    operator_token_algorithm: str = "HS256"
    # Срок жизни сессии в часах. По умолчанию 12 ч: сутки за одной сменой можно
    # не переживать, а заводить «запомнить меня» в кабинете нечем.
    operator_token_ttl_hours: int = 12

    operator_session_cookie_name: str = "operator_session"
    # Cookie с токеном отдаётся только по https, если здесь true.
    operator_session_cookie_secure: bool = False

    # --- Основной API ---
    # Адрес основного API по внутренней сети compose. Публичного адреса у
    # кабинета нет: он ходит в `api:8000`, и наружу этот трафик не выходит.
    # Отдельной настройкой, а не константой: тесты подменяют её (и транспорт)
    # на локальный, а стенд может указать другой хост.
    main_api_base_url: str = "http://api:8000"
    # Потолок одного запроса к основному API. Кабинет — тонкий прокси: если
    # основной API не ответил за это время, пользователю честнее показать
    # «недоступен», чем держать браузер.
    main_api_timeout_seconds: float = 5.0
    # Секрет сервисного контура: кабинет предъявляет его основному API
    # заголовком `X-Operator-Token`. Имя поля то же, что в основном приложении
    # (`app/backend/app/config.py`), поэтому переменная окружения у них одна —
    # `OPERATOR_SERVICE_TOKEN`. Это НЕ токен бота и не cookie основного кабинета.
    # Пустая строка — нормальное состояние: кабинет отвечает 503 на организации,
    # а вход работает как раньше.
    operator_service_token: str = ""

    @property
    def operator_token_ttl_seconds(self) -> int:
        """Срок жизни сессии в секундах: в таком виде его ждёт cookie (`max_age`)."""
        return self.operator_token_ttl_hours * 60 * 60


@lru_cache
def get_settings() -> Settings:
    """Настройки читаются один раз на процесс."""
    return Settings()

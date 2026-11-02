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

    @property
    def operator_token_ttl_seconds(self) -> int:
        """Срок жизни сессии в секундах: в таком виде его ждёт cookie (`max_age`)."""
        return self.operator_token_ttl_hours * 60 * 60


@lru_cache
def get_settings() -> Settings:
    """Настройки читаются один раз на процесс."""
    return Settings()

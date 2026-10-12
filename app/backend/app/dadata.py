"""DaData: единственное место, где приложение ходит во внешний сервис подсказок.

Модуль устроен так же, как `app/mail.py` для SMTP: изолированный внешний вызов,
который не знает ни про SQLAlchemy, ни про FastAPI, и целиком подменяется в
тестах. Наружу он отдаёт либо разобранные реквизиты, либо `None` («такого ИНН
в справочнике нет»), а недоступность сервиса поднимает `DadataUnavailable`.

Ключ берётся из `Settings.dadata_api_key` как есть. В переменную окружения
кладётся только сам токен: если положить строку вида `DADATA_API_KEY = <токен>`
целиком, DaData ответит `403 Feature 'SUGGESTIONS' disabled for token
'DADATA_API_KEY'`. Ни ИНН, ни ключ в логи не попадают — только код ответа.

Пустой ключ не ломает приложение: поиск сразу отвечает «сервис недоступен», а
сохранение организации работает как раньше.
"""

import logging
from dataclasses import dataclass

import httpx

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)

# Потолки длины совпадают с колонками `organizations`: длинное значение из
# справочника не должно ронять сохранение ошибкой Postgres.
MAX_NAME_LENGTH = 255
MAX_KPP_LENGTH = 9
MAX_OGRN_LENGTH = 15
MAX_ADDRESS_LENGTH = 500


class DadataUnavailable(RuntimeError):
    """Сервис недоступен: нет ключа, нет ответа, таймаут или не-2xx.

    Отдельный тип, а не `None`: «не нашли» и «не смогли спросить» — разные
    состояния формы. Пустой ИНН в DaData — это `None`, а не исключение.
    """


@dataclass(frozen=True)
class OrganizationRequisites:
    """Реквизиты организации из ответа DaData. Пустое поле — `None`."""

    name: str | None
    kpp: str | None
    ogrn: str | None
    address: str | None


def _text(value: object, *, limit: int) -> str | None:
    """Строка из JSON: обрезанные пробелы, пустое — `None`, длинное — обрезка."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped:
        return None
    return stripped[:limit]


def _block(data: dict[str, object], key: str) -> dict[str, object]:
    """Вложенный объект ответа. Отсутствие или другой тип — пустой словарь."""
    value = data.get(key)
    return value if isinstance(value, dict) else {}


def requisites_from_suggestion(suggestion: dict[str, object]) -> OrganizationRequisites:
    """Разобрать одну подсказку DaData в реквизиты организации.

    Из ответа берутся `data.inn`, `data.ogrn`, `data.kpp` (у ИП приходит
    `null`), `data.name.short_with_opf` — короткое название с формой
    («ПАО СБЕРБАНК») и `data.address.unrestricted_value` — адрес регистрации.
    """
    data = suggestion.get("data")
    data = data if isinstance(data, dict) else {}
    name = _block(data, "name")
    address = _block(data, "address")
    return OrganizationRequisites(
        name=_text(name.get("short_with_opf"), limit=MAX_NAME_LENGTH),
        kpp=_text(data.get("kpp"), limit=MAX_KPP_LENGTH),
        ogrn=_text(data.get("ogrn"), limit=MAX_OGRN_LENGTH),
        address=_text(address.get("unrestricted_value"), limit=MAX_ADDRESS_LENGTH),
    )


def _first_suggestion(body: object) -> dict[str, object] | None:
    """Первая подсказка ответа. Пустой `suggestions` — это «не найдено».

    Незнакомый ИНН приходит как HTTP 200 с пустым списком: это не ошибка сети
    и не поломка сервиса, поэтому наружу идёт `None`.
    """
    if not isinstance(body, dict):
        return None
    suggestions = body.get("suggestions")
    if not isinstance(suggestions, list) or not suggestions:
        return None
    first = suggestions[0]
    return first if isinstance(first, dict) else None


def lookup_organization(
    inn: str,
    *,
    client: httpx.Client | None = None,
    settings: Settings | None = None,
) -> OrganizationRequisites | None:
    """Найти организацию по ИНН в DaData.

    `client` и `settings` — точки подмены для тестов: со своим транспортом
    `httpx` прогон не ходит в сеть, а со своими настройками не зависит от
    переменных окружения машины.

    Возвращает реквизиты, если организация нашлась, `None` — если по ИНН
    ничего нет, и поднимает `DadataUnavailable` — если сервис не ответил,
    ответил ошибкой или ключ пуст. В базу модуль не пишет.
    """
    resolved = settings or get_settings()
    token = resolved.dadata_api_key.strip()
    if not token:
        logger.warning("Ключ DaData не задан: поиск организации недоступен")
        raise DadataUnavailable("Ключ DaData не задан")

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Token {token}",
    }
    owned_client = client is None
    http = client if client is not None else httpx.Client(timeout=resolved.dadata_timeout_seconds)
    try:
        try:
            response = http.post(
                resolved.dadata_url,
                json={"query": inn, "count": 1},
                headers=headers,
            )
        except httpx.HTTPError as error:
            # Текст ошибки httpx содержит адрес запроса, но не ИНН и не ключ.
            raise DadataUnavailable("DaData не ответила") from error
    finally:
        if owned_client:
            http.close()

    if response.status_code >= httpx.codes.BAD_REQUEST:
        # 400 от DaData — это битый или отключённый токен: поломка на нашей
        # стороне, поэтому наружу она идёт тем же «сервис недоступен», а не 422.
        logger.error("DaData ответила %s: поиск организации недоступен", response.status_code)
        raise DadataUnavailable(f"DaData ответила {response.status_code}")

    try:
        body = response.json()
    except ValueError as error:
        raise DadataUnavailable("Ответ DaData не разбирается как JSON") from error

    suggestion = _first_suggestion(body)
    if suggestion is None:
        return None
    return requisites_from_suggestion(suggestion)

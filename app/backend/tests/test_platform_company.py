"""Платформенный контур: реквизиты поставщика (issue #179).

Проверяется то, что видит кабинет оператора и что потом попадает в печатные
формы:

* `401` без сервисного токена, с неверным токеном и при пустом секрете контура;
* `GET` на пустой базе — `200` со всеми полями `null`, а не `404`: отсутствие
  реквизитов это нормальное первое состояние, а не потерянный ресурс;
* `PATCH` меняет **только** присланные поля: правка строки про НДС не обнуляет
  банк, а отсутствующее поле не трогается вовсе;
* пустая строка после `strip()` и присланный `null` очищают поле — это одно и то
  же «не заполнено», и превращает его в `null` API, а не экран;
* каждый текст `422` — дословно из контракта половин (приставку `Value error, `
  снимает фронтенд, а не API);
* создания строки нет: `PATCH` по базе без засева — `404`, строка не заводится.
"""

from collections.abc import Iterator
from datetime import datetime
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.company_details import SINGLE_ROW_ID, CompanyDetails
from app.schemas.company_details import (
    ADDRESS_TOO_LONG_MESSAGE,
    BANK_ACCOUNT_FORMAT_MESSAGE,
    BANK_BIC_FORMAT_MESSAGE,
    BANK_NAME_TOO_LONG_MESSAGE,
    CORR_ACCOUNT_FORMAT_MESSAGE,
    KPP_FORMAT_MESSAGE,
    NAME_TOO_LONG_MESSAGE,
    OGRN_FORMAT_MESSAGE,
    SIGNATORY_TOO_LONG_MESSAGE,
    VAT_NOTE_TOO_LONG_MESSAGE,
)
from app.schemas.organization import INN_FORMAT_MESSAGE
from app.security import INVALID_OPERATOR_TOKEN_DETAIL

# Заведомо ненастоящий секрет: настоящий в тестах не нужен.
SERVICE_TOKEN = "unit-test-operator-service-token"
OPERATOR_HEADERS = {"X-Operator-Token": SERVICE_TOKEN}
WRONG_HEADERS = {"X-Operator-Token": "not-the-token"}
COMPANY = "/api/platform/company-details"

# Все поля правки: по ним видно, что ответ приходит полным.
FIELDS = (
    "name",
    "inn",
    "kpp",
    "ogrn",
    "address",
    "bank_name",
    "bank_bic",
    "bank_account",
    "corr_account",
    "signatory",
    "vat_note",
)


@pytest.fixture
def operator_token(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Настроенный секрет сервисного контура. Кеш настроек сбрасывается до и после."""
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", SERVICE_TOKEN)
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


@pytest.fixture
def empty_operator_token(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Пустой секрет: платформенные ручки закрыты целиком."""
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", "")
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


def add_company(db_session: Session, **fields: object) -> CompanyDetails:
    """Засев строки руками: миграции в юнит-прогоне нет."""
    row = CompanyDetails(id=SINGLE_ROW_ID, **fields)
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def stored(db_session: Session) -> CompanyDetails | None:
    """Строка из базы, а не из identity map сессии."""
    db_session.expire_all()
    return db_session.scalar(select(CompanyDetails).where(CompanyDetails.id == SINGLE_ROW_ID))


def rows_count(db_session: Session) -> int:
    return db_session.scalar(select(func.count()).select_from(CompanyDetails)) or 0


def error_message(response_body: dict[str, Any]) -> str:
    """Текст первой ошибки валидации: приставку `Value error, ` ставит pydantic."""
    detail = cast(list[dict[str, Any]], response_body["detail"])
    return str(detail[0]["msg"])


# --- Токен ------------------------------------------------------------------


def test_missing_token_is_unauthorized(client: TestClient, operator_token: None) -> None:
    response = client.get(COMPANY)

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


def test_wrong_token_is_unauthorized(client: TestClient, operator_token: None) -> None:
    response = client.get(COMPANY, headers=WRONG_HEADERS)

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


def test_empty_configured_secret_closes_the_routes(
    client: TestClient, empty_operator_token: None
) -> None:
    """Пустой секрет — не «пускаем всех», а «закрыто совсем»."""
    response = client.get(COMPANY, headers=OPERATOR_HEADERS)

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


def test_patch_requires_the_token_too(client: TestClient, operator_token: None) -> None:
    """Зависимость стоит на роутере целиком: правка закрыта так же, как чтение."""
    response = client.patch(COMPANY, json={"name": "ООО «Домовой»"})

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


# --- Чтение -----------------------------------------------------------------


def test_get_on_an_empty_database_is_ok_with_nulls(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Отсутствие строки — `200` с пустыми значениями, а не `404`.

    Строку засевает миграция; в базе без неё кабинет показывает пустую форму, а
    печатная форма печатает заглушку. Различать эти состояния экрану незачем.
    """
    response = client.get(COMPANY, headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == SINGLE_ROW_ID
    for field in FIELDS:
        assert body[field] is None, field
    assert body["updated_at"] is None
    assert rows_count(db_session) == 0


def test_get_returns_the_stored_row(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    add_company(
        db_session,
        name="ООО «Домовой»",
        inn="7701234567",
        kpp="770101001",
        ogrn="1027700132195",
        address="г. Москва, ул. Тверская, д. 1",
        bank_name="ПАО «Банк»",
        bank_bic="044525225",
        bank_account="40702810100000000001",
        corr_account="30101810400000000225",
        signatory="Директор Петров П. П.",
        vat_note="НДС не облагается",
    )

    response = client.get(COMPANY, headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == SINGLE_ROW_ID
    assert body["name"] == "ООО «Домовой»"
    assert body["inn"] == "7701234567"
    assert body["kpp"] == "770101001"
    assert body["ogrn"] == "1027700132195"
    assert body["address"] == "г. Москва, ул. Тверская, д. 1"
    assert body["bank_name"] == "ПАО «Банк»"
    assert body["bank_bic"] == "044525225"
    assert body["bank_account"] == "40702810100000000001"
    assert body["corr_account"] == "30101810400000000225"
    assert body["signatory"] == "Директор Петров П. П."
    assert body["vat_note"] == "НДС не облагается"
    assert body["updated_at"] is not None
    # Ответ приходит полным набором полей, а не только заполненными.
    assert set(body) == {"id", *FIELDS, "updated_at"}


# --- Правка -----------------------------------------------------------------


def test_patch_changes_only_the_sent_fields(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`PATCH` двух полей не обнуляет остальные: `purchase` не должен их терять."""
    add_company(db_session)

    response = client.patch(
        COMPANY,
        headers=OPERATOR_HEADERS,
        json={"name": "ООО «Домовой»", "inn": "7701234567"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "ООО «Домовой»"
    assert body["inn"] == "7701234567"
    for field in FIELDS:
        if field in ("name", "inn"):
            continue
        assert body[field] is None, field

    row = stored(db_session)
    assert row is not None
    assert row.name == "ООО «Домовой»"
    assert row.inn == "7701234567"
    assert row.bank_name is None
    assert row.vat_note is None


def test_patch_keeps_previously_filled_fields(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Правка банка не стирает название: каждое поле меняется своим `PATCH`."""
    add_company(db_session, name="ООО «Домовой»")

    response = client.patch(
        COMPANY,
        headers=OPERATOR_HEADERS,
        json={"bank_name": "ПАО «Банк»", "bank_bic": "044525225"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "ООО «Домовой»"
    assert body["bank_name"] == "ПАО «Банк»"
    assert body["bank_bic"] == "044525225"


def test_patch_with_an_empty_string_clears_the_field(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Пустая строка равна `null`: строка про НДС исчезает из формы целиком."""
    add_company(db_session, vat_note="НДС не облагается")

    response = client.patch(COMPANY, headers=OPERATOR_HEADERS, json={"vat_note": ""})

    assert response.status_code == 200, response.text
    assert response.json()["vat_note"] is None
    row = stored(db_session)
    assert row is not None
    assert row.vat_note is None


def test_patch_with_spaces_only_clears_the_field(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Строка из пробелов — тот же «пустой» случай, что и пустая строка."""
    add_company(db_session, vat_note="НДС не облагается")

    response = client.patch(COMPANY, headers=OPERATOR_HEADERS, json={"vat_note": "   "})

    assert response.status_code == 200, response.text
    assert response.json()["vat_note"] is None


def test_patch_with_null_clears_the_field(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Присланный `null` — тот же «стереть значение», что и пустая строка."""
    add_company(db_session, signatory="Директор Петров П. П.")

    response = client.patch(COMPANY, headers=OPERATOR_HEADERS, json={"signatory": None})

    assert response.status_code == 200, response.text
    assert response.json()["signatory"] is None


def test_patch_trims_the_surrounding_spaces(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Пробелы по краям отбрасываются: документ не печатает их как часть реквизита."""
    add_company(db_session)

    response = client.patch(
        COMPANY,
        headers=OPERATOR_HEADERS,
        json={"name": "  ООО «Домовой»  ", "address": " г. Москва "},
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "ООО «Домовой»"
    assert response.json()["address"] == "г. Москва"


def test_patch_with_an_empty_body_changes_nothing(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Пустое тело — не ошибка: строка возвращается как есть."""
    add_company(db_session, name="ООО «Домовой»", updated_at=datetime(2026, 1, 1))

    response = client.patch(COMPANY, headers=OPERATOR_HEADERS, json={})

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "ООО «Домовой»"
    assert response.json()["updated_at"].startswith("2026-01-01")


def test_patch_without_a_row_is_not_found(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Создания строки в API нет: править нечего — `404`, а не тихое создание."""
    response = client.patch(COMPANY, headers=OPERATOR_HEADERS, json={"name": "ООО «Домовой»"})

    assert response.status_code == 404
    assert response.json()["detail"] == "Реквизиты поставщика не заведены"
    assert rows_count(db_session) == 0


def test_patch_rejects_an_unknown_field(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`extra="forbid"`: опечатка в имени поля — ошибка клиента, а не тихий пропуск."""
    add_company(db_session)

    response = client.patch(COMPANY, headers=OPERATOR_HEADERS, json={"Название": "ООО"})

    assert response.status_code == 422


# --- Форматы и длины ---------------------------------------------------------
#
# Тексты — контракт половин: их показывает фронтенд дословно, сняв приставку
# `Value error, `. Поэтому здесь сравнивается текст целиком, а не подстрока.


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"inn": "77012345678"}, INN_FORMAT_MESSAGE),
        ({"kpp": "77010100"}, KPP_FORMAT_MESSAGE),
        ({"kpp": "7701010011"}, KPP_FORMAT_MESSAGE),
        ({"ogrn": "102770013219"}, OGRN_FORMAT_MESSAGE),
        ({"ogrn": "10277001321950"}, OGRN_FORMAT_MESSAGE),
        ({"bank_bic": "04452522"}, BANK_BIC_FORMAT_MESSAGE),
        ({"bank_account": "4070281010000000000"}, BANK_ACCOUNT_FORMAT_MESSAGE),
        ({"corr_account": "3010181040000000022"}, CORR_ACCOUNT_FORMAT_MESSAGE),
        ({"name": "я" * 256}, NAME_TOO_LONG_MESSAGE),
        ({"address": "я" * 501}, ADDRESS_TOO_LONG_MESSAGE),
        ({"bank_name": "я" * 256}, BANK_NAME_TOO_LONG_MESSAGE),
        ({"signatory": "я" * 301}, SIGNATORY_TOO_LONG_MESSAGE),
        ({"vat_note": "я" * 201}, VAT_NOTE_TOO_LONG_MESSAGE),
    ],
)
def test_invalid_values_are_rejected_with_the_contract_text(
    client: TestClient,
    db_session: Session,
    operator_token: None,
    payload: dict[str, str],
    message: str,
) -> None:
    add_company(db_session)

    response = client.patch(COMPANY, headers=OPERATOR_HEADERS, json=payload)

    assert response.status_code == 422, response.text
    assert error_message(response.json()) == f"Value error, {message}"
    # Отказ не записал ничего.
    row = stored(db_session)
    assert row is not None
    assert all(getattr(row, field) is None for field in FIELDS)


@pytest.mark.parametrize(
    "payload",
    [
        {"inn": "7701234567"},
        {"inn": "770123456789"},
        {"kpp": "770101001"},
        {"ogrn": "1027700132195"},
        {"ogrn": "304500116000157"},
        {"bank_bic": "044525225"},
        {"bank_account": "40702810100000000001"},
        {"corr_account": "30101810400000000225"},
        {"name": "ООО «Домовой»"},
        {"vat_note": "НДС не облагается"},
    ],
)
def test_the_documented_formats_are_accepted(
    client: TestClient,
    db_session: Session,
    operator_token: None,
    payload: dict[str, str],
) -> None:
    """Пограничные допустимые значения: 10 и 12 цифр ИНН, 13 и 15 цифр ОГРН."""
    add_company(db_session)

    response = client.patch(COMPANY, headers=OPERATOR_HEADERS, json=payload)

    assert response.status_code == 200, response.text
    field, value = next(iter(payload.items()))
    assert response.json()[field] == value


def test_updated_at_moves_on_edit(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Момент правки меняется: по нему экран отличает сохранённое от прочитанного."""
    add_company(db_session, name="ООО «Домовой»")
    before = client.get(COMPANY, headers=OPERATOR_HEADERS).json()["updated_at"]

    after = client.patch(
        COMPANY, headers=OPERATOR_HEADERS, json={"name": "ООО «Домовой и К»"}
    ).json()["updated_at"]

    assert after is not None
    assert after != before

"""Реквизиты поставщика платформы: чтение и правка для кабинета оператора.

Контур тот же, что у организаций, пользователей, счетов и тарифов: ручки
открывает сервисный токен кабинета (`X-Operator-Token`), а не cookie основного
кабинета. Зависимость стоит на роутере целиком, поэтому новая ручка не может её
забыть.

**Почему `GET` без строки не `404`.** Реквизитов может не быть (пустая база,
тестовое окружение без миграций) — это нормальное первое состояние, а не
потерянный ресурс. Ответ `200` со всеми полями `null` говорит то же самое, но не
заставляет экран различать два состояния.

**Создания строки нет.** Строку засевает миграция `0067_company_details`, и она
одна (`CHECK (id = 1)`). `POST` и `PUT` вне задачи. Если строки всё-таки нет,
`PATCH` отвечает `404`: создавать её из API значило бы завести второй путь
засева, который разошёлся бы с миграцией.

**Правка меняет только присланные поля** (`payload.model_fields_set`): `PATCH`
одной строки про НДС не должен обнулять банк. Пустая строка после `strip()`
приходит из схемы уже как `None` и очищает поле.

Правил проверки значений здесь нет: они в схеме (`app/schemas/company_details.py`),
а чтение для печати — в `app/company_details.py`. Роутер только связывает их с
HTTP.
"""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app import company_details
from app.db import get_db
from app.models.company_details import SINGLE_ROW_ID, CompanyDetails
from app.schemas.company_details import (
    CompanyDetailsResponse,
    UpdateCompanyDetailsRequest,
)
from app.schemas.user import ErrorResponse
from app.security import INVALID_OPERATOR_TOKEN_DETAIL, require_operator_service

router = APIRouter(
    prefix="/platform/company-details",
    tags=["platform"],
    dependencies=[Depends(require_operator_service)],
    responses={
        status.HTTP_401_UNAUTHORIZED: {
            "model": ErrorResponse,
            "description": INVALID_OPERATOR_TOKEN_DETAIL,
        },
    },
)

DbSession = Annotated[Session, Depends(get_db)]

# Отказ, который бывает только у правки: строку засевает миграция, и её
# отсутствие — поломка базы, а не клиента. `404` потому, что править нечего.
ROW_MISSING_DETAIL = "Реквизиты поставщика не заведены"

UPDATE_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": ROW_MISSING_DETAIL,
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "Значение не по формату или длиннее колонки — текст ошибки "
        "показывается клиенту дословно",
    },
}


def _response(row: CompanyDetails | None) -> CompanyDetailsResponse:
    """Форма ответа: строка как есть или пустые значения, если строки нет.

    Пустой ответ собирается здесь, а не в схеме: схема описывает то, что
    печатает форма, а «строки нет» — состояние базы. `id` у единственной строки
    всегда `1`, поэтому он есть и в пустом ответе.
    """
    if row is None:
        return CompanyDetailsResponse(
            id=SINGLE_ROW_ID,
            name=None,
            inn=None,
            kpp=None,
            ogrn=None,
            address=None,
            bank_name=None,
            bank_bic=None,
            bank_account=None,
            corr_account=None,
            signatory=None,
            vat_note=None,
            updated_at=None,
        )
    return CompanyDetailsResponse.model_validate(row)


@router.get(
    "",
    response_model=CompanyDetailsResponse,
    summary="Реквизиты поставщика",
)
def read_company_details(db: DbSession) -> CompanyDetailsResponse:
    """Реквизиты поставщика для кабинета и для проверки перед печатью.

    Строки нет — `200` с пустыми значениями: кабинет показывает пустую форму, а
    печатная форма печатает заглушку поставщика.
    """
    return _response(company_details.load(db))


@router.patch(
    "",
    response_model=CompanyDetailsResponse,
    summary="Изменить реквизиты поставщика",
    responses=UPDATE_RESPONSES,
)
def update_company_details(
    payload: UpdateCompanyDetailsRequest,
    db: DbSession,
) -> CompanyDetailsResponse:
    """Правка: меняются только поля, пришедшие в теле.

    `updated_at` ставится здесь, а не базой: `server_default` работает только
    при вставке, а момент правки нужен экрану, чтобы отличить «только что
    сохранили» от «читаем старое». Время берётся в UTC — как везде в проекте.
    """
    details = company_details.load(db)
    if details is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ROW_MISSING_DETAIL)

    changed = payload.model_fields_set
    for field in changed:
        setattr(details, field, getattr(payload, field))

    # Пустое тело — не ошибка: `PATCH {}` ничего не меняет и возвращает строку
    # как есть. Коммит при этом не нужен, и `updated_at` не сдвигается.
    if changed:
        details.updated_at = datetime.now(UTC)
        db.commit()
        db.refresh(details)
    return _response(details)

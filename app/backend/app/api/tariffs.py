"""Публичный прайс и правка тарифов из кабинета.

`GET /api/tariffs` открыт анониму, как `GET /api/health`: страница `/pricing`
доступна без сессии. Ручка отдаёт только опубликованные тарифы
(`is_visible = true`) и не умеет показать скрытые ни при каких параметрах — этого
не позволяет сам запрос, а не проверка после выборки.

Остальные ручки — под `TariffEditor`: правку тарифов разрешает
`require_organization_edit` из `app.api.organization`, то есть роль `owner` или
`admin`. Коды отказа там же: 401 без сессии, 403 роли без права, 404 без
членства.

`/current` — тариф самой организации, а не прайс: его читает любой участник
(роль не важна, это свои данные), а меняет только `TariffEditor`. Выбрать можно
лишь опубликованный тариф (`is_visible = true`): скрытый тариф не продаётся, и
для клиента его как будто нет — отсюда 404, а не 403.

Удаление жёсткое: тарифы пока ни на что не ссылаются, и «мягкое» удаление
завело бы второй способ скрыть тариф — помимо `is_visible`. Организации,
выбравшие удаляемый тариф, остаются без него: внешний ключ объявлен с
`ON DELETE SET NULL`.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.access import TariffEditor
from app.api.organization import (
    EDIT_ROLES,
    ORGANIZATION_NOT_FOUND_DETAIL,
    Membership,
)
from app.db import get_db
from app.models.organization import Organization
from app.models.tariff import Tariff
from app.pricing import format_price
from app.schemas.tariff import (
    CreateTariffRequest,
    OrganizationTariffResponse,
    SetOrganizationTariffRequest,
    TariffResponse,
    UpdateTariffRequest,
)
from app.schemas.user import ErrorResponse

router = APIRouter(prefix="/tariffs", tags=["tariffs"])
DbSession = Annotated[Session, Depends(get_db)]

TARIFF_NOT_FOUND_DETAIL = "Тариф не найден"
TARIFF_NAME_TAKEN_DETAIL = "Тариф с таким названием уже есть"
INVALID_TARIFF_DETAIL = "Некорректные поля тарифа"
BROKEN_JSON_DETAIL = "Тело запроса не разбирается как JSON"

# Ответы ручек под `TariffEditor`. 403 здесь один на два случая: неактивированный
# кабинет и роль без права правки — FastAPI не даёт объявить один код дважды.
EDITOR_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: {
        "model": ErrorResponse,
        "description": "Требуется авторизация",
    },
    status.HTTP_403_FORBIDDEN: {
        "model": ErrorResponse,
        "description": "Кабинет не активирован или роль без права правки тарифов",
    },
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": ORGANIZATION_NOT_FOUND_DETAIL,
    },
}

# Тело, которое не декодируется как UTF-8, FastAPI превращает в 400 до валидации.
BROKEN_JSON_RESPONSE: dict[int | str, dict[str, Any]] = {
    status.HTTP_400_BAD_REQUEST: {"model": ErrorResponse, "description": BROKEN_JSON_DETAIL},
}

TARIFF_ID = Annotated[int, Path(ge=1, le=2147483647)]


def _response(tariff: Tariff, *, editable: bool) -> TariffResponse:
    """Ответ по строке тарифа: `price_label` считает сервер, клиент его не собирает."""
    return TariffResponse(
        id=tariff.id,
        name=tariff.name,
        description=tariff.description,
        amount=tariff.amount,
        currency=tariff.currency,
        period=tariff.period,
        unit_label=tariff.unit_label,
        position=tariff.position,
        is_visible=tariff.is_visible,
        price_label=format_price(tariff.amount, tariff.currency, tariff.period, tariff.unit_label),
        editable=editable,
    )


def _ordered_tariffs(db: Session) -> list[Tariff]:
    """Порядок прайса: `position`, а при равных — `id`, чтобы он был устойчив."""
    return list(db.scalars(select(Tariff).order_by(Tariff.position, Tariff.id)))


def _load_tariff(db: Session, tariff_id: int) -> Tariff:
    tariff = db.get(Tariff, tariff_id)
    if tariff is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, TARIFF_NOT_FOUND_DETAIL)
    return tariff


def _name_taken(db: Session, name: str, *, exclude_id: int | None = None) -> bool:
    """Занято ли название, без учёта регистра. Свой же тариф конфликтом не считается.

    Сравнение идёт в Python, а не в SQL: `lower()` в SQLite кириллицу не знает, и
    «Базовый» с «базовый» прошли бы как разные — тесты разошлись бы со стендом на
    PostgreSQL. Тарифов в прайсе немного, и выборка имён дешевле неверного ответа.
    """
    query = select(Tariff.name)
    if exclude_id is not None:
        query = query.where(Tariff.id != exclude_id)
    folded = name.casefold()
    return any(stored.casefold() == folded for stored in db.scalars(query))


@router.get("", response_model=list[TariffResponse], summary="Опубликованные тарифы")
def list_tariffs(db: DbSession) -> list[TariffResponse]:
    """Прайс для страницы `/pricing`: только видимые тарифы и без авторизации."""
    visible = db.scalars(
        select(Tariff).where(Tariff.is_visible.is_(True)).order_by(Tariff.position, Tariff.id)
    )
    return [_response(tariff, editable=False) for tariff in visible]


@router.get(
    "/manage",
    response_model=list[TariffResponse],
    summary="Все тарифы для кабинета",
    responses=EDITOR_RESPONSES,
)
def manage_tariffs(_membership: TariffEditor, db: DbSession) -> list[TariffResponse]:
    """Полный список, включая скрытые: кабинет показывает и то, что не опубликовано."""
    return [_response(tariff, editable=True) for tariff in _ordered_tariffs(db)]


def _load_organization(db: Session, organization_id: int) -> Organization:
    organization = db.get(Organization, organization_id)
    if organization is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ORGANIZATION_NOT_FOUND_DETAIL)
    return organization


def _organization_tariff(
    organization: Organization, db: Session, *, editable: bool
) -> OrganizationTariffResponse:
    """Собрать ответ по тарифу организации: `None` — тариф ещё не выбран."""
    if organization.tariff_id is None:
        return OrganizationTariffResponse(tariff=None, editable=editable)
    tariff = db.get(Tariff, organization.tariff_id)
    if tariff is None:
        # Внешний ключ с `ON DELETE SET NULL` такого не допускает: ссылка на
        # удалённый тариф обнуляется вместе с удалением. Ответ без тарифа лучше
        # падения экрана, если строка всё же разошлась.
        return OrganizationTariffResponse(tariff=None, editable=editable)
    return OrganizationTariffResponse(
        tariff=_response(tariff, editable=editable), editable=editable
    )


@router.get(
    "/current",
    response_model=OrganizationTariffResponse,
    summary="Тариф организации",
    responses=EDITOR_RESPONSES,
)
def read_organization_tariff(membership: Membership, db: DbSession) -> OrganizationTariffResponse:
    """Купленный организацией тариф. Читает любой участник, роль не важна.

    `editable` показывает роль, а не данные: правят тариф организации только
    `owner` и `admin`, поэтому у `manager` и `commandant` ответ тот же, но без
    кнопок правки на клиенте.
    """
    organization = _load_organization(db, membership.organization_id)
    return _organization_tariff(organization, db, editable=membership.role in EDIT_ROLES)


@router.put(
    "/current",
    response_model=OrganizationTariffResponse,
    summary="Выбрать тариф организации",
    responses={
        **EDITOR_RESPONSES,
        **BROKEN_JSON_RESPONSE,
        status.HTTP_404_NOT_FOUND: {
            "model": ErrorResponse,
            "description": f"{ORGANIZATION_NOT_FOUND_DETAIL} или {TARIFF_NOT_FOUND_DETAIL}",
        },
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": "Неверный id тарифа",
        },
    },
)
def set_organization_tariff(
    payload: SetOrganizationTariffRequest, membership: TariffEditor, db: DbSession
) -> OrganizationTariffResponse:
    """Выбрать организации опубликованный тариф — по одному на организацию.

    Скрытый тариф выбрать нельзя: он не продаётся, и снаружи его не существует.
    Повторный вызов с другим `tariff_id` меняет тариф, с тем же — идемпотентен.
    """
    organization = _load_organization(db, membership.organization_id)
    tariff = db.get(Tariff, payload.tariff_id)
    if tariff is None or not tariff.is_visible:
        raise HTTPException(status.HTTP_404_NOT_FOUND, TARIFF_NOT_FOUND_DETAIL)

    organization.tariff_id = tariff.id
    db.commit()
    db.refresh(organization)
    return _organization_tariff(organization, db, editable=True)


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=TariffResponse,
    summary="Добавить тариф",
    responses={
        **EDITOR_RESPONSES,
        **BROKEN_JSON_RESPONSE,
        status.HTTP_409_CONFLICT: {
            "model": ErrorResponse,
            "description": TARIFF_NAME_TAKEN_DETAIL,
        },
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": INVALID_TARIFF_DETAIL,
        },
    },
)
def create_tariff(
    payload: CreateTariffRequest, _membership: TariffEditor, db: DbSession
) -> TariffResponse:
    """Новый тариф в конец списка: `position` на единицу больше текущего максимума."""
    if _name_taken(db, payload.name):
        raise HTTPException(status.HTTP_409_CONFLICT, TARIFF_NAME_TAKEN_DETAIL)

    next_position = (db.scalar(select(func.max(Tariff.position))) or 0) + 1
    tariff = Tariff(
        name=payload.name,
        description=payload.description,
        amount=payload.amount,
        currency=payload.currency,
        period=payload.period,
        unit_label=payload.unit_label,
        position=next_position,
        is_visible=payload.is_visible,
    )
    db.add(tariff)
    try:
        db.commit()
    except IntegrityError:
        # Гонка двух одновременных созданий с одним названием: сработал
        # уникальный индекс, а не проверка выше.
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, TARIFF_NAME_TAKEN_DETAIL) from None
    db.refresh(tariff)
    return _response(tariff, editable=True)


@router.patch(
    "/{tariff_id}",
    response_model=TariffResponse,
    summary="Изменить тариф",
    responses={
        **EDITOR_RESPONSES,
        **BROKEN_JSON_RESPONSE,
        status.HTTP_409_CONFLICT: {
            "model": ErrorResponse,
            "description": TARIFF_NAME_TAKEN_DETAIL,
        },
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": f"{INVALID_TARIFF_DETAIL} или неверный id",
        },
    },
)
def update_tariff(
    payload: UpdateTariffRequest,
    tariff_id: TARIFF_ID,
    _membership: TariffEditor,
    db: DbSession,
) -> TariffResponse:
    """Частичная правка: меняются только присланные поля."""
    tariff = _load_tariff(db, tariff_id)
    changes = payload.model_dump(exclude_unset=True)

    name = changes.get("name")
    if name is not None and _name_taken(db, name, exclude_id=tariff.id):
        raise HTTPException(status.HTTP_409_CONFLICT, TARIFF_NAME_TAKEN_DETAIL)

    for field, value in changes.items():
        setattr(tariff, field, value)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, TARIFF_NAME_TAKEN_DETAIL) from None
    db.refresh(tariff)
    return _response(tariff, editable=True)


@router.delete(
    "/{tariff_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Удалить тариф",
    responses={
        **EDITOR_RESPONSES,
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": "Неверный id тарифа",
        },
    },
)
def delete_tariff(tariff_id: TARIFF_ID, _membership: TariffEditor, db: DbSession) -> None:
    """Удаление безвозвратное: тариф ни на что не ссылается, корзины нет.

    Организации, выбравшие этот тариф, остаются без тарифа. На PostgreSQL это
    сделал бы `ON DELETE SET NULL`, но в юнит-тестах SQLite внешние ключи по
    умолчанию выключены, и поведение разошлось бы между стендом и тестами.
    Ссылки снимаются явно, поэтому результат одинаков везде.
    """
    tariff = _load_tariff(db, tariff_id)
    db.execute(
        update(Organization).where(Organization.tariff_id == tariff.id).values(tariff_id=None)
    )
    db.delete(tariff)
    db.commit()

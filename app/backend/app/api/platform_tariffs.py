"""Тарифы платформы: весь прайс, правка полей и снятие с продажи.

Контур отдельный, как у организаций, пользователей и счетов: ручки открывает
сервисный токен кабинета оператора (`X-Operator-Token`), а не cookie основного
кабинета. Зависимость стоит на роутере целиком, поэтому новая ручка не может её
забыть.

Что здесь иначе, чем в публичном прайсе (`app/api/tariffs.py`):

* `GET` отдаёт **все** строки прайса, включая скрытые (`is_visible = false`):
  кабинет оператора — это и есть место, где скрытые строки видно. Пагинации нет:
  строк в прайсе около пятнадцати, а публичная ручка отдаёт такой же плоский
  список;
* правка меняет только поля, пришедшие в теле (`payload.model_fields_set`):
  `PATCH` одного описания не обнуляет цену;
* занятость названия проверяется в Python (`casefold()`), а не в SQL: `lower()` в
  SQLite не знает кириллицу, и «Рост» с «РОСТ» прошли бы как разные имена.

**`DELETE` ничего не удаляет.** Он ставит `is_visible = false`: на строку
ссылаются `organizations.tariff_id` / `next_tariff_id` и `invoices.tariff_id`, а
счета хранят снимок названия. Скрытый тариф пропадает из публичного прайса и со
страницы `/pricing`, но организация, которой он назначен, продолжает его видеть
(`GET /api/tariffs/current`). Повторный `DELETE` — тоже `204`: команда
идемпотентна, а `404` остаётся только для неизвестного `id`.
"""

from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.tariffs import tariff_response
from app.db import get_db
from app.models.tariff import Tariff
from app.schemas.platform_tariff import UpdateTariffRequest
from app.schemas.tariff import TariffResponse
from app.schemas.user import ErrorResponse
from app.security import INVALID_OPERATOR_TOKEN_DETAIL, require_operator_service

# Зависимость на роутере целиком: ни одна ручка платформенного контура не
# открывается без сервисного токена.
router = APIRouter(
    prefix="/platform/tariffs",
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

# Тексты отказов — часть контракта кабинета: он передаёт их дословно, а
# фронтенд показывает в `role="alert"`.
TARIFF_NOT_FOUND_DETAIL = "Тариф не найден"
TARIFF_NAME_TAKEN_DETAIL = "Тариф с таким названием уже есть"

UPDATE_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": TARIFF_NOT_FOUND_DETAIL,
    },
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": TARIFF_NAME_TAKEN_DETAIL,
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "Пустое или длинное название, отрицательная или слишком большая "
        "цена, неизвестный период, отрицательное количество пользователей",
    },
}

DELETE_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": TARIFF_NOT_FOUND_DETAIL,
    },
}


def load_tariff(db: Session, tariff_id: int) -> Tariff:
    """Строка прайса по `id`; неизвестный `id` — тот же `404` у всех ручек."""
    tariff = db.get(Tariff, tariff_id)
    if tariff is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, TARIFF_NOT_FOUND_DETAIL)
    return tariff


def tariff_name_taken(db: Session, name: str, exclude_id: int) -> bool:
    """Занято ли название — без учёта регистра и без собственной строки.

    Сравнение идёт в Python (`casefold()`): `lower()` в SQLite не знает
    кириллицу, и запрос `WHERE lower(name) = ...` пропустил бы «РОСТ» мимо
    «Рост». Строк в прайсе около пятнадцати, поэтому читать их целиком дешевле,
    чем держать вторую копию правила на стороне базы.
    """
    wanted = name.casefold()
    names = db.scalars(select(Tariff.name).where(Tariff.id != exclude_id)).all()
    return any(existing.casefold() == wanted for existing in names)


@router.get(
    "",
    response_model=list[TariffResponse],
    summary="Весь прайс платформы",
)
def list_tariffs(db: DbSession) -> list[TariffResponse]:
    """Все строки прайса, включая снятые с продажи, в порядке `position`, `id`.

    Порядок тот же, что у публичной ручки: кабинет оператора показывает прайс в
    том же порядке, в каком его увидит покупатель.
    """
    rows = db.scalars(select(Tariff).order_by(Tariff.position, Tariff.id)).all()
    return [tariff_response(tariff) for tariff in rows]


@router.patch(
    "/{tariff_id}",
    response_model=TariffResponse,
    summary="Изменить тариф",
    responses=UPDATE_RESPONSES,
)
def update_tariff(tariff_id: int, payload: UpdateTariffRequest, db: DbSession) -> TariffResponse:
    """Правка: меняются только пришедшие поля, отсутствующее не обнуляется.

    Занятость названия проверяется заранее и ловится ещё раз на `commit`:
    между проверкой и записью соседний оператор мог занять то же имя, и
    уникальный индекс — последняя линия обороны. Обе ветки отвечают одним и тем
    же `409`, потому что для клиента это одно состояние.
    """
    tariff = load_tariff(db, tariff_id)

    if "name" in payload.model_fields_set and tariff_name_taken(
        db,
        # Валидатор схемы не пропустит `null`: пришедшее имя — всегда строка.
        cast(str, payload.name),
        tariff.id,
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, TARIFF_NAME_TAKEN_DETAIL)

    for field in payload.model_fields_set:
        setattr(tariff, field, getattr(payload, field))
    try:
        db.commit()
    except IntegrityError:
        # Гонка на уникальном названии: предварительная проверка прошла,
        # уникальный индекс — нет.
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, TARIFF_NAME_TAKEN_DETAIL) from None
    db.refresh(tariff)
    return tariff_response(tariff)


@router.delete(
    "/{tariff_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Снять тариф с продажи",
    responses=DELETE_RESPONSES,
)
def delete_tariff(tariff_id: int, db: DbSession) -> None:
    """Снятие с продажи: `is_visible = false`, строку не удаляем.

    Удалять нельзя: на строку ссылаются организации и счета, а счёт хранит
    снимок названия. Поэтому «удаление» в кабинете — это публикация, выключенная
    в одну сторону: тариф пропадает из прайса, но остаётся у тех, кому он уже
    назначен. Повторный вызов на скрытой строке — тот же `204`: клиент не должен
    различать «уже снят» и «снял только что».
    """
    tariff = load_tariff(db, tariff_id)
    if not tariff.is_visible:
        return
    tariff.is_visible = False
    db.commit()

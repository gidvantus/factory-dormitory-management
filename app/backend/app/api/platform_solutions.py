"""Каталог решений платформы: весь список, правка полей и снятие с продажи (#188).

Контур отдельный, как у тарифов, организаций, пользователей и счетов: ручки
открывает сервисный токен кабинета оператора (`X-Operator-Token`), а не cookie
основного кабинета. Зависимость стоит на роутере целиком, поэтому новая ручка не
может её забыть.

Что здесь иначе, чем в публичном каталоге (`app/api/solutions.py`):

* `GET` отдаёт **все** строки каталога, включая снятые с продажи
  (`is_visible = false`): кабинет оператора — это и есть место, где скрытые
  строки видно. Пагинации нет: строк каталога единицы, а публичная ручка отдаёт
  такой же плоский список;
* порядок тот же, что у витрины, — `position`, затем `id`. Ничья решается `id`,
  и это контракт порядка, а не дефект: одинаковые `position` разрешены;
* правка меняет только поля, пришедшие в теле (`payload.model_fields_set`):
  `PATCH` одного описания не обнуляет цену;
* занятость названия проверяется в Python (`casefold()`), а не в SQL: `lower()` в
  SQLite не знает кириллицу, и «Журнал» с «ЖУРНАЛ» прошли бы как разные имена.

**`DELETE` ничего не удаляет.** Он ставит `is_visible = false`: на строку
ссылаются `invoices.solution_id` и `organization_solutions`, а счёт хранит снимок
названия и периода. Скрытое решение пропадает из магазина, но право организации
на него продолжает действовать — на сервере платная функция работает по-прежнему,
пропадает только вход через меню. Повторный `DELETE` — тоже `204`: команда
идемпотентна, а `404` остаётся только для неизвестного `id`.

Создания строк здесь нет намеренно: `code` — гейт функции (`has_solution`), и
новой строке нечего открывать.
"""

from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.solution import Solution
from app.pricing import format_price
from app.schemas.platform_solution import SolutionAdminResponse, UpdateSolutionRequest
from app.schemas.user import ErrorResponse
from app.security import INVALID_OPERATOR_TOKEN_DETAIL, require_operator_service

# Зависимость на роутере целиком: ни одна ручка платформенного контура не
# открывается без сервисного токена.
router = APIRouter(
    prefix="/platform/solutions",
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
SOLUTION_NOT_FOUND_DETAIL = "Решение не найдено"
SOLUTION_NAME_TAKEN_DETAIL = "Решение с таким названием уже есть"

UPDATE_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": SOLUTION_NOT_FOUND_DETAIL,
    },
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": SOLUTION_NAME_TAKEN_DETAIL,
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "Пустое или длинное название, описание не строкой, отрицательная "
        "или слишком большая цена, валюта не из трёх заглавных латинских букв, "
        "неизвестный период, нецелый или отрицательный порядок, состояние не true/false",
    },
}

DELETE_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": SOLUTION_NOT_FOUND_DETAIL,
    },
}


def load_solution(db: Session, solution_id: int) -> Solution:
    """Строка каталога по `id`; неизвестный `id` — тот же `404` у всех ручек."""
    solution = db.get(Solution, solution_id)
    if solution is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, SOLUTION_NOT_FOUND_DETAIL)
    return solution


def solution_name_taken(db: Session, name: str, exclude_id: int) -> bool:
    """Занято ли название — без учёта регистра и без собственной строки.

    Сравнение идёт в Python (`casefold()`): `lower()` в SQLite не знает
    кириллицу, и запрос `WHERE lower(name) = ...` пропустил бы «ЖУРНАЛ» мимо
    «Журнал». Строк в каталоге единицы, поэтому читать их целиком дешевле, чем
    держать вторую копию правила на стороне базы.
    """
    wanted = name.casefold()
    names = db.scalars(select(Solution.name).where(Solution.id != exclude_id)).all()
    return any(existing.casefold() == wanted for existing in names)


def solution_response(solution: Solution) -> SolutionAdminResponse:
    """Ответ по строке каталога: `price_label` считает сервер, клиент его не собирает.

    Подпись цены собирает `app.pricing.format_price` — та же функция, что у
    витрины магазина: второй формулы цены нет.
    """
    return SolutionAdminResponse(
        id=solution.id,
        code=solution.code,
        name=solution.name,
        description=solution.description,
        amount=solution.amount,
        currency=solution.currency,
        period=solution.period,
        position=solution.position,
        is_visible=solution.is_visible,
        price_label=format_price(solution.amount, solution.currency, solution.period),
        created_at=solution.created_at,
        updated_at=solution.updated_at,
    )


@router.get(
    "",
    response_model=list[SolutionAdminResponse],
    summary="Весь каталог решений",
)
def list_solutions(db: DbSession) -> list[SolutionAdminResponse]:
    """Все строки каталога, включая снятые с продажи, в порядке `position`, `id`.

    Порядок тот же, что у витрины магазина: кабинет оператора показывает решения в
    том порядке, в каком их увидит покупатель.
    """
    rows = db.scalars(select(Solution).order_by(Solution.position, Solution.id)).all()
    return [solution_response(solution) for solution in rows]


@router.patch(
    "/{solution_id}",
    response_model=SolutionAdminResponse,
    summary="Изменить решение",
    responses=UPDATE_RESPONSES,
)
def update_solution(
    solution_id: int, payload: UpdateSolutionRequest, db: DbSession
) -> SolutionAdminResponse:
    """Правка: меняются только пришедшие поля, отсутствующее не обнуляется.

    Занятость названия проверяется заранее и ловится ещё раз на `commit`: между
    проверкой и записью соседний оператор мог занять то же имя, и уникальный
    индекс — последняя линия обороны. Обе ветки отвечают одним и тем же `409`,
    потому что для клиента это одно состояние.
    """
    solution = load_solution(db, solution_id)

    if "name" in payload.model_fields_set and solution_name_taken(
        db,
        # Валидатор схемы не пропустит `null`: пришедшее имя — всегда строка.
        cast(str, payload.name),
        solution.id,
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, SOLUTION_NAME_TAKEN_DETAIL)

    for field in payload.model_fields_set:
        setattr(solution, field, getattr(payload, field))
    try:
        db.commit()
    except IntegrityError:
        # Гонка на уникальном названии: предварительная проверка прошла,
        # уникальный индекс — нет.
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, SOLUTION_NAME_TAKEN_DETAIL) from None
    db.refresh(solution)
    return solution_response(solution)


@router.delete(
    "/{solution_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Снять решение с продажи",
    responses=DELETE_RESPONSES,
)
def delete_solution(solution_id: int, db: DbSession) -> None:
    """Снятие с продажи: `is_visible = false`, строку не удаляем.

    Удалять нельзя: на строку ссылаются счета и права организаций, а счёт хранит
    снимок названия и периода. Поэтому «удаление» в кабинете — это публикация,
    выключенная в одну сторону: карточка пропадает из магазина, но платная
    функция у организации с действующим правом работает по-прежнему. Повторный
    вызов на скрытой строке — тот же `204`: клиент не должен различать «уже снят»
    и «снял только что».
    """
    solution = load_solution(db, solution_id)
    if not solution.is_visible:
        return
    solution.is_visible = False
    db.commit()

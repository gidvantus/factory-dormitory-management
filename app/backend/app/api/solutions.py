"""Магазин улучшений: каталог решений для кабинета.

Ручка только читает: решение покупается существующей ручкой счёта
(`POST /api/billing/invoices` с `solution_id`), отдельной ручки покупки здесь нет
намеренно — она дублировала бы проверки и снимок предмета.

**Срок права — срок тарифа.** У решений нет собственного срока: карточка
показывает `period = "once"` и цену «…разово», а `expires_at` у купленного решения
— это конец действующего тарифа организации (`app.subscription.subscription_state`),
чтобы витрина могла сказать «действует, пока действует тариф, до такого-то дня».
Истёк тариф — `is_owned = false` и `expires_at = null`, хотя строка права остаётся.

Коды отказа — как у `GET /api/tariffs/current`: 401 без сессии, 403 без
активированного кабинета, 404 без организации у пользователя. Скрытые строки
каталога (`is_visible = false`) в список не попадают ни при каких параметрах
запроса: их отсекает сам запрос, а не проверка после выборки.
"""

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.organization import ORGANIZATION_NOT_FOUND_DETAIL, Membership
from app.db import get_db
from app.models.solution import Solution
from app.pricing import format_price
from app.schemas.solution import SolutionResponse, SolutionsResponse
from app.schemas.user import ErrorResponse
from app.solutions import owned_codes
from app.subscription import ONCE_PERIOD, subscription_state

router = APIRouter(prefix="/solutions", tags=["solutions"])
DbSession = Annotated[Session, Depends(get_db)]

# Ответы каталога: 403 здесь — неактивированный кабинет.
CATALOG_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: {
        "model": ErrorResponse,
        "description": "Требуется авторизация",
    },
    status.HTTP_403_FORBIDDEN: {
        "model": ErrorResponse,
        "description": "Кабинет не активирован",
    },
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": ORGANIZATION_NOT_FOUND_DETAIL,
    },
}


def _response(
    solution: Solution, *, is_owned: bool, expires_at: datetime | None
) -> SolutionResponse:
    """Ответ по строке каталога: `price_label` считает сервер, клиент его не собирает.

    Период в ответе — всегда `once`, а не значение из строки каталога: своего срока
    у решения больше нет (`app.solutions`), и цена поэтому читается как «500 ₽
    разово». Колонка `solutions.period` остаётся в схеме и нормализуется миграцией
    `0068_solutions_tariff_scope`, но ответ на неё не смотрит.
    """
    return SolutionResponse(
        id=solution.id,
        code=solution.code,
        name=solution.name,
        description=solution.description,
        amount=solution.amount,
        currency=solution.currency,
        period=ONCE_PERIOD,
        price_label=format_price(solution.amount, solution.currency, ONCE_PERIOD),
        is_owned=is_owned,
        expires_at=expires_at,
    )


@router.get(
    "",
    response_model=SolutionsResponse,
    summary="Каталог решений",
    responses=CATALOG_RESPONSES,
)
def list_solutions(membership: Membership, db: DbSession) -> SolutionsResponse:
    """Каталог с признаком владения для организации пользователя.

    Читает любой участник, роль не важна: это витрина, а не правка. Порядок —
    `position`, затем `id`: он задан данными, а не алфавитом названий.

    `expires_at` — конец **действующего тарифа** организации, и только у купленного
    решения: у некупленного срока права нет вовсе, а у бессрочного тарифа конца нет
    и поле остаётся `null`.
    """
    visible = db.scalars(
        select(Solution)
        .where(Solution.is_visible.is_(True))
        .order_by(Solution.position, Solution.id)
    )
    owned = owned_codes(db, membership.organization_id)
    # Действующий тариф спрашивается один раз на весь каталог: `subscription_state`
    # читает организацию и строки прайса, а не по разу на карточку.
    tariff_ends_at = subscription_state(db, membership.organization_id).ends_at
    return SolutionsResponse(
        items=[
            _response(
                solution,
                is_owned=solution.code in owned,
                expires_at=tariff_ends_at if solution.code in owned else None,
            )
            for solution in visible
        ]
    )

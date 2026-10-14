"""Магазин улучшений: каталог решений для кабинета.

Ручка только читает: решение покупается существующей ручкой счёта
(`POST /api/billing/invoices` с `solution_id`), отдельной ручки покупки здесь нет
намеренно — она дублировала бы проверки и снимок предмета.

Коды отказа — как у `GET /api/tariffs/current`: 401 без сессии, 403 без
активированного кабинета, 404 без организации у пользователя. Скрытые строки
каталога (`is_visible = false`) в список не попадают ни при каких параметрах
запроса: их отсекает сам запрос, а не проверка после выборки.
"""

from datetime import datetime
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.organization import ORGANIZATION_NOT_FOUND_DETAIL, Membership
from app.db import get_db
from app.models.solution import Solution
from app.pricing import format_price
from app.schemas.solution import SolutionResponse, SolutionsResponse
from app.schemas.tariff import TariffPeriod
from app.schemas.user import ErrorResponse
from app.solutions import entitlements

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
    """Ответ по строке каталога: `price_label` считает сервер, клиент его не собирает."""
    return SolutionResponse(
        id=solution.id,
        code=solution.code,
        name=solution.name,
        description=solution.description,
        amount=solution.amount,
        currency=solution.currency,
        # В колонке `VARCHAR(10)` набор значений держит `CHECK` по тем же
        # периодам, что перечисляет `TariffPeriod`; приведение говорит об этом
        # типизатору, а не ослабляет проверку.
        period=cast(TariffPeriod, solution.period),
        price_label=format_price(solution.amount, solution.currency, solution.period),
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
    """
    visible = db.scalars(
        select(Solution)
        .where(Solution.is_visible.is_(True))
        .order_by(Solution.position, Solution.id)
    )
    owned = entitlements(db, membership.organization_id)
    return SolutionsResponse(
        items=[
            _response(
                solution,
                is_owned=solution.code in owned,
                expires_at=owned.get(solution.code),
            )
            for solution in visible
        ]
    )

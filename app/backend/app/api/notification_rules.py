"""Конструктор правил уведомлений: ручки кабинета по общежитиям.

Все ручки живут под `/api/dormitories/{dormitory_id}/telegram-rules` и закрыты
двумя зависимостями: `SolutionUser` — право организации на решение
`telegram_notifications` (`403` с текстом магазина улучшений) и `OwnDormitory` —
принадлежность общежития организации из сессии (`404`, как у несуществующего).

`dormitory_id` берётся **только из пути**: в теле его нет, поэтому инвентарный
тест `tests/test_route_guard_inventory.py` не требует отдельного гейта, а
подменить общежитие телом запроса нельзя.

Чужое правило — `404`, а не `403`: по коду ответа нельзя узнать, существует ли
правило с таким номером. Предметная логика (каталог, проверка условий, оценка,
очередь доставки) живёт в `app/notification_rules.py`, здесь только HTTP.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, status
from sqlalchemy.orm import Session

from app import notification_rules
from app.access import DORMITORY_NOT_FOUND_DETAIL, OwnDormitory
from app.db import get_db
from app.models.custom_tab import CustomTab
from app.models.dormitory import Dormitory
from app.models.telegram import NotificationRule
from app.models.user import User
from app.notification_rules import (
    COLUMN_UNAVAILABLE_DETAIL,
    NAME_REQUIRED_DETAIL,
    NAME_TOO_LONG_DETAIL,
    OPERATOR_MISMATCH_DETAIL,
    RULE_NOT_FOUND_DETAIL,
    TOO_MANY_CONDITIONS_DETAIL,
    VALUE_REQUIRED_DETAIL,
)
from app.schemas.notification_rule import (
    CatalogColumnResponse,
    CatalogTableResponse,
    NotificationRuleResponse,
    RuleCatalogResponse,
    RuleConditionResponse,
    RulePreviewRequest,
    RulePreviewResponse,
    RuleRequest,
)
from app.schemas.user import ErrorResponse
from app.solutions import (
    SOLUTION_REQUIRED_RESPONSES,
    TELEGRAM_NOTIFICATIONS,
    require_solution,
)

DbSession = Annotated[Session, Depends(get_db)]
DormitoryId = Annotated[int, Path(ge=1, le=2147483647)]
RuleId = Annotated[int, Path(ge=1, le=2147483647)]

# Пользователь кабинета с действующим правом на уведомления в Telegram: то же
# право, что у карточки подключения (`app/api/telegram.py`). Настройки только
# персональные, поэтому общей настройки организации здесь нет.
SolutionUser = Annotated[User, Depends(require_solution(TELEGRAM_NOTIFICATIONS))]

# Отказы 404: общежитие чужое или удалено, правило чужое или удалено.
NOT_FOUND_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": f"{DORMITORY_NOT_FOUND_DETAIL}; {RULE_NOT_FOUND_DETAIL}",
    }
}

# 401 без cookie сессии: его отдают ручки кабинета, и он объявлен, иначе схема
# обещала бы только 403. Текст — общий для всех рабочих роутеров.
UNAUTHORIZED_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_401_UNAUTHORIZED: {
        "model": ErrorResponse,
        "description": "Требуется авторизация",
    }
}

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/telegram-rules",
    tags=["notification-rules"],
    responses={**UNAUTHORIZED_RESPONSES, **SOLUTION_REQUIRED_RESPONSES, **NOT_FOUND_RESPONSES},
)

# Отказы 422 — часть контракта: клиент показывает `detail` дословно, без
# переписывания, и тестировщик сверяет тексты построчно.
RULE_VALIDATION_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "; ".join(
            (
                NAME_REQUIRED_DETAIL,
                NAME_TOO_LONG_DETAIL,
                TOO_MANY_CONDITIONS_DETAIL,
                VALUE_REQUIRED_DETAIL,
                COLUMN_UNAVAILABLE_DETAIL,
                OPERATOR_MISMATCH_DETAIL,
            )
        ),
    }
}

# Тело, которое не разбирается как JSON, отвергает Starlette — это 400, и он
# объявлен у ручек с телом, иначе схема обещала бы только 422.
BAD_REQUEST_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_400_BAD_REQUEST: {
        "model": ErrorResponse,
        "description": "Тело запроса не разбирается как JSON",
    }
}


def _conditions(payload: RuleRequest | RulePreviewRequest) -> list[dict[str, object]]:
    """Условия из тела в вид, который понимает домен."""
    return [condition.model_dump() for condition in payload.conditions]


def _response(
    db: Session,
    dormitory: Dormitory,
    rule: NotificationRule,
    *,
    tabs_by_id: dict[int, CustomTab] | None = None,
) -> NotificationRuleResponse:
    """Правило в ответе: название таблицы для чтения и признак «сломано».

    Условия отдаются как сохранены: значения уже приведены к типу столбца при
    проверке правила. Текст сообщения в ответе правила не участвует — он есть
    только у предпросмотра и всегда равен названию.

    `tabs_by_id` — вкладки общежития, прочитанные один раз на весь список: без
    него каждое правило с пользовательской вкладкой тянуло бы их отдельно.
    """
    return NotificationRuleResponse(
        id=rule.id,
        name=rule.name,
        table_key=rule.table_key,
        table_title=notification_rules.table_title(
            db, dormitory, rule.table_key, tabs_by_id=tabs_by_id
        ),
        is_enabled=rule.is_enabled,
        conditions=[
            RuleConditionResponse(
                column_id=condition.column_id,
                operator=condition.operator,
                value=condition.value,
            )
            for condition in notification_rules.stored_conditions(rule)
        ],
        broken=notification_rules.is_broken(db, dormitory.id, rule),
    )


def _responses(
    db: Session, dormitory: Dormitory, rules: list[NotificationRule]
) -> list[NotificationRuleResponse]:
    """Список правил: вкладки общежития читаются один раз на весь ответ.

    Читаем их, только если в ответе есть правило с пользовательской вкладкой:
    список из одних встроенных таблиц лишнего запроса не делает.
    """
    custom = any(rule.table_key.startswith("custom_") for rule in rules)
    tabs = notification_rules.tabs_index(db, dormitory) if custom else None
    return [_response(db, dormitory, rule, tabs_by_id=tabs) for rule in rules]


@router.get("", response_model=list[NotificationRuleResponse], summary="Правила общежития")
def list_rules(
    user: SolutionUser,
    db: DbSession,
    dormitory: OwnDormitory,
) -> list[NotificationRuleResponse]:
    """Правила текущего пользователя в этом общежитии, новые сверху.

    Правила персональные: коллега по организации своих не видит и чужих не
    получает, хотя право на решение у организации общее.
    """
    return _responses(db, dormitory, notification_rules.rules_for_user(db, user, dormitory.id))


@router.post(
    "",
    response_model=NotificationRuleResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Завести правило",
    responses={
        **RULE_VALIDATION_RESPONSES,
        **BAD_REQUEST_RESPONSES,
    },
)
def create_rule(
    payload: RuleRequest,
    user: SolutionUser,
    db: DbSession,
    dormitory: OwnDormitory,
) -> NotificationRuleResponse:
    """Правило создаётся сразу рабочим: условия проверены по действующим столбцам."""
    rule = notification_rules.create_rule(
        db,
        user,
        dormitory.id,
        name=payload.name,
        table_key=payload.table_key,
        is_enabled=payload.is_enabled,
        conditions=_conditions(payload),
    )
    db.commit()
    db.refresh(rule)
    return _response(db, dormitory, rule)


@router.put(
    "/{rule_id}",
    response_model=NotificationRuleResponse,
    summary="Переписать правило",
    responses={
        **RULE_VALIDATION_RESPONSES,
        **BAD_REQUEST_RESPONSES,
    },
)
def update_rule(
    rule_id: RuleId,
    payload: RuleRequest,
    user: SolutionUser,
    db: DbSession,
    dormitory: OwnDormitory,
) -> NotificationRuleResponse:
    """`PUT`, а не `PATCH`: правило переписывается целиком — так же его читает клиент."""
    rule = notification_rules.update_rule(
        db,
        user,
        dormitory.id,
        rule_id,
        name=payload.name,
        table_key=payload.table_key,
        is_enabled=payload.is_enabled,
        conditions=_conditions(payload),
    )
    db.commit()
    db.refresh(rule)
    return _response(db, dormitory, rule)


@router.delete(
    "/{rule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Удалить правило",
)
def delete_rule(
    rule_id: RuleId,
    user: SolutionUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> None:
    """Удаление доступно всегда, даже если правило сломано.

    История доставок остаётся: `notification_deliveries.rule_id` получает
    `NULL`, а сами строки не удаляются.
    """
    notification_rules.delete_rule(db, user, _dormitory.id, rule_id)
    db.commit()


@router.get(
    "/catalog",
    response_model=RuleCatalogResponse,
    summary="Таблицы и столбцы общежития для условий",
)
def read_catalog(
    _user: SolutionUser,
    db: DbSession,
    dormitory: OwnDormitory,
) -> RuleCatalogResponse:
    """Каталог «таблица → столбцы → операторы» этого общежития.

    Архивные столбцы, служебные кнопки и ссылка на место проживания в каталог
    не попадают: условие по ним не имеет смысла, и правило на них не сохранится.
    Встроенные столбцы заводятся при первом чтении каталога — тем же путём, что
    и в каталоге блоков дашборда, поэтому коммит здесь есть.
    """
    tables = notification_rules.catalog(db, dormitory)
    db.commit()
    return RuleCatalogResponse(
        tables=[
            CatalogTableResponse(
                key=table.key,
                title=table.title,
                columns=[
                    CatalogColumnResponse(
                        id=column.id,
                        name=column.name,
                        kind=column.kind,
                        operators=list(column.operators),
                    )
                    for column in table.columns
                ],
            )
            for table in tables
        ]
    )


@router.post(
    "/preview",
    response_model=RulePreviewResponse,
    summary="Предпросмотр правила",
    responses={
        **RULE_VALIDATION_RESPONSES,
        **BAD_REQUEST_RESPONSES,
    },
)
def preview_rule(
    payload: RulePreviewRequest,
    _user: SolutionUser,
    db: DbSession,
    dormitory: OwnDormitory,
) -> RulePreviewResponse:
    """Сколько строк подходит и какой текст уйдёт в Telegram.

    Текст собирает только сервер: это ровно название правила, то же, что станет
    `title` доставки. Данные проживающих, даты и суммы в сообщение не попадают.
    """
    text, matched = notification_rules.preview(
        db,
        dormitory.id,
        name=payload.name,
        table_key=payload.table_key,
        conditions=_conditions(payload),
    )
    return RulePreviewResponse(text=text, matched=matched)

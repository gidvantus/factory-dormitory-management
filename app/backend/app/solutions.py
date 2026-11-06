"""Права организации на решения магазина улучшений.

Здесь вся предметная логика решений, без HTTP: владение правом по действующему
тарифу, его выдача, а также зависимость FastAPI, которой закрыты ручки платной
функции — по образцу `app/notifications.py`.

Право принадлежит организации, а не пользователю: купил владелец — пользуются
все участники. Отсюда один вопрос у всех проверок — «есть ли у этой организации
действующее право на это решение».

**Своего срока у права больше нет.** Право действует, пока у организации есть
действующий тариф (`app.subscription.py`: текущий слот или оплаченный вперёд
период): кончился тариф — кончились и услуги, начался новый — услуги вернулись без
повторной покупки. Поэтому `owned_codes` и `has_solution` спрашивают подписку, а
`grant` пишет `NULL` в `organization_solutions.expires_at`: колонка остаётся
историей оплаченных сроков, и код её не читает.

Даты сравниваются в Python, а не в SQL, намеренно: на SQLite они приходят
наивными, на Postgres — с зоной, и одно приведение к UTC (`_as_utc`, как в
`app/trial.py`) делает сравнение верным на обеих базах. Сроки самого права
считает `app/subscription.py` — там же, где срок тарифа, чтобы арифметика
периодов была одна.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.solution import OrganizationSolution, Solution
from app.models.user import User
from app.schemas.user import ErrorResponse
from app.security import ACTIVATION_REQUIRED_DETAIL, ActiveUser
from app.subscription import subscription_state
from app.trial import TRIAL_EXPIRED_DETAIL

# Код решения «уведомления в Telegram»: по нему кабинет спрашивает право, и он
# же стоит в seed-строке каталога (`0035_solutions`).
TELEGRAM_NOTIFICATIONS = "telegram_notifications"

# Код решения «журнал действий»: тот же код держит seed-строка каталога
# (`0049_solution_journal`). Кабинет сверяет его с правом организации, чтобы
# показать или спрятать раздел «Журнал».
JOURNAL = "journal"

# Текст 403 «права нет». Он одинаков для ручек платной функции: по ответу не
# должно быть видно, чего именно не хватает, а человеку нужен один понятный
# следующий шаг — магазин улучшений.
SOLUTION_REQUIRED_DETAIL = "Решение не подключено. Оформите подписку в магазине улучшений"

# Текст 409 «покупать нечего»: решения продаются только к действующему тарифу, и
# на пробном периоде кнопка «Купить» отвечает этим отказом.
SOLUTION_REQUIRE_TARIFF_DETAIL = "Купить решение можно после оплаты тарифа"

# Текст 409 «уже подключено»: повторная покупка не продлевает право — оно и так
# действует весь оплаченный тариф, поэтому второй счёт был бы тихой двойной
# продажей.
SOLUTION_ALREADY_OWNED_DETAIL = "Решение уже подключено"

DbSession = Annotated[Session, Depends(get_db)]


def _as_utc(value: datetime) -> datetime:
    """SQLite отдаёт naive datetime: считаем его UTC, иначе сравнение падает."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _is_live(expires_at: datetime | None, moment: datetime) -> bool:
    """Действует ли право: без срока — да, иначе — если срок ещё не прошёл."""
    return expires_at is None or _as_utc(expires_at) > moment


@dataclass(frozen=True)
class OrganizationRight:
    """Право организации на решение — как оно записано, вместе с `is_live`.

    `is_live` здесь, а не в ручке: правило конца записанного срока одно на весь
    проект (`_is_live`), и вторая его копия в API разошлась бы с первой на первой
    же правке границы. Платные ручки этим сроком больше не пользуются — право
    живёт по тарифу (`owned_codes`), — но кабинет оператора показывает историю
    записанных строк, и признак «право ещё действовало» нужен именно там.
    """

    code: str
    name: str
    expires_at: datetime | None
    is_live: bool


def organization_rights(
    db: Session, organization_id: int, now: datetime | None = None
) -> list[OrganizationRight]:
    """**Все** права организации, включая истёкшие, в порядке каталога.

    Истёкшие строки не отфильтрованы намеренно: кабинет оператора — единственное
    место, где видно, что право было и кончилось. Магазин и платные ручки читают
    только действующие (`owned_codes`, `has_solution`) — у них свой отбор, и он
    считается по тарифу организации, а не по записанному здесь сроку.

    Порядок — `solutions.position`, затем `solutions.id`: тот же, в каком решения
    видит покупатель.
    """
    moment = _as_utc(now) if now is not None else datetime.now(UTC)
    rows = db.execute(
        select(OrganizationSolution.expires_at, Solution.code, Solution.name)
        .join(Solution, Solution.id == OrganizationSolution.solution_id)
        .where(OrganizationSolution.organization_id == organization_id)
        .order_by(Solution.position, Solution.id)
    ).all()
    return [
        OrganizationRight(
            code=code,
            name=name,
            expires_at=_as_utc(expires_at) if expires_at is not None else None,
            is_live=_is_live(expires_at, moment),
        )
        for expires_at, code, name in rows
    ]


def deactivate_right(db: Session, organization_id: int, code: str) -> OrganizationRight | None:
    """Отозвать право: строка `organization_solutions` удаляется. Коммитит вызывающий.

    После #195 у права нет собственного срока: `owned_codes`/`has_solution`
    спрашивают тариф организации, а `expires_at` строки — история записанных
    сроков, которую код не читает. Записать в неё «сейчас» значило бы оставить
    кнопку «снять активность» в кабинете оператора без последствий: платная
    функция работала бы до конца оплаченного тарифа. Поэтому отзыв — это
    **удаление строки**: единственное состояние, которое правило права понимает.

    История покупок не страдает: счёт, акт и ссылка `invoice_id` живут в
    `invoices`/`invoice_documents`, удаляется только само право. В кабинете
    оператора отозванное право исчезает из списка расширений совсем: показывать
    «не действует» нечего — строки нет.

    `None` — у организации нет строки права на это `code`: ручка отвечает `404`
    (в том числе на повторное снятие), а не молчаливым «сняли нечего». Возвращённая
    запись описывает, что именно было отозвано; срока у неё уже нет, поэтому
    `expires_at = None`.
    """
    row = db.execute(
        select(OrganizationSolution, Solution)
        .join(Solution, Solution.id == OrganizationSolution.solution_id)
        .where(
            OrganizationSolution.organization_id == organization_id,
            Solution.code == code,
        )
    ).first()
    if row is None:
        return None
    right, solution = row
    db.delete(right)
    db.flush()
    return OrganizationRight(
        code=solution.code,
        name=solution.name,
        # Строки больше нет, и записанного срока у отозванного права не остаётся.
        expires_at=None,
        is_live=False,
    )


def owned_codes(db: Session, organization_id: int) -> set[str]:
    """Коды решений, право на которые действует **по тарифу** организации.

    Пустой набор, когда действующего тарифа нет: своего срока у права больше нет,
    поэтому истёкший тариф выключает все купленные решения сразу, а новая оплата
    тарифа возвращает их без повторной покупки. Срок строки права не читается
    вовсе — он остался историей оплаченных сроков.
    """
    if not subscription_state(db, organization_id).is_active:
        return set()
    rows = db.execute(
        select(Solution.code)
        .join(OrganizationSolution, OrganizationSolution.solution_id == Solution.id)
        .where(OrganizationSolution.organization_id == organization_id)
    ).all()
    return {code for (code,) in rows}


def has_solution(db: Session, organization_id: int, code: str) -> bool:
    """Есть ли у организации действующее право на решение с этим кодом."""
    return code in owned_codes(db, organization_id)


def grant(
    db: Session,
    organization_id: int,
    solution: Solution,
    *,
    invoice_id: int | None,
) -> None:
    """Выдать право. Коммитит вызывающий.

    Строка на пару «организация — решение» одна: повторная выдача правит её, а не
    заводит вторую. `expires_at` пишется `NULL` — своего срока у права нет, оно
    действует, пока действует тариф организации; `granted_at` при повторной
    выдаче не сдвигается — это дата первой выдачи.

    Блокировку организации держит вызывающий (`_lock_organization` в
    `app/invoice_status.py`), поэтому две одновременные оплаты не разойдутся.
    """
    moment = datetime.now(UTC)
    record = db.scalar(
        select(OrganizationSolution).where(
            OrganizationSolution.organization_id == organization_id,
            OrganizationSolution.solution_id == solution.id,
        )
    )
    if record is None:
        db.add(
            OrganizationSolution(
                organization_id=organization_id,
                solution_id=solution.id,
                granted_at=moment,
                expires_at=None,
                invoice_id=invoice_id,
            )
        )
    else:
        record.expires_at = None
        record.invoice_id = invoice_id
    db.flush()


def require_solution_access(db: Session, organization_id: int | None, code: str) -> None:
    """Проверить доступ к решению; единственное место, где выбирается текст 403.

    Порядок отказов контрактный: **сначала тариф**, потом право. Без действующего
    тарифа кабинет закрыт целиком, и человеку нужен тариф, а не магазин
    улучшений; предложение купить решение к закрытому кабинету было бы советом,
    который ничего не открывает. Текст закрытого кабинета — общий
    (`app.trial.TRIAL_EXPIRED_DETAIL`), второй формулировки у него нет.

    Нет организации — тоже «нет тарифа»: тариф и право принадлежат организации.
    """
    if organization_id is None or not subscription_state(db, organization_id).is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=TRIAL_EXPIRED_DETAIL,
        )
    if code not in owned_codes(db, organization_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=SOLUTION_REQUIRED_DETAIL,
        )


def require_solution(code: str) -> Callable[..., User]:
    """Зависимость FastAPI: пользователь с действующим тарифом и правом.

    Порядок проверок обязателен: **сначала** `ActiveUser`, затем тариф, затем
    право. Кабинет не активирован — 403 про активацию, и только активированный
    без тарифа получает 403 про тариф, а с тарифом без права — 403 про магазин.
    Иначе неактивированный человек вместо ссылки на письмо увидел бы предложение
    что-то купить.
    """

    def dependency(user: ActiveUser, db: DbSession) -> User:
        require_solution_access(db, user.active_organization_id, code)
        return user

    return dependency


# Единое описание 403 ручек платной функции: у кода три разных текста, и все
# здесь — как `SUBSCRIBED_USER_RESPONSES` в `app/access.py`.
SOLUTION_REQUIRED_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_403_FORBIDDEN: {
        "model": ErrorResponse,
        "description": (
            f"{ACTIVATION_REQUIRED_DETAIL} — кабинет не активирован; "
            f"{TRIAL_EXPIRED_DETAIL} — нет действующего тарифа; "
            f"{SOLUTION_REQUIRED_DETAIL} — решение не подключено"
        ),
    }
}

"""Правила статусов счёта: единственное место, где живут переходы.

Статусов четыре, и переходы между ними разрешены не все:

* `new → paid` — оплата: проставляется `paid_at`, заводится строка акта, и
  дальше всё зависит от вида предмета счёта;
* `paid → closed` — счёт закрыт после оплаты;
* `new → cancelled` — счёт отменён до оплаты.

Всё остальное — `409` «Так нельзя изменить статус счёта». Отменённый или
закрытый счёт оплатить нельзя: это защищает от второго акта и от смены тарифа
задним числом.

Оплата идёт одной транзакцией и под блокировками: сначала строка организации
(тем же приёмом, что `_lock_organization` в `app/api/organization.py`), затем
строка счёта. Так два одновременных `PATCH` не выставят организации два разных
тарифа, а порядок блокировок совпадает с порядком в остальных ручках — иначе
встречные транзакции упёрлись бы во взаимную блокировку. Та же блокировка
сериализует выдачу прав на решения: два одновременных `PATCH` по счетам за одно
решение не создадут две строки права.

Предмет счёта бывает двух видов, и оплата у них разная:

* **тариф** (`item_kind = 'tariff'`) — оплата записывает организации оплаченный
  период (`app/subscription.py::record_payment`): свободен текущий слот — он и
  заполняется, занят — заполняется будущий, а оба заняты — `409` «Тариф уже
  оплачен на будущий период». Срок считается от `period` снимка счёта, а не от
  текущего прайса: организация получает то, за что заплатила. Смена тарифа
  посреди оплаченного периода покупкой не делается — меняется только срок;
* **решение** (`item_kind = 'solution'`) — оплата выдаёт или продлевает право
  организации на решение (`app/solutions.py::grant`), а подписку
  **не трогает**: решение не открывает кабинет и не меняет тариф.
"""

from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.invoice import SOLUTION_ITEM_KIND, Invoice, InvoiceDocument
from app.models.organization import Organization
from app.models.solution import Solution
from app.solutions import grant
from app.subscription import record_payment

# Подписи статусов для кабинета. Собирает сервер: экран показывает то же, что
# видит и выгрузка, и формулировка живёт в одном месте.
INVOICE_STATUS_LABELS = {
    "new": "Новый",
    "paid": "Оплачен",
    "closed": "Закрыт",
    "cancelled": "Отменён",
}

# Разрешённые переходы. Пустое множество — тупик: оттуда счёт уже не двигается.
ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    "new": frozenset({"paid", "cancelled"}),
    "paid": frozenset({"closed"}),
    "closed": frozenset(),
    "cancelled": frozenset(),
}

INVALID_STATUS_DETAIL = "Так нельзя изменить статус счёта"
INVOICE_NOT_FOUND_DETAIL = "Счёт не найден"

# Вид документа, который появляется при оплате.
ACT_KIND = "act"

# Статус, в котором счёт считается выставленным: пока такой счёт жив, повторная
# покупка не создаёт второй.
NEW_STATUS = "new"
PAID_STATUS = "paid"


def status_label(value: str) -> str:
    """Подпись статуса. Незнакомое значение отдаётся как есть, а не роняет ответ."""
    return INVOICE_STATUS_LABELS.get(value, value)


def is_allowed(current: str, target: str) -> bool:
    """Разрешён ли переход. Единственная проверка правила — здесь."""
    return target in ALLOWED_TRANSITIONS.get(current, frozenset())


def _lock_organization(db: Session, organization_id: int) -> Organization:
    """Заблокировать строку организации на время транзакции.

    Тот же приём, что `_lock_organization` в `app/api/organization.py`: привязка
    тарифа к организации не должна гоняться с правкой организации и приглашениями.
    """
    organization = db.scalar(
        select(Organization).where(Organization.id == organization_id).with_for_update()
    )
    if organization is None:  # pragma: no cover - счёт без организации невозможен
        raise HTTPException(status.HTTP_404_NOT_FOUND, INVOICE_NOT_FOUND_DETAIL)
    return organization


def _lock_invoice(db: Session, invoice_id: int) -> Invoice:
    """Заблокировать счёт и перечитать его поля свежими.

    Без `populate_existing` объект остался бы в том виде, в каком его прочитал
    роут до блокировки: параллельная оплата уже могла сменить статус.
    """
    invoice = db.scalar(
        select(Invoice)
        .where(Invoice.id == invoice_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if invoice is None:  # pragma: no cover - счёт удалён между чтением и блокировкой
        raise HTTPException(status.HTTP_404_NOT_FOUND, INVOICE_NOT_FOUND_DETAIL)
    return invoice


def change_status(db: Session, invoice: Invoice, target: str) -> Invoice:
    """Сменить статус счёта по правилам. Иначе — `409` с текстом причины.

    Коммитит сама: оплата — это одно действие из трёх записей (дата оплаты,
    тариф организации, акт), и частично применённой она быть не должна.
    """
    organization = _lock_organization(db, invoice.organization_id)
    invoice = _lock_invoice(db, invoice.id)

    if not is_allowed(invoice.status, target):
        raise HTTPException(status.HTTP_409_CONFLICT, INVALID_STATUS_DETAIL)

    if target == PAID_STATUS:
        if invoice.item_kind == SOLUTION_ITEM_KIND:
            # Право выдаётся из строки каталога: снимок счёта хранит только
            # название и период, а для срока нужен `period` решения.
            solution = (
                db.get(Solution, invoice.solution_id) if invoice.solution_id is not None else None
            )
            if solution is not None:
                grant(db, organization.id, solution, invoice_id=invoice.id)
            # Строки каталога может уже не быть (`ON DELETE SET NULL` обнуляет
            # ссылку): тогда выдавать нечего — оплата всё равно фиксируется, а
            # право не появляется. Молчаливой выдачи «не того» решения нет.
        else:
            # Период берётся из снимка счёта: организация получает ровно то, за что
            # заплатила, даже если прайс с тех пор поменялся. Оба слота заняты —
            # `record_payment` откажет `409`, и счёт останется неоплаченным.
            record_payment(organization, invoice.tariff_id, invoice.tariff_period)
        invoice.paid_at = datetime.now(UTC)
        db.add(InvoiceDocument(invoice_id=invoice.id, kind=ACT_KIND))

    invoice.status = target
    db.commit()
    db.refresh(invoice)
    return invoice

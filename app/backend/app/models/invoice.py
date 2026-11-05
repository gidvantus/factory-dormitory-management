"""Счёт за предмет и его печатные документы.

Счёт — это не «намерение купить», а зафиксированная сделка: реквизиты покупателя
и предмет (название и период) копируются в строку счёта в момент покупки. Так
удаление строки прайса или каталога решений либо правка карточки организации
задним числом не меняет уже выставленный счёт: `tariff_id`/`solution_id` при
`ON DELETE SET NULL` обнулятся, а снимок `tariff_name`/`tariff_period`
останется.

**Снимок предмета счёта — тариф или решение.** Вид предмета различает
`item_kind`; строки, заведённые до появления решений, — тарифные (`'tariff'`).
Колонки снимка при этом не разделены по видам намеренно: `tariff_name` хранит
название купленного тарифа **или решения**, `tariff_period` — его период. Так
печатные формы счёта и акта (`app/billing_forms.py`) и ответ счёта остаются
прежними, а переименование колонок в `item_name`/`item_period` — отдельная
задача.

**Третий вид предмета — места сверх тарифа (`'seats'`).** Счёт за места — не
строка каталога решений с количеством: у него есть `quantity` (сколько мест
докуплено), а сумма равна цене места × количество. `quantity` появился вместе с
этим видом и остаётся nullable: у тарифных и решенческих счетов количество
**неприменимо**, и `NULL` — честное «не про количество», а не «один». У счёта за
места количество всегда `> 0` — это держит `CHECK` `ck_invoices_quantity_positive`.
Снимок названия и периода у него тоже заполнен (`'Дополнительные сотрудники'`,
`'once'`), поэтому печатные формы и ответ счёта читают его как любой другой.

Покупательские поля nullable: пустая заготовка организации — нормальное
состояние (её заполняет поиск по ИНН), а счёт выставляется только у организации
с названием и ИНН — это проверяет ручка покупки, а не схема таблицы.

**Акцепт оферты — снимок в строке счёта.** У тарифного счёта рядом с реквизитами
лежат четыре поля `offer_*`: момент акцепта, код документа (`offer`), редакция
документа на этот момент и автор акцепта. Доказательство «когда и на какую
редакцию согласились» привязано к сделке, поэтому живёт в `invoices`, а не в
`users`: человек может согласиться с офертой при покупке второго тарифа уже на
новую редакцию. Механизм при этом повторяет `app/consent.py`: момент, код и
снимок `documents.updated_at`, без отдельной таблицы принятий. Счёт за решение
покупается без отметки, и его `offer_*` остаются `NULL`.

**Позиции счёта — `invoice_items`.** Один документ может описывать несколько
предметов: покупка «тариф + места» — это одна сделка, одна сумма и один платёж,
но две строки позиций (#177). Позиция хранит свой снимок названия и периода,
количество (только у мест), цену единицы и сумму, поэтому состав покупки читается
и печатается из неё, а не собирается заново по прайсу. `invoices.amount`
остаётся канонической суммой и равен сумме позиций; вид первой позиции дублируется
в `invoices.item_kind`, чтобы прежние читатели счёта не меняли контракт. Счёт без
позиций (выставленный до ревизии `0066_invoice_items` или мимо ручки покупки)
читается одной позицией из своего снимка — `subject_items`.

`invoice_documents` — строки печатных форм счёта. Сам счёт отдаётся файлом без
строки в этой таблице: он есть всегда, а вот акт появляется только при переходе
счёта в статус «оплачен». Уникальность пары `(invoice_id, kind)` не даёт завести
второй акт по одному счёту.

Статусы счёта перечислены здесь только для `CHECK`; правила переходов между ними
живут в `app/invoice_status.py`, а не в модели.
"""

import secrets
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

# Статусы счёта. Порядок — как в `CHECK`: список должен быть записан в модели и
# в миграции одинаково.
INVOICE_STATUSES = ("new", "paid", "closed", "cancelled")

# Перечень значений для `CHECK` собирается из константы, как `TARIFF_PERIODS_SQL`.
INVOICE_STATUSES_SQL = ", ".join(f"'{value}'" for value in INVOICE_STATUSES)

# Виды предмета счёта. `tariff` — подписка организации на кабинет, `solution` —
# право на одну функцию магазина улучшений, `seats` — докупленные места сверх
# тарифа. Поле появилось вместе с решениями, поэтому у всех прежних счетов стоит
# `tariff`: они все тарифные.
INVOICE_ITEM_KINDS = ("tariff", "solution", "seats")

INVOICE_ITEM_KINDS_SQL = ", ".join(f"'{value}'" for value in INVOICE_ITEM_KINDS)

TARIFF_ITEM_KIND = "tariff"
SOLUTION_ITEM_KIND = "solution"
SEATS_ITEM_KIND = "seats"

# Виды печатных форм, которые хранятся строками. Счёт сюда не входит: он
# собирается из самой строки счёта и существует всегда, а акт — только после
# оплаты.
INVOICE_DOCUMENT_KINDS = ("act",)

INVOICE_DOCUMENT_KINDS_SQL = ", ".join(f"'{value}'" for value in INVOICE_DOCUMENT_KINDS)

# Длина номера счёта с запасом: «СЧ-2026-1» — девять символов, но год и `id`
# растут, а `VARCHAR` дешевле оставить свободным.
NUMBER_MAX_LENGTH = 32

# Приставка временного номера. Номер счёта — `СЧ-<год>-<id>`, а `id` появляется
# только после вставки, поэтому строка сначала сохраняется с временным номером
# и получает окончательный в том же коммите. Уникальность временного номера
# обеспечивает случайный хвост, а не счётчик: два параллельных запроса не должны
# столкнуться на одном значении.
PENDING_NUMBER_PREFIX = "pending-"


def invoice_number(invoice_id: int, year: int) -> str:
    """Номер счёта в формате `СЧ-<год>-<id>`."""
    return f"СЧ-{year}-{invoice_id}"


def pending_invoice_number() -> str:
    """Временный номер для вставки: окончательный вид требует `id` строки."""
    return f"{PENDING_NUMBER_PREFIX}{secrets.token_hex(8)}"


class Invoice(Base):
    """Счёт организации за тариф, за решение магазина улучшений или за места."""

    __tablename__ = "invoices"
    __table_args__ = (
        CheckConstraint(f"status IN ({INVOICE_STATUSES_SQL})", name="ck_invoices_status"),
        CheckConstraint(f"item_kind IN ({INVOICE_ITEM_KINDS_SQL})", name="ck_invoices_item_kind"),
        # Количество неприменимо к тарифу и решению, поэтому `NULL`, но у счёта за
        # места оно положительное: «счёт за ноль мест» смысла не имеет.
        CheckConstraint("quantity IS NULL OR quantity > 0", name="ck_invoices_quantity_positive"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Вид предмета счёта. Строка с `item_kind = 'tariff'` заполняет `tariff_id`,
    # строка с `item_kind = 'solution'` — `solution_id`; оба заполненными не
    # бывают, и это правило покупки, а не `CHECK`: исторические строки счёта
    # остаются валидными при любом порядке миграций.
    item_kind: Mapped[str] = mapped_column(String(10), nullable=False, server_default="tariff")
    # Индекса нет: счета ищутся по организации, а не по тарифу.
    tariff_id: Mapped[int | None] = mapped_column(
        ForeignKey("tariffs.id", ondelete="SET NULL"), nullable=True
    )
    # Индекс есть: по решению счёт ищется при проверке живого неоплаченного.
    solution_id: Mapped[int | None] = mapped_column(
        ForeignKey("solutions.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Сколько мест докуплено: заполняется только у счёта с `item_kind = 'seats'`.
    # `NULL` у тарифов и решений — количество там неприменимо, а не «один».
    quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    number: Mapped[str] = mapped_column(String(NUMBER_MAX_LENGTH), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="new")
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, server_default="RUB")
    # Снимок покупателя на момент покупки: реквизиты организации могут измениться.
    buyer_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    buyer_inn: Mapped[str | None] = mapped_column(String(12), nullable=True)
    buyer_kpp: Mapped[str | None] = mapped_column(String(9), nullable=True)
    buyer_ogrn: Mapped[str | None] = mapped_column(String(15), nullable=True)
    buyer_address: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Снимок предмета: что именно куплено и на какой период.
    tariff_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    tariff_period: Mapped[str | None] = mapped_column(String(10), nullable=True)
    # Снимок акцепта оферты на момент покупки тарифа: момент, код документа и
    # редакция документа на этот момент. Это **снимок**, а не ссылка на живую
    # строку `documents`: вопрос «на какую редакцию согласились» должен
    # отвечаться прошедшим временем, даже если текст оферты потом поправят.
    # У счетов за решение и у счетов, выставленных до задачи #86, все четыре
    # поля `NULL` — «акцепта нет», и это честный исторический факт, а не дефект.
    offer_accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    offer_document_code: Mapped[str | None] = mapped_column(String(50), nullable=True)
    offer_document_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Кто нажал «Купить» с отметкой. `SET NULL` — как у `tariff_id`/`solution_id`:
    # удаление пользователя не должно ни удалять счёт, ни мешать удалению.
    offer_accepted_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Момент оплаты: заполняется переходом в `paid` в `app/invoice_status.py`.
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Ключ печатной формы счёта в файловом хранилище (`app/storage.py`), без
    # префикса `uploads/` — например `2026-10-29/invoices/invoice-7.pdf`.
    # `NULL` означает «файла ещё нет»: форма собирается лениво, при первом
    # скачивании (`app/invoice_files.py`), поэтому у исторических счетов колонка
    # пуста до первого обращения. На раздачу это не влияет: имя файла строится
    # из `number`, а не из ключа.
    invoice_file_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Позиции счёта: одна строка `invoice_items` на каждый предмет. У счёта за
    # «тариф + места» их две, у счёта за тариф, решение или места — одна.
    # `selectin` — чтобы список счетов не делал по запросу на счёт, а получал
    # позиции вторым запросом на всю страницу.
    items: Mapped[list["InvoiceItem"]] = relationship(
        back_populates="invoice",
        cascade="all, delete-orphan",
        order_by="InvoiceItem.position",
        lazy="selectin",
    )


class InvoiceItem(Base):
    """Позиция счёта: что именно куплено, сколько и за какую сумму.

    Один документ на покупку «тариф + места» — это одна строка `invoices` и две
    строки здесь, а не два счёта. Позиция хранит собственный снимок названия и
    периода: строку прайса или каталога могут поправить или удалить, а документ
    обязан показывать то, за что заплатили.

    `kind` — тот же набор видов, что у `invoices.item_kind`: `tariff`,
    `solution`, `seats`. `unit_amount` у тарифа и решения равен сумме (цена
    предмета), у мест — цена одного места со скидкой ступени; `amount` — итог по
    позиции, и сумма позиций равна `invoices.amount`.
    """

    __tablename__ = "invoice_items"
    __table_args__ = (
        # Позиции одного счёта нумеруются подряд и не повторяются: по `position`
        # печатная форма выводит строки в том порядке, в каком их собрала покупка.
        UniqueConstraint("invoice_id", "position", name="uq_invoice_items_invoice_position"),
        CheckConstraint(f"kind IN ({INVOICE_ITEM_KINDS_SQL})", name="ck_invoice_items_kind"),
        # Количество неприменимо к тарифу и решению (`NULL`), у мест — всегда
        # положительное: позиция «ноль мест» смысла не имеет.
        CheckConstraint(
            "quantity IS NULL OR quantity > 0", name="ck_invoice_items_quantity_positive"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_id: Mapped[int] = mapped_column(
        ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Порядок строки в документе: 1 — первая. Тариф всегда идёт первым.
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    # Снимок названия и периода на момент покупки.
    name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    period: Mapped[str | None] = mapped_column(String(10), nullable=True)
    # Сколько мест в позиции. `NULL` у тарифа и решения — «не про количество».
    quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Цена одной единицы предмета: у мест — со скидкой ступени.
    unit_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    # Ссылки на строки прайса и каталога: `SET NULL`, как у самого счёта —
    # удаление строки не должно ни удалять документ, ни мешать удалению.
    tariff_id: Mapped[int | None] = mapped_column(
        ForeignKey("tariffs.id", ondelete="SET NULL"), nullable=True
    )
    solution_id: Mapped[int | None] = mapped_column(
        ForeignKey("solutions.id", ondelete="SET NULL"), nullable=True
    )
    invoice: Mapped["Invoice"] = relationship(back_populates="items")


def subject_items(invoice: Invoice) -> list[InvoiceItem]:
    """Позиции счёта: строки `invoice_items`, а у старого счёта — одна позиция.

    Счета, выставленные до появления позиций, разложены бэкфиллом ревизии
    `0066_invoice_items`; но счёт может быть создан и мимо ручки покупки —
    тестом, вручную в базе, — и тогда позиций у него нет. Такой счёт читается по
    снимку в своей строке: одна позиция того вида, что записан в `item_kind`.
    Ветка не «заглушка ради тестов»: именно она не даёт историческому документу
    остаться без предмета, если бэкфилл не отработал.

    У возвращённой синтетической позиции `invoice_id` не заполнен: это чтение, а
    не строка таблицы, и в базу она не попадает.
    """
    if invoice.items:
        return list(invoice.items)
    unit = invoice.amount
    if invoice.quantity is not None and invoice.quantity > 0:
        unit = (invoice.amount / invoice.quantity).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return [
        InvoiceItem(
            position=1,
            kind=invoice.item_kind,
            name=invoice.tariff_name,
            period=invoice.tariff_period,
            quantity=invoice.quantity,
            unit_amount=unit,
            amount=invoice.amount,
            tariff_id=invoice.tariff_id,
            solution_id=invoice.solution_id,
        )
    ]


class InvoiceDocument(Base):
    """Печатная форма, появившаяся у счёта: пока это только акт."""

    __tablename__ = "invoice_documents"
    __table_args__ = (
        UniqueConstraint("invoice_id", "kind", name="uq_invoice_documents_invoice_kind"),
        CheckConstraint(
            f"kind IN ({INVOICE_DOCUMENT_KINDS_SQL})",
            name="ck_invoice_documents_kind",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_id: Mapped[int] = mapped_column(
        ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Ключ печатной формы акта в файловом хранилище, без префикса `uploads/`.
    # `NULL` — «файла ещё нет»: акт появляется при оплате, а его PDF собирается
    # при первом скачивании (`app/invoice_files.py`). Колонка на строке акта, а не
    # на счёте, потому что видов печатных форм со временем может стать больше
    # (`UNIQUE (invoice_id, kind)`).
    file_key: Mapped[str | None] = mapped_column(String(500), nullable=True)

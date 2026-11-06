"""Реквизиты поставщика: одна строка, которую правят в кабинете оператора.

Поставщик в проекте один — это сам сервис. Поэтому таблица состоит из одной
строки, а не из справочника контрагентов: `CHECK (id = 1)` (`ck_company_details_single_row`)
держит это правило в базе, а не в голове того, кто пишет ручку. Колонка `id`
нужна ради `PRIMARY KEY`: без неё нельзя выразить ни «строку одну», ни правку
конкретной строки.

**Почему не настройки и не константы.** Реквизиты — бизнес-данные, а не
инфраструктура стенда: их правит оператор в кабинете, без деплоя и без правки
кода. Поэтому `.env` и `config.py` здесь не подходят, а таблица подходит.

**Почему без снимка в счёте.** Форма собирается один раз и лежит в хранилище
(`app/invoice_files.py`), поэтому уже выданные документы не перерисовываются при
правке реквизитов. Снимок в `invoices` стоил бы миграции самой горячей таблицы и
не изменил бы поведение выданных PDF. Правка действует только на документы,
собранные после неё.

**`vat_note`.** Строка про НДС — тот же принцип: правится оператором, печатается
в счёте и акте одной и той же формулировкой. Отдельной строки для акта нет: в
проекте один налоговый режим и один поставщик, а второй источник разошёлся бы с
первым. Пустое значение означает «строки в документе нет вовсе», а не прочерк.

Все значения nullable: пустая строка `company_details` — нормальное первое
состояние, в котором печатная форма печатает честную заглушку поставщика
(`app/billing_forms.py`), а не выдуманные реквизиты.

Чтение для печати — `app/company_details.py`, правила правки — платформенный
роутер `app/api/platform_company.py`. Модель ничего не знает ни о том, ни о
другом.
"""

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

# Строка реквизитов одна: поставщик в проекте один и второго не планируется.
SINGLE_ROW_ID = 1

# Условие `CHECK` записано константой: его сверяет тест ревизии
# (`tests/test_company_details_migration.py`) с одноимённым условием миграции.
SINGLE_ROW_CONDITION_SQL = "id = 1"

SINGLE_ROW_CHECK_NAME = "ck_company_details_single_row"


class CompanyDetails(Base):
    """Реквизиты поставщика для печатных форм счёта и акта.

    Поле `signatory` — тот, кто подписывает документ (должность и ФИО одной
    строкой). Длины колонок повторяют миграцию `0067_company_details` один в
    один: расхождение ловится тестом ревизии, а не падением на длинной строке.

    `updated_at` — момент последней правки. Ставится базой при вставке и
    роутером при правке; печатная форма его не печатает.
    """

    __tablename__ = "company_details"
    __table_args__ = (CheckConstraint(SINGLE_ROW_CONDITION_SQL, name=SINGLE_ROW_CHECK_NAME),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    inn: Mapped[str | None] = mapped_column(String(12), nullable=True)
    kpp: Mapped[str | None] = mapped_column(String(9), nullable=True)
    ogrn: Mapped[str | None] = mapped_column(String(15), nullable=True)
    address: Mapped[str | None] = mapped_column(String(500), nullable=True)
    bank_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    bank_bic: Mapped[str | None] = mapped_column(String(9), nullable=True)
    bank_account: Mapped[str | None] = mapped_column(String(20), nullable=True)
    corr_account: Mapped[str | None] = mapped_column(String(20), nullable=True)
    signatory: Mapped[str | None] = mapped_column(String(300), nullable=True)
    vat_note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

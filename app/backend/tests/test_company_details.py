"""Чтение реквизитов поставщика для печати (`app/company_details.py`).

Проверяется ровно обещание модуля: одна строка или `None`, ничего не создаётся и
не пишется. Схема юнит-тестов собирается из моделей, без миграций, поэтому
засева здесь нет — `None` это и есть первое состояние пустой базы, в котором
печатная форма печатает заглушку поставщика.
"""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import company_details
from app.models.company_details import SINGLE_ROW_ID, CompanyDetails


def add_company(db_session: Session, **fields: object) -> CompanyDetails:
    """Единственная строка реквизитов прямо в базе: засев миграции не выполняется."""
    row = CompanyDetails(id=SINGLE_ROW_ID, **fields)
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def rows_count(db_session: Session) -> int:
    return db_session.scalar(select(func.count()).select_from(CompanyDetails)) or 0


def test_empty_database_gives_none(db_session: Session) -> None:
    """Строки нет — `None`, а не пустая заготовка и не исключение."""
    assert company_details.load(db_session) is None


def test_the_existing_row_is_returned_as_is(db_session: Session) -> None:
    """Заполненная строка возвращается целиком: печатная форма читает её поля."""
    add_company(
        db_session,
        name="ООО «Домовой»",
        inn="7701234567",
        bank_name="ПАО «Банк»",
        bank_bic="044525225",
        bank_account="40702810100000000001",
        vat_note="НДС не облагается",
    )

    loaded = company_details.load(db_session)

    assert loaded is not None
    assert loaded.id == SINGLE_ROW_ID
    assert loaded.name == "ООО «Домовой»"
    assert loaded.inn == "7701234567"
    assert loaded.bank_bic == "044525225"
    assert loaded.vat_note == "НДС не облагается"


def test_reading_creates_nothing(db_session: Session) -> None:
    """`load` не создаёт строку: засев — дело миграции, а не чтения."""
    assert company_details.load(db_session) is None
    assert company_details.load(db_session) is None

    assert rows_count(db_session) == 0
    assert list(db_session.new) == []


def test_reading_writes_nothing(db_session: Session) -> None:
    """`load` ничего не меняет: после двух чтений строка та же и без коммита."""
    row = add_company(db_session, name="ООО «Домовой»", vat_note="НДС не облагается")
    db_session.expunge_all()

    assert company_details.load(db_session) is not None
    assert company_details.load(db_session) is not None

    db_session.rollback()
    reread = db_session.get(CompanyDetails, row.id)
    assert reread is not None
    assert reread.name == "ООО «Домовой»"
    assert rows_count(db_session) == 1

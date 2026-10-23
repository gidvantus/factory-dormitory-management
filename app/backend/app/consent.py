"""Согласие на обработку персональных данных и принятие правил использования.

Оба документа требуются и при регистрации, и при активации кабинета: приглашённый
сотрудник регистрацию не проходит, аккаунт ему заводит владелец, поэтому без
проверки на экране активации он остался бы без согласия и без правил.

Это два разных документа: согласие на обработку данных даётся по закону о
персональных данных, правила использования — договор об условиях работы сервиса.
Один чекбокс не может принимать оба, поэтому у каждого своя пара полей.

Факт каждого принятия — три поля в `users`: момент, код документа и снимок
редакции документа на этот момент (`consent_*` и `terms_*`). Отдельной таблицы
принятий нет: важно ответить на вопрос «принял ли этот пользователь документ и
какую редакцию», а не хранить историю пересогласований. Код документа неизменен,
дата редакции — снимок `documents.updated_at`.

Признак «согласия нет» — `user.consent_at is None`, «правила не приняты» —
`user.terms_accepted_at is None`; этими же признаками пользуется экран активации,
чтобы решить, показывать ли чекбокс.
"""

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.user import User

# Код документа в таблице `documents`: он же уходит в ссылку `/documents/<code>`
# и он же записывается в `users.consent_document_code`.
CONSENT_DOCUMENT_CODE = "personal-data-consent"

# Один и тот же текст у 422 регистрации и 422 активации: человек читает его под
# чекбоксом на обеих формах.
CONSENT_REQUIRED_DETAIL = "Отметьте согласие на обработку персональных данных"

# Правила использования: документ заведён миграцией `0017_documents`, здесь
# только его код и текст отказа — по образцу согласия.
TERMS_DOCUMENT_CODE = "terms-of-use"
TERMS_REQUIRED_DETAIL = "Отметьте принятие правил использования платформой"


def _document_revision(db: Session, code: str) -> datetime | None:
    """Редакция документа `code` — `documents.updated_at` или `NULL`.

    Отсутствующая строка документа не ошибка: принятие важнее, чем справочник, и
    запрос пользователя из-за пустого справочника падать не должен. Общий
    помощник для согласия и правил: снимок редакции у них устроен одинаково,
    различаются только колонки, которые заполняет вызывающая функция.
    """
    return db.scalar(select(Document.updated_at).where(Document.code == code))


def record_consent(db: Session, user: User, moment: datetime | None = None) -> None:
    """Записать факт согласия пользователя.

    Снимок редакции документа берётся из `documents.updated_at`. Если строки
    документа в базе нет, поле остаётся `NULL`: согласие важнее, чем справочник,
    и запрос пользователя из-за отсутствующей строки падать не должен.

    Функция ничего не коммитит: запись идёт в общей транзакции вызывающего
    роута, чтобы согласие не сохранилось у регистрации, которая затем упала.
    """
    user.consent_at = datetime.now(UTC) if moment is None else moment
    user.consent_document_code = CONSENT_DOCUMENT_CODE
    user.consent_document_updated_at = _document_revision(db, CONSENT_DOCUMENT_CODE)


def record_terms_acceptance(db: Session, user: User, moment: datetime | None = None) -> None:
    """Записать факт принятия правил использования платформой.

    Устроено так же, как `record_consent`: момент, код документа и снимок
    редакции из `documents.updated_at` (отсутствующая строка документа даёт
    `NULL`), и никакого коммита — запись идёт в общей транзакции вызывающего.
    """
    user.terms_accepted_at = datetime.now(UTC) if moment is None else moment
    user.terms_document_code = TERMS_DOCUMENT_CODE
    user.terms_document_updated_at = _document_revision(db, TERMS_DOCUMENT_CODE)

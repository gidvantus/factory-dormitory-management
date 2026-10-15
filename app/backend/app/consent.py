"""Согласие на обработку персональных данных.

Согласие требуется и при регистрации, и при активации кабинета: приглашённый
сотрудник регистрацию не проходит, аккаунт ему заводит владелец, поэтому без
проверки на экране активации он остался бы без согласия.

Факт согласия — три поля в `users`: момент, код документа и снимок редакции
документа на этот момент. Отдельной таблицы согласий нет: важно ответить на
вопрос «давал ли этот пользователь согласие и на какую редакцию», а не хранить
историю пересогласований. Код документа неизменен, дата редакции — снимок
`documents.updated_at`.

Признак «согласия нет» — `user.consent_at is None`; этим же пользуется экран
активации, чтобы решить, показывать ли чекбокс.
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


def record_consent(db: Session, user: User, moment: datetime | None = None) -> None:
    """Записать факт согласия пользователя.

    Снимок редакции документа берётся из `documents.updated_at`. Если строки
    документа в базе нет, поле остаётся `NULL`: согласие важнее, чем справочник,
    и запрос пользователя из-за отсутствующей строки падать не должен.

    Функция ничего не коммитит: запись идёт в общей транзакции вызывающего
    роута, чтобы согласие не сохранилось у регистрации, которая затем упала.
    """
    document = db.scalar(select(Document).where(Document.code == CONSENT_DOCUMENT_CODE))
    user.consent_at = datetime.now(UTC) if moment is None else moment
    user.consent_document_code = CONSENT_DOCUMENT_CODE
    user.consent_document_updated_at = document.updated_at if document is not None else None

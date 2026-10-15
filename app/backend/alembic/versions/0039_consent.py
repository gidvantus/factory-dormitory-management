"""Согласие на обработку персональных данных: три колонки в `users` и документ.

Миграция аддитивная: три nullable-колонки в `users` и одна новая строка в
`documents` с кодом `personal-data-consent`. Существующие пользователи не
трогаются — у них `consent_at` остаётся `NULL`, то есть «согласие не давал», и
такого пользователя активация спросит о согласии. Существующие строки
документов не переписываются.

Голова на момент ревизии — `0038_audit_changes_column`: в дереве несколько
сводящих ревизий, и этот шаг встаёт поверх текущей головы, а не поверх
`0035_solutions`, как планировалось в задаче (план писался до того, как в
develop-m появились `0036`–`0038`).

Текст документа — заготовка, а не юридический документ: его правит человек
SQL-запросом или новой миграцией, пересборка фронта для этого не нужна.
`consent_document_updated_at` у согласия — снимок `documents.updated_at` этого
документа: код документа и его редакция фиксируются на момент согласия.

`downgrade` удаляет колонки и строку документа вместе с записанными
согласиями, поэтому откат допустим только до появления реальных согласий.

Идентификатор ревизии короче 32 символов: колонка `alembic_version.version_num`
имеет тип `varchar(32)`.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0039_consent"
down_revision: str | None = "0038_audit_changes_column"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CONSENT_CODE = "personal-data-consent"
CONSENT_TITLE = "Согласие на обработку персональных данных"
CONSENT_BODY = (
    "Настоящим пользователь даёт сервису «Домовой» согласие на обработку своих\n"
    "персональных данных, перечисленных в Политике конфиденциальности.\n"
    "\n"
    "Обработка включает сбор, запись, хранение, уточнение, использование и\n"
    "удаление данных. Цель обработки — открыть доступ к кабинету, вести учёт\n"
    "проживающих, сотрудников и общежитий организации и отправлять служебные\n"
    "письма сервиса.\n"
    "\n"
    "Согласие даётся на срок пользования сервисом и может быть отозвано в любой\n"
    "момент: пользователь направляет обращение в службу поддержки, и доступ к\n"
    "кабинету закрывается вместе с обработкой его данных.\n"
    "\n"
    "Вместе с согласием сервис сохраняет код этого документа и дату его\n"
    "редакции. Согласие не заменяет собой иные документы сервиса, а действует\n"
    "вместе с ними."
)

# Вставка идемпотентна по `code`: параметр встречается в запросе ровно один раз
# (проверка существующих кодов идёт отдельным запросом) — тем же приёмом это
# сделано в `0030_pricing_plans` и `0035_solutions`.
EXISTING_CODES_SQL = sa.text("SELECT code FROM documents")

INSERT_DOCUMENT_SQL = sa.text(
    """
    INSERT INTO documents (code, title, body, position)
    VALUES (:code, :title, :body, :position)
    """
)

DELETE_DOCUMENT_SQL = sa.text("DELETE FROM documents WHERE code = :code")


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(sa.Column("consent_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(
            sa.Column("consent_document_code", sa.String(length=50), nullable=True)
        )
        batch_op.add_column(
            sa.Column("consent_document_updated_at", sa.DateTime(timezone=True), nullable=True)
        )

    connection = op.get_bind()
    existing = set(connection.execute(EXISTING_CODES_SQL).scalars())
    if CONSENT_CODE not in existing:
        connection.execute(
            INSERT_DOCUMENT_SQL,
            {
                "code": CONSENT_CODE,
                "title": CONSENT_TITLE,
                "body": CONSENT_BODY,
                "position": 3,
            },
        )


def downgrade() -> None:
    op.get_bind().execute(DELETE_DOCUMENT_SQL, {"code": CONSENT_CODE})

    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("consent_document_updated_at")
        batch_op.drop_column("consent_document_code")
        batch_op.drop_column("consent_at")

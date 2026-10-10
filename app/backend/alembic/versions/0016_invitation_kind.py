"""Приглашение сотрудника: вид ссылки `invitation` и шаблон письма.

Ревизия аддитивная: перечень допустимых `kind` у `activation_tokens` растёт, в
`mail_templates` добавляется одна строка с кодом `invitation`. Существующие
токены и шаблоны активации и восстановления пароля не меняются — их тексты и
коды остаются прежними.

`downgrade` удаляет ровно добавленное: строку шаблона `invitation` и значение
`invitation` из `CHECK`. Выпущенные к тому моменту ссылки-приглашения откат
сломает так же, как и откат ролей: строки с новым значением `kind` не пройдут
проверку. Откат рассчитан на выполнение до первого реального приглашения.

Идентификатор ревизии короче имени файла: колонка `alembic_version.version_num`
имеет тип `varchar(32)`, и полное имя в неё не влезает.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016_invitation_kind"
down_revision: str | None = "0015_organization_roles"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KIND_CONSTRAINT = "ck_activation_tokens_kind"
OLD_KINDS = "('activation', 'recovery')"
NEW_KINDS = "('activation', 'recovery', 'invitation')"

# Шаблон письма-приглашения. Подстановки те же, что у активации и восстановления:
# имя, абсолютная ссылка и срок жизни. Текст правится в базе без релиза.
INVITATION_TEMPLATE_CODE = "invitation"
INVITATION_TEMPLATE_SUBJECT = "Приглашение в систему «Домовой»"
INVITATION_TEMPLATE_BODY = (
    "Здравствуйте, {full_name}!\n"
    "\n"
    "Вас пригласили работать в системе учёта проживающих «Домовой».\n"
    "Чтобы задать пароль и войти в кабинет, откройте ссылку:\n"
    "\n"
    "{activation_url}\n"
    "\n"
    "Ссылка действует {expires_hours} ч. и срабатывает один раз.\n"
    "Если вы не ожидали приглашения, просто проигнорируйте это письмо.\n"
)


def _replace_kind_check(kinds: str) -> None:
    with op.batch_alter_table("activation_tokens") as batch_op:
        batch_op.drop_constraint(KIND_CONSTRAINT, type_="check")
        batch_op.create_check_constraint(KIND_CONSTRAINT, f"kind IN {kinds}")


def upgrade() -> None:
    _replace_kind_check(NEW_KINDS)
    op.bulk_insert(
        sa.table(
            "mail_templates",
            sa.column("code", sa.String(length=50)),
            sa.column("subject", sa.String(length=255)),
            sa.column("body", sa.Text()),
            sa.column("is_active", sa.Boolean()),
        ),
        [
            {
                "code": INVITATION_TEMPLATE_CODE,
                "subject": INVITATION_TEMPLATE_SUBJECT,
                "body": INVITATION_TEMPLATE_BODY,
                "is_active": True,
            }
        ],
    )


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM mail_templates WHERE code = 'invitation'"))
    _replace_kind_check(OLD_KINDS)

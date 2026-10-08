"""Формулировка письма восстановления: пользователь запросил замену пароля.

Письмо восстановления собирается из строки `mail_templates` с кодом
`password_recovery`, которую добавила ревизия `0012`. Текст из `0012` начинался
с общих слов о восстановлении пароля, из-за чего в почте он читался почти как
письмо активации. Ревизия переписывает только эту строку: тема остаётся
прежней («Восстановление пароля в системе «Домовой»»), а в теле прямо сказано,
что пользователь запросил письмо для замены пароля. Шаблон активации `activation`
не трогаем.

Отдельная ревизия, а не правка `0012` на месте: `0012` уже применена на стендах,
и изменение готовой ревизии не доехало бы до базы, которая её прошла.

Идентификатор ревизии короче имени файла: колонка `alembic_version.version_num`
имеет тип `varchar(32)`, и полное имя в неё не влезает.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013_recovery_wording"
down_revision: str | None = "0012_password_recovery"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RECOVERY_TEMPLATE_CODE = "password_recovery"
RECOVERY_TEMPLATE_SUBJECT = "Восстановление пароля в системе «Домовой»"

# Новый текст: первая строка прямо называет повод письма — замену пароля.
RECOVERY_TEMPLATE_BODY = (
    "Здравствуйте, {full_name}!\n"
    "\n"
    "Вы запросили письмо для замены пароля в системе учёта проживающих «Домовой».\n"
    "Чтобы задать новый пароль вместо забытого, откройте ссылку:\n"
    "\n"
    "{activation_url}\n"
    "\n"
    "Ссылка действует {expires_hours} ч. и срабатывает один раз.\n"
    "Если вы не запрашивали восстановление пароля, просто проигнорируйте это письмо.\n"
)

# Прежний текст из `0012` — его возвращает `downgrade`.
PREVIOUS_TEMPLATE_BODY = (
    "Здравствуйте, {full_name}!\n"
    "\n"
    "Вы запросили восстановление пароля в системе учёта проживающих «Домовой».\n"
    "Чтобы задать новый пароль, откройте ссылку:\n"
    "\n"
    "{activation_url}\n"
    "\n"
    "Ссылка действует {expires_hours} ч. и срабатывает один раз.\n"
    "Если вы не запрашивали восстановление пароля, просто проигнорируйте это письмо.\n"
)

def _write_template(subject: str, body: str) -> None:
    """Переписать только строку шаблона восстановления, не задевая `activation`."""
    op.execute(
        sa.text(
            "UPDATE mail_templates SET subject = :subject, body = :body WHERE code = :code"
        ).bindparams(subject=subject, body=body, code=RECOVERY_TEMPLATE_CODE)
    )


def upgrade() -> None:
    _write_template(RECOVERY_TEMPLATE_SUBJECT, RECOVERY_TEMPLATE_BODY)


def downgrade() -> None:
    _write_template(RECOVERY_TEMPLATE_SUBJECT, PREVIOUS_TEMPLATE_BODY)

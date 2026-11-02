"""Ключи печатных форм: `invoices.invoice_file_key` и `invoice_documents.file_key`.

Счёт и акт перестают собираться на каждый запрос: PDF сохраняется в общее
файловое хранилище (`app/storage.py`, ревизия `0053_uploaded_files`) при первом
скачивании, а дальше отдаётся сохранённое (`app/invoice_files.py`). Ревизия
заводит только ссылки на объекты — по колонке на документ:

* `invoices.invoice_file_key` — ключ PDF счёта в том виде, в каком его принимает
  `app.storage.read_bytes` (`2026-10-29/invoices/invoice-7.pdf`, без префикса
  `uploads/`). `NULL` — файла ещё нет, форма ещё не запрашивалась;
* `invoice_documents.file_key` — то же для акта. Колонка на строке акта, а не на
  счёте: у счёта акт один (`UNIQUE (invoice_id, kind)`), но видов печатных форм
  со временем может стать больше, и ключ привязан к документу, а не к сделке.

**Backfill не делается, и это осознанно.** Генератор PDF живёт в коде приложения
(`app/billing_forms.py`) и зависит от шрифта в образе API; ревизия базы о нём
ничего не знает и запускается в том числе там, где приложения нет (`alembic
upgrade` в контейнере `api` до готовности приложения). Собирать PDF из SQL
значит продублировать вёрстку в миграции. Поэтому исторические счета получают
файл ленивым путём — при первом скачивании, как и новые. `NULL` в обеих
колонках — честное «файла ещё нет», а не «файл потерян».

**Идемпотентность.** `upgrade` защищён `ADD COLUMN IF NOT EXISTS` и переживает
повторный запуск после обрыва. Автогенерация не используется: ревизия состоит из
DDL, которое PostgreSQL делает без пересборки таблицы, а `INDEX` эти колонки не
требуют — по ним ничего не ищут, их читают по первичному ключу счёта.

**Обратимость.** `downgrade` снимает обе колонки. Потеря — только ключи: сами
объекты в бакете остаются, но ссылок на них больше нет, и следующий
`upgrade` не вернёт их — файл запишется заново по новому ключу с новой датой
(`save_bytes` раскладывает по дням). Это то же поведение, что у ревизии
`0053_uploaded_files`, и откат схемы объектов в S3 не трогает.

Идентификатор ревизии короче 32 символов: колонка `alembic_version.version_num`
имеет тип `varchar(32)`.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0054_invoice_file_keys"
down_revision: str | None = "0053_uploaded_files"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Две колонки в двух таблицах. Тип совпадает с моделью (`String(500)`), длина
# взята с запасом: ключ — это дата, каталог и имя объекта.
ADD_COLUMNS_SQL = (
    "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_file_key VARCHAR(500)",
    "ALTER TABLE invoice_documents ADD COLUMN IF NOT EXISTS file_key VARCHAR(500)",
)

DROP_COLUMNS_SQL = (
    "ALTER TABLE invoice_documents DROP COLUMN IF EXISTS file_key",
    "ALTER TABLE invoices DROP COLUMN IF EXISTS invoice_file_key",
)


def upgrade() -> None:
    for statement in ADD_COLUMNS_SQL:
        # `DEFAULT` не задаётся и backfill не делается: файла у исторических
        # счетов нет, и `NULL` — правильное состояние. Форма появится при первом
        # скачивании.
        op.execute(sa.text(statement))


def downgrade() -> None:
    for statement in DROP_COLUMNS_SQL:
        op.execute(sa.text(statement))

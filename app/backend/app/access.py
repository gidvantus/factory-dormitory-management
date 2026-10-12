"""Права на правку контента, который не принадлежит конкретному пользователю.

Проверка прав на тарифы совпадает с проверкой прав на организацию: правит
владелец или администратор, остальные читают. Отдельная зависимость здесь нужна
как имя: `TariffEditor` в сигнатуре ручки говорит, что именно требуется, а само
правило остаётся в одном месте — `app.api.organization`. Копия `EDIT_ROLES` и
`require_organization_edit` разошлась бы с оригиналом при первой же правке.
"""

from typing import Annotated

from fastapi import Depends

from app.api.organization import require_organization_edit
from app.models.organization import OrganizationMember

# Членство с ролью из `EDIT_ROLES`: иначе 401 без сессии, 403 «Недостаточно
# прав» и 404 «Организация не найдена» без членства — коды задаёт оригинал.
TariffEditor = Annotated[OrganizationMember, Depends(require_organization_edit)]

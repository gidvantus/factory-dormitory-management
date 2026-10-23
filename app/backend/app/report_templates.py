"""Шаблоны структуры отчёта как объекты организации.

Точка правды о принадлежности — колонка `report_templates.organization_id`, как у
корня данных (`dormitories.organization_id`, см. `app/access.py`). Отдельного
корня-общежития у шаблона нет, поэтому правило выборки живёт здесь, а роуты
только вызывают его: иначе фильтр пришлось бы повторять в каждой ручке.

Инварианты те же, что у остальных данных кабинета:

- организация берётся из сессии, а не из тела запроса;
- чужой шаблон и несуществующий неразличимы — `404`, никогда `403`;
- `organization_id IS NULL` — шаблон не видно никому: его судьбу решает владелец
  данных, а не код.
"""

from fastapi import HTTPException, status
from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from app.models.report_template import ReportTemplate

# Один текст на «шаблона нет» и «шаблон чужой»: различать их нельзя.
TEMPLATE_NOT_FOUND_DETAIL = "Шаблон не найден"


def visible_templates(organization_id: int) -> Select[ReportTemplate]:
    """Шаблоны организации из сессии.

    Сравнение с `organization_id`, а не с автором: принадлежность объекта не
    должна зависеть от того, в какой организации сотрудник сейчас работает.
    """
    return select(ReportTemplate).where(ReportTemplate.organization_id == organization_id)


def own_template(db: Session, template_id: int, organization_id: int) -> ReportTemplate:
    """Шаблон из библиотеки организации. Чужой и несуществующий неразличимы: `404`."""
    template = db.scalar(visible_templates(organization_id).where(ReportTemplate.id == template_id))
    if template is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, TEMPLATE_NOT_FOUND_DETAIL)
    return template


def name_taken(db: Session, organization_id: int, name: str) -> bool:
    """Занято ли имя шаблона **в этой организации** (без учёта регистра).

    Проверка ограничена организацией так же, как уникальное ограничение схемы:
    иначе вторая организация не смогла бы завести шаблон с тем же названием.
    Сравнение идёт в Python: `lower()` в SQLite не знает кириллицы, а схема
    уникальности регистрозависима — без этой проверки «Стандарт» и «стандарт»
    разошлись бы на юнит-прогоне и на стенде по-разному.
    """
    normalized = name.casefold()
    names = db.scalars(
        select(ReportTemplate.name).where(ReportTemplate.organization_id == organization_id)
    )
    return any(existing.casefold() == normalized for existing in names)

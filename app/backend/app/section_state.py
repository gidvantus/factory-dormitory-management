"""Состояние стандартных разделов и подвкладок одного общежития."""

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.dormitory import Dormitory

SECTIONS = {
    "report": "Большой отчёт",
    "places": "Места",
    "residents": "Проживающие",
    "movement": "Движение персонала",
    "inflow": "Приток",
    "outflow": "Отток",
    "payments": "Выплаты",
    "advance": "На аванс",
    "settlement": "На расчёт",
    "archive": "Архив",
}
PARENTS = {
    "inflow": "movement",
    "outflow": "movement",
    "advance": "payments",
    "settlement": "payments",
}


def locked_dormitory(db: Session, dormitory_id: int) -> Dormitory:
    item = db.scalar(
        select(Dormitory)
        .where(Dormitory.id == dormitory_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if item is None:
        raise HTTPException(404, "Общежитие не найдено")
    return item


def section_status(dormitory: Dormitory, key: str) -> str:
    return (dormitory.section_states or {}).get(key, "active")


def section_parents(dormitory: Dormitory) -> dict[str, str | None]:
    return {**PARENTS, **(dormitory.section_parents or {})}


def section_ancestors(dormitory: Dormitory, key: str) -> list[str]:
    result = [key]
    parents = section_parents(dormitory)
    while (parent := parents.get(result[-1])) and parent not in result:
        result.append(parent)
    return result


def require_section(db: Session, dormitory_id: int, key: str, *, writable: bool = False) -> None:
    dormitory = locked_dormitory(db, dormitory_id) if writable else db.get(Dormitory, dormitory_id)
    if dormitory is None:
        raise HTTPException(404, "Общежитие не найдено")
    for current in reversed(section_ancestors(dormitory, key)):
        if not current:
            continue
        state = section_status(dormitory, current)
        if state == "deleted":
            raise HTTPException(
                409,
                f"Раздел «{SECTIONS[current]}» удалён. Добавьте его через «Управление вкладками».",
            )
        if writable and state == "hidden":
            raise HTTPException(
                409,
                f"Вкладка «{SECTIONS[current]}» скрыта и доступна только для просмотра. "
                "Сначала восстановите её.",
            )


def require_section_writable(db: Session, dormitory_id: int, key: str) -> None:
    require_section(db, dormitory_id, key, writable=True)

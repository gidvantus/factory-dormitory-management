"""Разбор и применение файла импорта вкладки «Места».

Ответ разбора — единственный источник данных для экрана подтверждения и для
применения: `POST …/import` возвращает его, а `POST …/import/{id}/confirm`
читает сохранённый `import_jobs.result`. Поэтому у разбора и применения общий
набор полей, а не два разных ответа.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel

# Поля, которые импортируются. «Итого» и «Свободных мест» считаются на чтении.
PlacesImportField = Literal["residents_m", "residents_f", "paid_m", "paid_f"]


class PlacesImportIssue(BaseModel):
    """Ошибка или предупреждение разбора: строка и колонка файла, если известны."""

    row: int | None = None
    column: str | None = None
    message: str


class PlacesImportCounts(BaseModel):
    """Счётчики предпросмотра: хостелы файла, записываемые ячейки, удаляемые значения."""

    hostels: int
    cells: int
    deleted: int


class PlacesImportRow(BaseModel):
    """Строка файла: хостел, поле и непустые значения по дням месяца."""

    row: int
    hostel: str
    field: PlacesImportField
    values: dict[date, int]


class PlacesImportResult(BaseModel):
    """Результат разбора. `status = "failed"` приходит с ответом 422."""

    import_id: int
    status: Literal["ready", "failed"]
    months: list[date]
    counts: PlacesImportCounts
    rows: list[PlacesImportRow]
    errors: list[PlacesImportIssue]
    warnings: list[PlacesImportIssue]


class PlacesImportApplied(BaseModel):
    """Итог применения: что и за какой месяц записано."""

    import_id: int
    month: date
    hostels: int
    cells: int

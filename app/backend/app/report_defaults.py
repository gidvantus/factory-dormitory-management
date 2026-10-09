"""Обязательные итоговые строки большого отчёта."""

REQUIRED_REPORT_ROW_NAMES = (
    "Выход Итого",
    "Проживает Итого",
    "Текучка Итого",
)
DEFAULT_REPORT_FORMULA = "=0"


def required_row_name(name: str) -> str | None:
    return next(
        (item for item in REQUIRED_REPORT_ROW_NAMES if item.casefold() == name.casefold()), None
    )

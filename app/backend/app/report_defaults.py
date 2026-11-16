"""Обязательные итоговые строки общего отчёта."""

from collections.abc import Iterable
from typing import Literal

ReportMetric = Literal["attendance", "residents", "turnover"]
REPORT_METRIC_NAMES: dict[ReportMetric, str] = {
    "attendance": "Выход Итого",
    "residents": "Проживает Итого",
    "turnover": "Текучка Итого",
}
REQUIRED_REPORT_ROW_NAMES = tuple(REPORT_METRIC_NAMES.values())
REPORT_METRIC_BLOCK_NAMES: dict[ReportMetric, str] = {
    "residents": "Вахтовики по общежитиям",
    "turnover": "Текучка по общежитиям",
    "attendance": "Выход на работу",
}
DEFAULT_REPORT_FORMULA = "=0"


def legacy_report_metric(name: str) -> ReportMetric | None:
    return next(
        (key for key, label in REPORT_METRIC_NAMES.items() if label.casefold() == name.casefold()),
        None,
    )


def missing_report_metrics(
    rows: Iterable[tuple[str, str | None]],
) -> list[tuple[ReportMetric, str]]:
    names, metrics = set(), set()
    for name, metric in rows:
        names.add(name.casefold())
        metrics.add(metric)
    missing = []
    for metric, label in REPORT_METRIC_NAMES.items():
        if metric in metrics:
            continue
        name = label
        suffix = 2
        while name.casefold() in names:
            name = f"{label} ({suffix})"
            suffix += 1
        names.add(name.casefold())
        missing.append((metric, name))
    return missing

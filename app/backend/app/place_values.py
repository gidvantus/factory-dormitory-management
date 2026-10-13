"""Одинаковые дневные показатели для вкладки «Размещение персонала» и связей отчёта."""

from datetime import date

from app.models.hostel import Hostel


def active_in_month(hostel: Hostel, month: date) -> bool:
    return hostel.active_from_month <= month and (
        hostel.active_until_month is None or hostel.active_until_month > month
    )


def place_day_values(values: dict[str, int]) -> dict[str, int]:
    result = dict(values)
    for gender in ("m", "f"):
        paid, residents = f"paid_{gender}", f"residents_{gender}"
        if paid in result or residents in result:
            result[f"free_{gender}"] = result.get(paid, 0) - result.get(residents, 0)
    for group in ("residents", "paid", "free"):
        left, right = f"{group}_m", f"{group}_f"
        if left in result or right in result:
            result[f"{group}_total"] = result.get(left, 0) + result.get(right, 0)
    return result

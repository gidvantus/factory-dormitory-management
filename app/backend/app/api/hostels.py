"""Помесячные хостелы и таблицы мест в общежитии."""

import logging
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any
from uuid import uuid4

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Path,
    Query,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import JSONResponse
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, OwnDormitory, SubscribedUser
from app.db import get_db
from app.file_access import public_url, register_upload
from app.models.hostel import Hostel, HostelCell
from app.models.import_job import (
    IMPORT_STATUS_APPLIED,
    IMPORT_STATUS_FAILED,
    IMPORT_STATUS_READY,
    IMPORT_TABLE_PLACES,
    ImportJob,
)
from app.place_values import active_in_month, place_day_values
from app.places_import import (
    ImportIssue,
    ParsedImport,
    TemplateError,
    build_template,
    normalize_name,
    normalize_text,
    parse_places_workbook,
)
from app.schemas.hostel import (
    CreateHostelRequest,
    HostelMonthResponse,
    HostelResponse,
    PlaceField,
    PlacesResponse,
    SaveHostelCellRequest,
)
from app.schemas.places_import import (
    PlacesImportApplied,
    PlacesImportCounts,
    PlacesImportIssue,
    PlacesImportResult,
    PlacesImportRow,
)
from app.schemas.user import ErrorResponse
from app.section_state import require_section_writable
from app.storage import StorageError, storage
from app.table_data import lock_dormitory

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/hostels",
    tags=["hostels"],
    responses={
        status.HTTP_401_UNAUTHORIZED: {
            "model": ErrorResponse,
            "description": "Нет валидной cookie сессии",
        },
        **SUBSCRIBED_USER_RESPONSES,
    },
)
DbSession = Annotated[Session, Depends(get_db)]
DormitoryId = Annotated[int, Path(ge=1, le=2147483647)]
HostelId = Annotated[int, Path(ge=1, le=2147483647)]
ImportId = Annotated[int, Path(ge=1, le=2147483647)]

# Шаблон импорта и результат разбора — документы, а не JSON.
XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
# Тот же лимит стоит в nginx (`client_max_body_size 20m`): сюда больше не дойдёт.
MAX_IMPORT_BYTES = 20 * 1024 * 1024
IMPORT_FILE_TYPE_DETAIL = "Загрузите файл .xlsx"
IMPORT_FILE_TOO_BIG_DETAIL = "Файл больше 20 МБ — уменьшите его и попробуйте снова"
IMPORT_NOT_FOUND_DETAIL = "Импорт не найден"
IMPORT_NOT_READY_DETAIL = "Этот импорт уже применён или не готов"
NOT_FIRST_DAY_DETAIL = "Укажите первый день месяца"
# Файл не сохранён — импорта нет вовсе: задание без файла раздать было бы
# нечем, а «сделать вид, что сохранили» нельзя.
STORAGE_UNAVAILABLE_DETAIL = "Хранилище файлов недоступно, файл не сохранён"
# Назначение загрузки в реестре `uploaded_file` (`app/file_access`).
PLACES_IMPORT_PURPOSE = "places_import"

log = logging.getLogger(__name__)

NOT_FOUND_RESPONSE: dict[int | str, dict[str, Any]] = {
    status.HTTP_404_NOT_FOUND: {"model": ErrorResponse, "description": "Общежитие не найдено"},
}
SECTION_HIDDEN_RESPONSE: dict[int | str, dict[str, Any]] = {
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": "Вкладка скрыта, удалена или хостел не действует в этом месяце",
    },
}


def next_month(month: date) -> date:
    return date(month.year + (month.month == 12), month.month % 12 + 1, 1)


def get_hostel(db: Session, dormitory_id: int, hostel_id: int) -> Hostel:
    hostel = db.get(Hostel, hostel_id)
    if hostel is None or hostel.dormitory_id != dormitory_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Хостел не найден")
    return hostel


@router.get("/sources", summary="Все хостелы для настройки связи отчёта")
def list_sources(
    dormitory_id: DormitoryId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> list[dict[str, int | str]]:
    return [
        {"id": hostel.id, "name": hostel.name}
        for hostel in db.scalars(
            select(Hostel).where(Hostel.dormitory_id == dormitory_id).order_by(Hostel.id)
        )
    ]


@router.get("", response_model=PlacesResponse, summary="Размещение персонала за период")
def read_places(
    dormitory_id: DormitoryId,
    _user: SubscribedUser,
    db: DbSession,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
    _dormitory: OwnDormitory,
) -> PlacesResponse:
    if from_date > to_date or (to_date - from_date).days > 365:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Выберите период не длиннее года")
    first_month = from_date.replace(day=1)
    last_month = to_date.replace(day=1)
    hostels = list(
        db.scalars(
            select(Hostel)
            .where(
                Hostel.dormitory_id == dormitory_id,
                Hostel.active_from_month <= last_month,
                or_(Hostel.active_until_month.is_(None), Hostel.active_until_month > first_month),
            )
            .order_by(Hostel.active_from_month, Hostel.id)
        )
    )
    cells = (
        list(
            db.scalars(
                select(HostelCell).where(
                    HostelCell.hostel_id.in_([hostel.id for hostel in hostels]),
                    HostelCell.report_date >= from_date,
                    HostelCell.report_date <= to_date,
                )
            )
        )
        if hostels
        else []
    )
    values: dict[int, dict[str, dict[str, int]]] = {hostel.id: {} for hostel in hostels}
    for cell in cells:
        values[cell.hostel_id].setdefault(cell.field, {})[cell.report_date.isoformat()] = cell.value

    months: list[HostelMonthResponse] = []
    month = first_month
    while month <= last_month:
        start = max(from_date, month)
        end = min(to_date, next_month(month) - timedelta(days=1))
        days = [start + timedelta(days=offset) for offset in range((end - start).days + 1)]
        day_keys = {day.isoformat() for day in days}
        visible: list[HostelResponse] = []
        for hostel in hostels:
            if not active_in_month(hostel, month):
                continue
            row_values = {
                field: {day: value for day, value in day_values.items() if day in day_keys}
                for field, day_values in values[hostel.id].items()
            }
            for field in ("free_m", "free_f", "residents_total", "free_total", "paid_total"):
                row_values[field] = {}
            for day in days:
                key = day.isoformat()
                calculated = place_day_values(
                    {field: entries[key] for field, entries in row_values.items() if key in entries}
                )
                for field, value in calculated.items():
                    row_values.setdefault(field, {})[key] = value
            visible.append(HostelResponse(id=hostel.id, name=hostel.name, values=row_values))
        months.append(HostelMonthResponse(month=month, days=days, hostels=visible))
        month = next_month(month)
    return PlacesResponse(months=months)


@router.post("", status_code=status.HTTP_201_CREATED, summary="Добавить хостел")
def create_hostel(
    dormitory_id: DormitoryId,
    payload: CreateHostelRequest,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> dict[str, int | str]:
    require_section_writable(db, dormitory_id, "places")
    existing = db.scalars(select(Hostel).where(Hostel.dormitory_id == dormitory_id))
    if any(
        hostel.name.casefold() == payload.name.casefold()
        and (hostel.active_until_month is None or hostel.active_until_month > payload.month)
        for hostel in existing
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Хостел с таким названием уже есть в этом месяце"
        )
    hostel = Hostel(dormitory_id=dormitory_id, name=payload.name, active_from_month=payload.month)
    db.add(hostel)
    db.commit()
    db.refresh(hostel)
    return {"id": hostel.id, "name": hostel.name}


@router.delete(
    "/{hostel_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Убрать хостел с месяца"
)
def remove_hostel(
    dormitory_id: DormitoryId,
    hostel_id: HostelId,
    _user: SubscribedUser,
    db: DbSession,
    month: Annotated[date, Query()],
    _dormitory: OwnDormitory,
) -> None:
    require_section_writable(db, dormitory_id, "places")
    if month.day != 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите первый день месяца")
    hostel = get_hostel(db, dormitory_id, hostel_id)
    if month < hostel.active_from_month:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Хостел ещё не создан в этом месяце"
        )
    if hostel.active_until_month is not None and hostel.active_until_month <= month:
        raise HTTPException(status.HTTP_409_CONFLICT, "Хостел уже убран с этого месяца")
    hostel.active_until_month = month
    db.commit()


@router.put(
    "/{hostel_id}/cells/{report_date}/{field}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Автоматически сохранить место за день",
)
def save_hostel_cell(
    dormitory_id: DormitoryId,
    hostel_id: HostelId,
    report_date: date,
    field: PlaceField,
    payload: SaveHostelCellRequest,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> None:
    require_section_writable(db, dormitory_id, "places")
    hostel = get_hostel(db, dormitory_id, hostel_id)
    if not active_in_month(hostel, report_date.replace(day=1)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Хостел не действует в этом месяце")
    cell = db.scalar(
        select(HostelCell).where(
            HostelCell.hostel_id == hostel_id,
            HostelCell.report_date == report_date,
            HostelCell.field == field,
        )
    )
    if payload.value is None:
        if cell is not None:
            db.delete(cell)
    elif cell is None:
        db.add(
            HostelCell(
                hostel_id=hostel_id, report_date=report_date, field=field, value=payload.value
            )
        )
    else:
        cell.value = payload.value
        cell.updated_at = func.now()
    db.commit()


def import_issue(issue: ImportIssue) -> PlacesImportIssue:
    """Ошибка разбора в виде ответа: та же строка и колонка файла."""
    return PlacesImportIssue(row=issue.row, column=issue.column, message=issue.message)


def count_deleted_cells(db: Session, dormitory_id: int, parsed: ParsedImport) -> int:
    """Сколько сохранённых значений исчезнет после полной замены месяца.

    Считаем по разнице с текущими данными, а не по числу пустых ячеек файла:
    пользователю важно, сколько значений он потеряет.
    """
    planned = {
        (normalize_name(row.hostel), day, row.field) for row in parsed.rows for day in row.values
    }
    stored = db.execute(
        select(Hostel.name, HostelCell.report_date, HostelCell.field)
        .join(HostelCell, HostelCell.hostel_id == Hostel.id)
        .where(
            Hostel.dormitory_id == dormitory_id,
            HostelCell.report_date >= parsed.month,
            HostelCell.report_date < next_month(parsed.month),
        )
    )
    return sum(
        1 for name, day, field in stored if (normalize_name(name), day, field) not in planned
    )


@router.get(
    "/import/template",
    summary="Скачать шаблон импорта размещения персонала за месяц",
    response_class=Response,
    responses={
        status.HTTP_200_OK: {
            "content": {XLSX_MEDIA_TYPE: {}},
            "description": "Шаблон .xlsx за выбранный месяц",
        },
        **NOT_FOUND_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": NOT_FIRST_DAY_DETAIL,
        },
    },
)
def download_places_import_template(
    dormitory_id: DormitoryId,
    _user: SubscribedUser,
    db: DbSession,
    month: Annotated[date, Query()],
    _dormitory: OwnDormitory,
) -> Response:
    """Шаблон за месяц: строка на каждое поле каждого действующего хостела."""
    if month.day != 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, NOT_FIRST_DAY_DETAIL)
    hostels = list(
        db.scalars(
            select(Hostel)
            .where(
                Hostel.dormitory_id == dormitory_id,
                Hostel.active_from_month <= month,
                or_(Hostel.active_until_month.is_(None), Hostel.active_until_month > month),
            )
            .order_by(Hostel.active_from_month, Hostel.id)
        )
    )
    values: dict[int, dict[date, dict[str, int]]] = {hostel.id: {} for hostel in hostels}
    if hostels:
        cells = db.scalars(
            select(HostelCell).where(
                HostelCell.hostel_id.in_([hostel.id for hostel in hostels]),
                HostelCell.report_date >= month,
                HostelCell.report_date < next_month(month),
            )
        )
        for cell in cells:
            values[cell.hostel_id].setdefault(cell.report_date, {})[cell.field] = cell.value
    content = build_template(month, [(hostel.name, values[hostel.id]) for hostel in hostels])
    filename = f"mesta-{month:%Y-%m}.xlsx"
    return Response(
        content=content,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post(
    "/import",
    summary="Загрузить файл импорта размещения персонала",
    response_model=PlacesImportResult,
    responses={
        status.HTTP_200_OK: {"model": PlacesImportResult, "description": "Разбор без ошибок"},
        **NOT_FOUND_RESPONSE,
        **SECTION_HIDDEN_RESPONSE,
        status.HTTP_413_REQUEST_ENTITY_TOO_LARGE: {
            "model": ErrorResponse,
            "description": IMPORT_FILE_TOO_BIG_DETAIL,
        },
        status.HTTP_415_UNSUPPORTED_MEDIA_TYPE: {
            "model": ErrorResponse,
            "description": IMPORT_FILE_TYPE_DETAIL,
        },
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": PlacesImportResult,
            "description": "Ошибки разбора или файл не похож на шаблон",
        },
        status.HTTP_503_SERVICE_UNAVAILABLE: {
            "model": ErrorResponse,
            "description": STORAGE_UNAVAILABLE_DETAIL,
        },
    },
)
async def upload_places_import(
    dormitory_id: DormitoryId,
    user: SubscribedUser,
    db: DbSession,
    file: Annotated[UploadFile, File()],
    _dormitory: OwnDormitory,
) -> Response:
    """Разобрать файл прямо в запросе и сохранить результат в журнал импортов.

    Ответ 422 приходит с полным результатом разбора: по нему экран показывает
    ошибки и номер задания. Ячейки «Размещение персонала» при ошибках не меняются вовсе.

    Исходный файл сохраняется в хранилище (`app/storage`) и остаётся доступным по
    ссылке `file_url` — в том числе при ошибках разбора: человеку нужно увидеть
    файл, который он загрузил, чтобы исправить ошибки. Файл, задание импорта и
    строка реестра `uploaded_file` пишутся одной транзакцией: задания без файла
    не бывает, поэтому ошибка хранилища — это 503 и импорта не создаётся.
    """
    require_section_writable(db, dormitory_id, "places")
    filename = file.filename or ""
    if not filename.lower().endswith(".xlsx"):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, IMPORT_FILE_TYPE_DETAIL)
    content = await file.read()
    if len(content) > MAX_IMPORT_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, IMPORT_FILE_TOO_BIG_DETAIL)
    try:
        parsed = parse_places_workbook(content)
    except TemplateError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(error)) from error

    # Имя объекта — случайное: коллизий имён файлов не бывает, а имя из запроса
    # (его задаёт клиент) в ключ хранилища не попадает. Подпапку дня добавляет
    # сам `storage.save_bytes`.
    try:
        file_key = storage.save_bytes(content, f"{uuid4().hex}.xlsx", content_type=XLSX_MEDIA_TYPE)
    except StorageError as error:
        # Подробность (адрес бакета, код S3) в ответ не попадает: клиенту она
        # не нужна, а в лог уходит без ключей доступа.
        log.warning("Импорт «Места»: файл не сохранён: %s", error)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, STORAGE_UNAVAILABLE_DETAIL
        ) from error

    ready = not parsed.errors
    job = ImportJob(
        dormitory_id=dormitory_id,
        table_key=IMPORT_TABLE_PLACES,
        status=IMPORT_STATUS_READY if ready else IMPORT_STATUS_FAILED,
        filename=filename[:255],
        size_bytes=len(content),
        file_key=file_key,
        created_by=user.id,
        result={},
    )
    db.add(job)
    db.flush()
    # Реестр загрузок — часть той же транзакции (`commit=False`): строка учёта
    # не должна появиться без задания и наоборот.
    register_upload(db, file_key, user, purpose=PLACES_IMPORT_PURPOSE, commit=False)
    result = PlacesImportResult(
        import_id=job.id,
        status="ready" if ready else "failed",
        file_url=public_url(file_key),
        months=[parsed.month],
        counts=PlacesImportCounts(
            hostels=len(parsed.hostels),
            cells=parsed.cells,
            deleted=count_deleted_cells(db, dormitory_id, parsed),
        ),
        rows=[
            PlacesImportRow(row=row.row, hostel=row.hostel, field=row.field, values=row.values)
            for row in parsed.rows
        ],
        errors=[import_issue(issue) for issue in parsed.errors],
        warnings=[import_issue(issue) for issue in parsed.warnings],
    )
    job.result = result.model_dump(mode="json")
    db.commit()
    return JSONResponse(
        content=result.model_dump(mode="json"),
        status_code=status.HTTP_200_OK if ready else status.HTTP_422_UNPROCESSABLE_ENTITY,
    )


def apply_import(db: Session, dormitory_id: int, job: ImportJob) -> PlacesImportApplied:
    """Полная замена месяца из файла: удалить ячейки месяца и записать непустые."""
    stored = job.result or {}
    months = stored.get("months") or []
    if not months:
        raise HTTPException(status.HTTP_409_CONFLICT, IMPORT_NOT_READY_DETAIL)
    month = date.fromisoformat(str(months[0]))
    rows: list[dict[str, Any]] = list(stored.get("rows") or [])

    known: dict[str, Hostel] = {}
    for existing in db.scalars(select(Hostel).where(Hostel.dormitory_id == dormitory_id)):
        known.setdefault(normalize_name(existing.name), existing)

    touched: dict[str, Hostel] = {}
    for row in rows:
        name = normalize_text(row.get("hostel"))
        key = normalize_name(name)
        if not name or key in touched:
            continue
        hostel = known.get(key)
        if hostel is None:
            hostel = Hostel(dormitory_id=dormitory_id, name=name, active_from_month=month)
            db.add(hostel)
            db.flush()
            known[key] = hostel
        elif not active_in_month(hostel, month):
            # Продлеваем период по тем же правилам, что у POST /hostels: хостел,
            # созданный позже или убранный раньше, снова действует в этом месяце.
            if hostel.active_from_month > month:
                hostel.active_from_month = month
            if hostel.active_until_month is not None and hostel.active_until_month <= month:
                hostel.active_until_month = None
        touched[key] = hostel

    hostel_ids = list(db.scalars(select(Hostel.id).where(Hostel.dormitory_id == dormitory_id)))
    if hostel_ids:
        # Месяцы, которых нет в файле, не трогаем: замена идёт только по месяцу файла.
        db.execute(
            delete(HostelCell).where(
                HostelCell.hostel_id.in_(hostel_ids),
                HostelCell.report_date >= month,
                HostelCell.report_date < next_month(month),
            )
        )

    cells = 0
    for row in rows:
        hostel = touched.get(normalize_name(normalize_text(row.get("hostel"))))
        if hostel is None:
            continue
        for day_text, value in (row.get("values") or {}).items():
            db.add(
                HostelCell(
                    hostel_id=hostel.id,
                    report_date=date.fromisoformat(str(day_text)),
                    field=str(row.get("field")),
                    value=int(value),
                )
            )
            cells += 1

    job.status = IMPORT_STATUS_APPLIED
    job.applied_at = datetime.now(UTC)
    db.commit()
    return PlacesImportApplied(import_id=job.id, month=month, hostels=len(touched), cells=cells)


@router.post(
    "/import/{import_id}/confirm",
    response_model=PlacesImportApplied,
    summary="Применить импорт размещения персонала",
    responses={
        **NOT_FOUND_RESPONSE,
        **SECTION_HIDDEN_RESPONSE,
        status.HTTP_409_CONFLICT: {
            "model": ErrorResponse,
            "description": IMPORT_NOT_READY_DETAIL,
        },
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": "В задании нет месяца импорта",
        },
    },
)
def confirm_places_import(
    dormitory_id: DormitoryId,
    import_id: ImportId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> PlacesImportApplied:
    """Применить задание: блокировка строки задания исключает двойное применение."""
    require_section_writable(db, dormitory_id, "places")
    lock_dormitory(db, dormitory_id)
    job = db.scalar(
        select(ImportJob)
        .where(
            ImportJob.id == import_id,
            ImportJob.dormitory_id == dormitory_id,
            ImportJob.table_key == IMPORT_TABLE_PLACES,
        )
        .with_for_update()
    )
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, IMPORT_NOT_FOUND_DETAIL)
    if job.status != IMPORT_STATUS_READY:
        raise HTTPException(status.HTTP_409_CONFLICT, IMPORT_NOT_READY_DETAIL)
    try:
        return apply_import(db, dormitory_id, job)
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        # Любая ошибка записи — месяц остаётся в прежнем виде.
        db.rollback()
        raise

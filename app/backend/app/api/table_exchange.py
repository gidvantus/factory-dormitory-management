"""Импорт добавляет данные одной транзакцией, экспорт читает всю таблицу."""

from datetime import date
from hashlib import sha256
from typing import Annotated
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app import audit
from app.access import OwnDormitory
from app.db import get_db
from app.models.table_import_job import ImportStatus, TableImportJob, TableImportProgress
from app.role_permissions import EXCHANGE_USER_RESPONSES, ExportUser, ImportUser
from app.section_state import locked_dormitory
from app.table_exchange import MAX_BYTES, export_rows, make_workbook, prepare_table
from app.table_import_queue import ImportResult, apply_table_import, lock_progress, notify_import

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/data-transfer/{table_key}",
    tags=["table-exchange"],
    responses=EXCHANGE_USER_RESPONSES,
)
DbSession = Annotated[Session, Depends(get_db)]
EntityId = Annotated[int, Path(ge=1, le=2147483647)]
TableKey = Annotated[
    str,
    Path(
        pattern=r"^(report|places|residents|inflow|outflow|advance|settlement|archive|custom_[1-9][0-9]{0,9})$"
    ),
]
Start = Annotated[date | None, Query(alias="from")]
End = Annotated[date | None, Query(alias="to")]
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class ImportJobProgress(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    rows_processed: int
    rows_total: int


class ImportJobResponse(ImportResult):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    status: ImportStatus
    detail: str | None
    progress: ImportJobProgress | None
    cancel_requested: bool

    @field_validator("progress", mode="before")
    @classmethod
    def hide_unknown_progress(cls, value: object) -> object:
        if isinstance(value, TableImportProgress) and not value.rows_total:
            return None
        return value


def file_content(file: UploadFile) -> bytes:
    if not (file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(422, "Выберите заполненный шаблон в формате .xlsx")
    content = file.file.read(MAX_BYTES + 1)
    if not content or len(content) > MAX_BYTES:
        raise HTTPException(422, "Загрузите непустой файл .xlsx размером до 20 МБ")
    return content


def file_response(data: bytes, name: str, kind: str) -> Response:
    filename = quote(f"{'Шаблон' if kind == 'template' else 'Экспорт'}-{name}.xlsx", safe="")
    disposition = f'attachment; filename="{kind}.xlsx"; ' + f"filename*=UTF-8''{filename}"
    return Response(
        data,
        media_type=XLSX,
        headers={
            "Content-Disposition": disposition,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/template")
def download_template(
    dormitory_id: EntityId,
    table_key: TableKey,
    _user: ImportUser,
    db: DbSession,
    _dormitory: OwnDormitory,
    from_date: Start = None,
    to_date: End = None,
) -> Response:
    dorm = locked_dormitory(db, dormitory_id)
    table = prepare_table(db, dorm, table_key, from_date, to_date, importing=True)
    result = make_workbook(table, template=True)
    db.commit()
    return file_response(result, table.name, "template")


@router.get("/export")
def download_export(
    dormitory_id: EntityId,
    table_key: TableKey,
    _user: ExportUser,
    db: DbSession,
    _dormitory: OwnDormitory,
    from_date: Start = None,
    to_date: End = None,
) -> Response:
    dorm = locked_dormitory(db, dormitory_id)
    table = prepare_table(db, dorm, table_key, from_date, to_date, importing=False)
    result = make_workbook(
        table, template=False, rows=export_rows(table, from_date, to_date, _user)
    )
    db.commit()
    return file_response(result, table.name, "export")


@router.post("/import", response_model=ImportResult)
def upload_import(
    dormitory_id: EntityId,
    table_key: TableKey,
    file: UploadFile,
    _user: ImportUser,
    db: DbSession,
    _dormitory: OwnDormitory,
    from_date: Start = None,
    to_date: End = None,
) -> ImportResult:
    content = file_content(file)
    try:
        result, created = apply_table_import(
            db, dormitory_id, table_key, content, _user.id, from_date, to_date
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    notify_import(db, dormitory_id, table_key, _user.id, created)
    return result


@router.post("/import/jobs", response_model=ImportJobResponse, status_code=202)
def enqueue_import(
    dormitory_id: EntityId,
    table_key: TableKey,
    file: UploadFile,
    job_id: Annotated[UUID, Header(alias="Idempotency-Key")],
    user: ImportUser,
    db: DbSession,
    dormitory: OwnDormitory,
    from_date: Start = None,
    to_date: End = None,
) -> TableImportJob:
    content = file_content(file)
    checksum = sha256(content).hexdigest()
    request = (
        dormitory_id,
        table_key,
        user.id,
        dormitory.organization_id,
        audit.is_impersonated(),
        from_date,
        to_date,
        checksum,
    )
    job = db.get(TableImportJob, job_id)
    if job is None:
        job = TableImportJob(
            id=job_id,
            dormitory_id=dormitory_id,
            table_key=table_key,
            actor_id=user.id,
            organization_id=dormitory.organization_id,
            impersonated=audit.is_impersonated(),
            from_date=from_date,
            to_date=to_date,
            checksum=checksum,
            content=content,
            progress=TableImportProgress(rows_processed=0, rows_total=0),
        )
        db.add(job)
        try:
            db.commit()
        except IntegrityError:
            # Два одновременных повтора сходятся на одном ключе задания.
            db.rollback()
            winner = db.get(TableImportJob, job_id)
            if winner is None:
                raise
            job = winner
    if (
        job.dormitory_id,
        job.table_key,
        job.actor_id,
        job.organization_id,
        job.impersonated,
        job.from_date,
        job.to_date,
        job.checksum,
    ) != request:
        raise HTTPException(409, "Этот номер импорта уже использован для другого запроса")
    return job


def owned_import_job(
    dormitory_id: EntityId,
    table_key: TableKey,
    job_id: UUID,
    user: ImportUser,
    db: DbSession,
    dormitory: OwnDormitory,
) -> TableImportJob:
    job = db.scalar(
        select(TableImportJob)
        .where(TableImportJob.id == job_id)
        .options(joinedload(TableImportJob.progress))
        .execution_options(populate_existing=True)
    )
    if job is None or (
        job.dormitory_id,
        job.table_key,
        job.actor_id,
        job.organization_id,
        job.impersonated,
    ) != (dormitory_id, table_key, user.id, dormitory.organization_id, audit.is_impersonated()):
        raise HTTPException(404, "Задание импорта не найдено")
    return job


@router.get("/import/jobs/{job_id}", response_model=ImportJobResponse)
def import_status(
    dormitory_id: EntityId,
    table_key: TableKey,
    job_id: UUID,
    user: ImportUser,
    db: DbSession,
    dormitory: OwnDormitory,
) -> TableImportJob:
    return owned_import_job(dormitory_id, table_key, job_id, user, db, dormitory)


@router.post("/import/jobs/{job_id}/cancel", response_model=ImportJobResponse)
def cancel_import(
    dormitory_id: EntityId,
    table_key: TableKey,
    job_id: UUID,
    user: ImportUser,
    db: DbSession,
    dormitory: OwnDormitory,
) -> TableImportJob:
    job = owned_import_job(dormitory_id, table_key, job_id, user, db, dormitory)
    if job.status != "pending":
        return job
    # Свободное задание отменяем сразу, выполняемое получает запрос на откат.
    queued = db.scalar(
        select(TableImportJob.id)
        .where(TableImportJob.id == job_id, TableImportJob.status == "pending")
        .with_for_update(skip_locked=True, key_share=True)
    )
    progress = lock_progress(db, job_id)
    db.refresh(job)
    if job.status == "pending":
        progress.cancel_requested = True
        if queued is not None:
            job.status = "cancelled"
            job.content = None
            progress.rows_processed = progress.rows_total = 0
        db.commit()
    return job

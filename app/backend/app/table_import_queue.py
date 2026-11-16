"""Проверка и выполнение Excel-импорта, в том числе из устойчивой очереди."""

import asyncio
import logging
from contextlib import suppress
from datetime import date
from time import perf_counter
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app import audit, dormitory_history, notification_rules
from app import db as database
from app.access import require_subscribed_user
from app.api.organization import require_organization_membership
from app.models.table_import_job import TableImportJob, TableImportProgress
from app.models.user import User
from app.role_permissions import permissions_for, require_import_user
from app.section_state import locked_dormitory
from app.security import require_active_user
from app.table_exchange import (
    RowProgress,
    append_rows,
    import_grid,
    prepare_table,
    read_template,
    validate_rows,
)

logger = logging.getLogger(__name__)
IMPORT_PATH = "/api/dormitories/{dormitory_id}/data-transfer/{table_key}/import"
IMPORT_FAILED = "Не удалось выполнить импорт. Попробуйте загрузить файл снова."


class ImportResult(BaseModel):
    rows_added: int = 0
    cells_added: int = 0


class ImportCancelled(Exception):
    """Запрос отмены прерывает обработку и откатывает строки файла."""


def apply_table_import(
    db: Session,
    dormitory_id: int,
    table_key: str,
    content: bytes,
    actor_id: int,
    from_date: date | None,
    to_date: date | None,
    on_progress: RowProgress | None = None,
) -> tuple[ImportResult, list[int]]:
    dorm = locked_dormitory(db, dormitory_id)
    table = prepare_table(db, dorm, table_key, from_date, to_date, importing=True)
    rows = read_template(content, table)
    created: list[int] = []
    if table.grid is not None:
        result = ImportResult(cells_added=import_grid(table, rows, on_progress))
    else:
        created = append_rows(table, validate_rows(table, rows), actor_id, on_progress)
        result = ImportResult(rows_added=len(created))
    if not result.rows_added and not result.cells_added:
        raise HTTPException(422, "В шаблоне нет заполненных данных для импорта")
    return result, created


def notify_import(
    db: Session, dormitory_id: int, table_key: str, actor_id: int, created: list[int]
) -> None:
    for identifier in created:
        notification_rules.notify_row_written(
            db, dormitory_id=dormitory_id, table_key=table_key, row_id=identifier, actor_id=actor_id
        )


def lock_progress(db: Session, job_id: UUID) -> TableImportProgress:
    return db.execute(
        select(TableImportProgress)
        .where(TableImportProgress.job_id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one()


def save_progress(db: Session, job_id: UUID, processed: int, total: int) -> bool:
    return db.execute(
        update(TableImportProgress)
        .where(TableImportProgress.job_id == job_id)
        .values(rows_processed=processed, rows_total=total)
        .returning(TableImportProgress.cancel_requested)
    ).scalar_one()


def run_next_import() -> bool:
    with database.SessionLocal() as db:
        job = db.scalar(
            select(TableImportJob)
            .where(TableImportJob.status == "pending")
            .order_by(TableImportJob.created_at, TableImportJob.id)
            .limit(1)
            .with_for_update(skip_locked=True, key_share=True)
        )
        if job is None:
            return False
        job_id = job.id
        publish_live = db.get_bind().dialect.name == "postgresql"
        initial = db.get(TableImportProgress, job_id)
        assert initial is not None
        cancelled = initial.cancel_requested
        if publish_live and not cancelled and initial.rows_total:
            # Повторный запуск обнуляет счётчик, сохраняя запрос отмены.
            with audit.audit_session() as progress_db, progress_db.begin():
                cancelled = save_progress(progress_db, job_id, 0, 0)

        latest_progress: tuple[int, int] | None = None
        next_update = 0.0

        def report_progress(processed: int, total: int) -> None:
            nonlocal latest_progress, next_update
            latest_progress = (processed, total)
            if not publish_live:
                return
            now = perf_counter()
            if now < next_update:
                return
            next_update = now + 1
            try:
                # Служебный коммит публикует счётчик без записи в журнал действий.
                with audit.audit_session() as progress_db, progress_db.begin():
                    requested = save_progress(progress_db, job_id, processed, total)
            except SQLAlchemyError as error:
                logger.warning(
                    "Не удалось обновить прогресс импорта %s (%s)", job_id, type(error).__name__
                )
            else:
                if requested:
                    raise ImportCancelled

        user = db.get(User, job.actor_id)
        context = audit.AuditContext(
            request_id=str(job.id),
            method="POST",
            scope={
                "path": IMPORT_PATH,
                "path_params": {"dormitory_id": job.dormitory_id, "table_key": job.table_key},
            },
            ip=None,
            user_agent=None,
            request_body=None,
            started=perf_counter(),
            actor_id=job.actor_id,
            actor_name=user.full_name if user else None,
            organization_id=None if job.impersonated else job.organization_id,
            impersonated=job.impersonated,
        )
        audit_token = audit.start_context(context)
        history_token = dormitory_history.request_context.set(
            dormitory_history.HistoryRequest(
                "POST",
                actor_id=context.actor_id,
                organization_id=job.organization_id,
                actor_name=context.actor_name,
            )
        )
        created: list[int] = []
        try:
            # Откат savepoint отменяет изменения таблицы, оставляя блокировку задания.
            with db.begin_nested():
                if cancelled:
                    raise ImportCancelled
                if user is None or user.active_organization_id != job.organization_id:
                    raise HTTPException(403, "Доступ к организации изменился")
                membership = require_organization_membership(require_active_user(user), db)
                require_import_user(require_subscribed_user(user, db), membership, db)
                if not permissions_for(db, membership.role).dormitories_enabled:
                    raise HTTPException(403, "Доступ к разделу «Общежития» отключён")
                dormitory = locked_dormitory(db, job.dormitory_id)
                if dormitory.organization_id != job.organization_id:
                    raise HTTPException(403, "Доступ к общежитию изменился")
                result, created = apply_table_import(
                    db,
                    job.dormitory_id,
                    job.table_key,
                    job.content or b"",
                    job.actor_id,
                    job.from_date,
                    job.to_date,
                    on_progress=report_progress,
                )
                # Сервер принимает отмену под той же блокировкой, что и завершение.
                progress = lock_progress(db, job_id)
                if progress.cancel_requested:
                    raise ImportCancelled
            job.status = "completed"
            job.rows_added, job.cells_added = result.rows_added, result.cells_added
            if latest_progress is not None:
                progress.rows_processed, progress.rows_total = latest_progress
        except ImportCancelled:
            job.status = "cancelled"
        except OperationalError:
            # Временный сбой БД оставляет задание в очереди после отката транзакции.
            raise
        except HTTPException as error:
            job.status = "failed"
            job.detail = error.detail if isinstance(error.detail, str) else IMPORT_FAILED
        except Exception as error:
            logger.error("Импорт %s не выполнен (%s)", job.id, type(error).__name__)
            job.status = "failed"
            job.detail = IMPORT_FAILED
        finally:
            dormitory_history.request_context.reset(history_token)
            audit.finish_context(audit_token)

        # Результат, данные и журнал применения фиксируются вместе. При остановке
        # процесса до коммита PostgreSQL снимет блокировку и вернёт задание в очередь.
        if job.status != "completed":
            progress = lock_progress(db, job_id)
            if progress.cancel_requested:
                job.status, job.detail = "cancelled", None
            progress.rows_processed, progress.rows_total = 0, 0
        job.content = None
        db.commit()
        if job.status == "completed" and not job.impersonated:
            notify_import(db, job.dormitory_id, job.table_key, job.actor_id, created)
        return True


async def process_import_queue(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            if await asyncio.to_thread(run_next_import):
                continue
        except Exception as error:
            logger.error("Не удалось прочитать очередь импорта (%s)", type(error).__name__)
        with suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=1)

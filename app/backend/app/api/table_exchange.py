"""Импорт добавляет данные одной транзакцией, экспорт читает всю таблицу."""

from datetime import date
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Path, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import notification_rules
from app.access import OwnDormitory
from app.db import get_db
from app.role_permissions import EXCHANGE_USER_RESPONSES, ExportUser, ImportUser
from app.section_state import locked_dormitory
from app.table_exchange import (
    MAX_BYTES,
    append_rows,
    export_rows,
    import_grid,
    make_workbook,
    prepare_table,
    read_template,
    validate_rows,
)

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


class ImportResult(BaseModel):
    rows_added: int = 0
    cells_added: int = 0


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
    # Поток ограничен до разбора ZIP; оригинал файла не сохраняется в хранилище.
    if not (file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(422, "Выберите заполненный шаблон в формате .xlsx")
    content = file.file.read(MAX_BYTES + 1)
    dorm = locked_dormitory(db, dormitory_id)
    try:
        table = prepare_table(db, dorm, table_key, from_date, to_date, importing=True)
        rows = read_template(content, table)
        created: list[int] = []
        if table.grid is not None:
            result = ImportResult(cells_added=import_grid(table, rows))
        else:
            parsed = validate_rows(table, rows)
            created = append_rows(table, parsed, _user.id)
            result = ImportResult(rows_added=len(created))
        if not result.rows_added and not result.cells_added:
            raise HTTPException(422, "В шаблоне нет заполненных данных для импорта")
        db.commit()
    except Exception:
        db.rollback()
        raise
    for identifier in created:
        notification_rules.notify_row_written(
            db, dormitory_id=dormitory_id, table_key=table_key, row_id=identifier, actor_id=_user.id
        )
    return result

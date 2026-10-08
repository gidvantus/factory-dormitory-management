"""Общие шаблоны: снимок строк без данных, список и удаление."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.dormitory import Dormitory
from app.models.report import ReportRow
from app.models.report_template import ReportTemplate, ReportTemplateRow
from app.schemas.report_template import (
    CreateReportTemplateRequest,
    ReportTemplateDetailResponse,
    ReportTemplateResponse,
    ReportTemplateRowResponse,
)
from app.schemas.user import ErrorResponse
from app.security import ACTIVE_USER_RESPONSES, ActiveUser

router = APIRouter(
    prefix="/report-templates",
    tags=["report-templates"],
    responses={401: {"model": ErrorResponse}, **ACTIVE_USER_RESPONSES},
)
DbSession = Annotated[Session, Depends(get_db)]


@router.get("", response_model=list[ReportTemplateResponse], summary="Список шаблонов отчёта")
def list_templates(_user: ActiveUser, db: DbSession) -> list[ReportTemplateResponse]:
    result = db.execute(
        select(ReportTemplate, func.count(ReportTemplateRow.id))
        .outerjoin(ReportTemplateRow, ReportTemplateRow.template_id == ReportTemplate.id)
        .group_by(ReportTemplate.id)
        .order_by(ReportTemplate.created_at.desc(), ReportTemplate.id.desc())
    )
    return [
        ReportTemplateResponse(
            id=template.id,
            name=template.name,
            row_count=count,
            created_at=template.created_at,
        )
        for template, count in result
    ]


@router.get(
    "/{template_id}", response_model=ReportTemplateDetailResponse, summary="Просмотр шаблона отчёта"
)
def read_template(
    template_id: Annotated[int, Path(ge=1, le=2147483647)],
    _user: ActiveUser,
    db: DbSession,
) -> ReportTemplateDetailResponse:
    template = db.get(ReportTemplate, template_id)
    if template is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Шаблон не найден")
    rows = list(
        db.scalars(
            select(ReportTemplateRow)
            .where(ReportTemplateRow.template_id == template_id)
            .order_by(ReportTemplateRow.position, ReportTemplateRow.id)
        )
    )
    return ReportTemplateDetailResponse(
        id=template.id,
        name=template.name,
        row_count=len(rows),
        created_at=template.created_at,
        rows=[
            ReportTemplateRowResponse(name=row.name, position=row.position, formula=row.formula)
            for row in rows
        ],
    )


@router.post(
    "",
    response_model=ReportTemplateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Сохранить структуру отчёта как шаблон",
)
def create_template(
    payload: CreateReportTemplateRequest, user: ActiveUser, db: DbSession
) -> ReportTemplateResponse:
    if db.get(Dormitory, payload.dormitory_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Общежитие не найдено")
    rows = list(
        db.scalars(
            select(ReportRow)
            .where(ReportRow.dormitory_id == payload.dormitory_id)
            .order_by(ReportRow.position, ReportRow.id)
        )
    )
    if not rows:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "В отчёте пока нет строк")
    if any(
        name.casefold() == payload.name.casefold()
        for name in db.scalars(select(ReportTemplate.name))
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "Шаблон с таким названием уже есть")
    template = ReportTemplate(name=payload.name, created_by_id=user.id)
    db.add(template)
    try:
        db.flush()
        db.add_all(
            ReportTemplateRow(
                template_id=template.id, name=row.name, position=index, formula=row.formula
            )
            for index, row in enumerate(rows, start=1)
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Шаблон с таким названием уже есть") from exc
    db.refresh(template)
    return ReportTemplateResponse(
        id=template.id,
        name=template.name,
        row_count=len(rows),
        created_at=template.created_at,
    )


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Удалить шаблон")
def delete_template(
    template_id: Annotated[int, Path(ge=1, le=2147483647)],
    _user: ActiveUser,
    db: DbSession,
) -> None:
    template = db.get(ReportTemplate, template_id)
    if template is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Шаблон не найден")
    db.execute(delete(ReportTemplateRow).where(ReportTemplateRow.template_id == template_id))
    db.delete(template)
    db.commit()

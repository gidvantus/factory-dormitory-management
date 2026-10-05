"""Общий список общежитий для вошедших пользователей; права будут добавлены позже."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.dormitory import Dormitory
from app.models.report import ReportRow
from app.models.report_template import ReportTemplate, ReportTemplateRow
from app.schemas.dormitory import CreateDormitoryRequest, DormitoryResponse
from app.schemas.user import ErrorResponse
from app.security import CurrentUser

router = APIRouter(
    prefix="/dormitories",
    tags=["dormitories"],
    responses={401: {"model": ErrorResponse, "description": "Требуется авторизация"}},
)
DbSession = Annotated[Session, Depends(get_db)]


@router.get("", response_model=list[DormitoryResponse], summary="Список общежитий")
def list_dormitories(_user: CurrentUser, db: DbSession) -> list[DormitoryResponse]:
    dormitories = db.scalars(
        select(Dormitory).order_by(Dormitory.created_at.desc(), Dormitory.id.desc())
    )
    return [DormitoryResponse.model_validate(dormitory) for dormitory in dormitories]


@router.post(
    "",
    response_model=DormitoryResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Создать общежитие",
    responses={400: {"model": ErrorResponse, "description": "Некорректное тело JSON"}},
)
def create_dormitory(
    payload: CreateDormitoryRequest, user: CurrentUser, db: DbSession
) -> DormitoryResponse:
    template_rows: list[ReportTemplateRow] = []
    if payload.template_id is not None:
        if db.get(ReportTemplate, payload.template_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Шаблон не найден")
        template_rows = list(
            db.scalars(
                select(ReportTemplateRow)
                .where(ReportTemplateRow.template_id == payload.template_id)
                .order_by(ReportTemplateRow.position, ReportTemplateRow.id)
            )
        )
    dormitory = Dormitory(created_by_id=user.id, name=payload.name, client_name=payload.client_name)
    db.add(dormitory)
    db.flush()
    db.add_all(
        ReportRow(
            dormitory_id=dormitory.id,
            name=row.name,
            formula=row.formula,
            position=index,
        )
        for index, row in enumerate(template_rows, start=1)
    )
    db.commit()
    db.refresh(dormitory)
    return DormitoryResponse.model_validate(dormitory)


@router.get(
    "/{dormitory_id}",
    response_model=DormitoryResponse,
    summary="Открыть общежитие",
    responses={404: {"model": ErrorResponse, "description": "Общежитие не найдено"}},
)
def read_dormitory(
    dormitory_id: Annotated[int, Path(ge=1, le=2147483647)], _user: CurrentUser, db: DbSession
) -> DormitoryResponse:
    dormitory = db.scalar(select(Dormitory).where(Dormitory.id == dormitory_id))
    if dormitory is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Общежитие не найдено")
    return DormitoryResponse.model_validate(dormitory)

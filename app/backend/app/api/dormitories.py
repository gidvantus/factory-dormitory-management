"""Общежития организации из сессии: список, создание, переименование, архивация.

Принадлежность берётся из сессии, а не из тела запроса: `organization_id` нет ни
в запросе, ни в ответе. Список отдаёт только общежития своей организации, а
чужое общежитие отвечает тем же `404`, что и несуществующее.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, OwnDormitory, SubscribedUser, scoped_dormitories
from app.api.organization import Membership
from app.db import get_db
from app.dormitory_structure import initialize_structure
from app.dormitory_templates import apply_snapshot, own_template
from app.models.dormitory import Dormitory
from app.models.report import ReportRow
from app.models.report_template import ReportTemplateRow
from app.report_defaults import DEFAULT_REPORT_FORMULA, missing_report_metrics
from app.report_templates import own_template as own_report_template
from app.report_templates import restore_report_colors
from app.schemas.dormitory import CreateDormitoryRequest, DormitoryResponse, UpdateDormitoryRequest
from app.schemas.user import ErrorResponse
from app.table_data import restore_link
from app.table_views import TableColors

router = APIRouter(
    prefix="/dormitories",
    tags=["dormitories"],
    responses={
        401: {"model": ErrorResponse, "description": "Требуется авторизация"},
        **SUBSCRIBED_USER_RESPONSES,
    },
)
DbSession = Annotated[Session, Depends(get_db)]


class DormitoryLookup(BaseModel):
    id: int
    name: str
    client_name: str
    is_archived: bool


@router.get("/lookup", response_model=list[DormitoryLookup])
def lookup_dormitories(
    _user: SubscribedUser, membership: Membership, db: DbSession
) -> list[DormitoryLookup]:
    return [
        DormitoryLookup(id=d.id, name=d.name, client_name=d.client_name, is_archived=d.is_archived)
        for d in scoped_dormitories(db, membership.organization_id)
    ]


@router.get("", response_model=list[DormitoryResponse], summary="Список общежитий организации")
def list_dormitories(
    _user: SubscribedUser, membership: Membership, db: DbSession
) -> list[DormitoryResponse]:
    organization = scoped_dormitories(db, membership.organization_id)
    # Порядок витрины задаёт ручка: свежие и большие id сверху.
    ordered = sorted(organization, key=lambda item: (item.created_at, item.id), reverse=True)
    return [DormitoryResponse.model_validate(dormitory) for dormitory in ordered]


@router.post(
    "",
    response_model=DormitoryResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Создать общежитие",
    responses={400: {"model": ErrorResponse, "description": "Некорректное тело JSON"}},
)
def create_dormitory(
    payload: CreateDormitoryRequest,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> DormitoryResponse:
    template_rows: list[ReportTemplateRow] = []
    template_colors: TableColors = {}
    if payload.template_id is not None:
        # Шаблон отчёта берётся из библиотеки своей организации: чужой отвечает
        # тем же 404 «Шаблон не найден», что и несуществующий.
        template = own_report_template(db, payload.template_id, membership.organization_id)
        template_colors = template.colors
        template_rows = list(
            db.scalars(
                select(ReportTemplateRow)
                .where(ReportTemplateRow.template_id == payload.template_id)
                .order_by(ReportTemplateRow.position, ReportTemplateRow.id)
            )
        )
    dormitory = Dormitory(
        created_by_id=user.id,
        organization_id=membership.organization_id,
        name=payload.name,
        client_name=payload.client_name,
    )
    db.add(dormitory)
    db.flush()
    if payload.structure_template_id:
        try:
            # Библиотека шаблонов структуры видна организации автора шаблона.
            structure = own_template(db, payload.structure_template_id, membership.organization_id)
        except HTTPException:
            db.rollback()
            raise
        try:
            apply_snapshot(db, dormitory, structure.snapshot, payload.structure_template_keys)
        except HTTPException:
            db.rollback()
            raise
        db.commit()
        db.refresh(dormitory)
        return DormitoryResponse.model_validate(dormitory)
    if payload.tabs is not None:
        try:
            initialize_structure(
                db,
                dormitory,
                payload.tabs,
                template_rows,
                membership.organization_id,
                template_colors=template_colors,
            )
        except HTTPException:
            db.rollback()
            raise
        db.commit()
        db.refresh(dormitory)
        return DormitoryResponse.model_validate(dormitory)
    next_position = 0
    mapped_columns: dict[int, int] = {}
    mapped_sources: dict[str, int] = {}
    copied_rows: dict[int, ReportRow] = {}
    for row in template_rows:
        next_position += 1
        copied = ReportRow(
            dormitory_id=dormitory.id,
            name=row.name,
            metric_key=row.metric_key,
            formula=(row.formula or DEFAULT_REPORT_FORMULA) if row.metric_key else row.formula,
            position=next_position,
            link=restore_link(db, dormitory.id, row.link_snapshot, mapped_columns, mapped_sources)
            if not row.metric_key
            else None,
        )
        db.add(copied)
        copied_rows[row.position] = copied
    db.add_all(
        ReportRow(
            dormitory_id=dormitory.id,
            name=name,
            metric_key=metric,
            formula=DEFAULT_REPORT_FORMULA,
            position=next_position + index,
        )
        for index, (metric, name) in enumerate(
            missing_report_metrics((row.name, row.metric_key) for row in template_rows), start=1
        )
    )
    restore_report_colors(db, dormitory, template_colors, copied_rows)
    db.commit()
    db.refresh(dormitory)
    return DormitoryResponse.model_validate(dormitory)


@router.patch(
    "/{dormitory_id}",
    response_model=DormitoryResponse,
    summary="Изменить названия или статус архива общежития",
    responses={404: {"model": ErrorResponse, "description": "Общежитие не найдено"}},
)
def update_dormitory(
    dormitory: OwnDormitory,
    payload: UpdateDormitoryRequest,
    _user: SubscribedUser,
    db: DbSession,
) -> DormitoryResponse:
    # Гейт уже проверил принадлежность; блокировка берётся повторно, чтобы
    # изменение шло под ней, а не по прочитанной до неё строке.
    db.refresh(dormitory, with_for_update=True)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(dormitory, field, value)
    db.commit()
    db.refresh(dormitory)
    return DormitoryResponse.model_validate(dormitory)


@router.get(
    "/{dormitory_id}",
    response_model=DormitoryResponse,
    summary="Открыть общежитие",
    responses={404: {"model": ErrorResponse, "description": "Общежитие не найдено"}},
)
def read_dormitory(dormitory: OwnDormitory, _user: SubscribedUser) -> DormitoryResponse:
    return DormitoryResponse.model_validate(dormitory)

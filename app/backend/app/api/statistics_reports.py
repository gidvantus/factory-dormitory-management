"""Сохранение отчётов с проверкой доступа, версий и расчётом по актуальным данным."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, SubscribedUser
from app.dashboard_blocks import source_catalog, validate_config
from app.db import get_db
from app.models.dormitory import Dormitory
from app.models.statistics_report import StatisticsReport
from app.models.user import User
from app.report_readiness import today_moscow
from app.schemas.dashboard_block import CatalogDormitory
from app.schemas.report import ReportResponse
from app.schemas.statistics_report import (
    CreateStatisticsReport,
    StatisticsBlock,
    StatisticsData,
    StatisticsReportResponse,
    StatisticsResult,
    UpdateStatisticsReport,
)
from app.statistics_reports import calculate_block, resolved_query

router = APIRouter(prefix="/statistics", tags=["statistics"], responses=SUBSCRIBED_USER_RESPONSES)
DbSession = Annotated[Session, Depends(get_db)]
ReportId = Annotated[int, Path(ge=1)]


def report_row(db: Session, report_id: int, user: User, *, lock: bool = False) -> StatisticsReport:
    statement = select(StatisticsReport).where(StatisticsReport.id == report_id)
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    report = db.scalar(statement)
    if report is None or (report.visibility == "personal" and report.created_by_id != user.id):
        raise HTTPException(404, "Отчёт не найден")
    return report


def check_revision(report: StatisticsReport, revision: int) -> None:
    if report.revision != revision:
        raise HTTPException(
            409, "Отчёт уже изменён другим пользователем. Обновите отчёт и повторите действие."
        )


def response_for(report: StatisticsReport, user: User, db: Session) -> StatisticsReportResponse:
    author = db.get(User, report.created_by_id) if report.created_by_id else None
    return StatisticsReportResponse(
        id=report.id,
        name=report.name,
        description=report.description,
        visibility=report.visibility,
        blocks=report.blocks,
        revision=report.revision,
        created_by_id=report.created_by_id,
        created_by_name=author.full_name if author else "",
        can_manage=report.created_by_id == user.id,
        created_at=report.created_at,
        updated_at=report.updated_at,
    )


def validate_blocks(
    db: Session, blocks: list[StatisticsBlock], old: list[dict] | None = None
) -> None:
    previous = {item["id"]: item for item in old or []}
    catalog = source_catalog(db) if blocks else []
    for block in blocks:
        # A removed source must not prevent renaming the report or deleting another block.
        if previous.get(block.id, {}).get("query") != block.query.model_dump(mode="json"):
            validate_config(db, block.query)
        if not block.query.all_dormitories:
            ids = set(
                db.scalars(
                    select(Dormitory.id).where(Dormitory.id.in_(block.selected_dormitory_ids))
                )
            )
            if ids != set(block.selected_dormitory_ids) and block.id not in previous:
                raise HTTPException(422, "Выбранное общежитие не найдено")
        # Pin current matches by ID, so later renames do not change saved bindings.
        resolved = resolved_query(block, catalog)
        block.query.sources = [
            source
            for source in resolved.sources
            if source.dormitory_id not in block.query.excluded_dormitory_ids
        ]


def period_end(start: date, end: date) -> date | None:
    if start > end or (end - start).days > 365:
        raise HTTPException(422, "Выберите период не длиннее года")
    today = today_moscow()
    return min(end, today) if start <= today else None


@router.get("/sources", response_model=list[CatalogDormitory])
def read_sources(_user: SubscribedUser, db: DbSession) -> list[CatalogDormitory]:
    catalog = source_catalog(db)
    db.commit()
    return catalog


@router.get("/reports", response_model=list[StatisticsReportResponse])
def list_reports(user: SubscribedUser, db: DbSession) -> list[StatisticsReportResponse]:
    reports = db.scalars(
        select(StatisticsReport)
        .where(
            or_(
                StatisticsReport.visibility == "shared",
                StatisticsReport.created_by_id == user.id,
            )
        )
        .order_by(StatisticsReport.updated_at.desc(), StatisticsReport.id.desc())
    )
    return [response_for(report, user, db) for report in reports]


@router.post("/reports", response_model=StatisticsReportResponse, status_code=201)
def create_report(
    payload: CreateStatisticsReport, user: SubscribedUser, db: DbSession
) -> StatisticsReportResponse:
    validate_blocks(db, payload.blocks)
    report = StatisticsReport(
        name=payload.name,
        description=payload.description,
        visibility=payload.visibility,
        created_by_id=user.id,
        blocks=[block.model_dump(mode="json") for block in payload.blocks],
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return response_for(report, user, db)


@router.get("/reports/{report_id}", response_model=StatisticsReportResponse)
def read_report(
    report_id: ReportId, user: SubscribedUser, db: DbSession
) -> StatisticsReportResponse:
    return response_for(report_row(db, report_id, user), user, db)


@router.put("/reports/{report_id}", response_model=StatisticsReportResponse)
def update_report(
    report_id: ReportId, payload: UpdateStatisticsReport, user: SubscribedUser, db: DbSession
) -> StatisticsReportResponse:
    report = report_row(db, report_id, user, lock=True)
    check_revision(report, payload.revision)
    if report.visibility != payload.visibility and report.created_by_id != user.id:
        raise HTTPException(403, "Изменить доступ может только создатель отчёта")
    validate_blocks(db, payload.blocks, report.blocks)
    report.name, report.description, report.visibility = (
        payload.name,
        payload.description,
        payload.visibility,
    )
    report.blocks = [block.model_dump(mode="json") for block in payload.blocks]
    report.revision += 1
    db.commit()
    db.refresh(report)
    return response_for(report, user, db)


@router.delete("/reports/{report_id}", status_code=204)
def delete_report(
    report_id: ReportId, revision: Annotated[int, Query(ge=0)], user: SubscribedUser, db: DbSession
) -> Response:
    report = report_row(db, report_id, user, lock=True)
    if report.created_by_id != user.id:
        raise HTTPException(403, "Удалить отчёт может только его создатель")
    check_revision(report, revision)
    db.delete(report)
    db.commit()
    return Response(status_code=204)


@router.post("/preview", response_model=StatisticsResult)
def preview_block(
    payload: StatisticsBlock,
    user: SubscribedUser,
    db: DbSession,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
) -> StatisticsResult:
    end = period_end(from_date, to_date)
    if payload.query.source_kind == "arrival_plan":
        end = to_date
    catalog = source_catalog(db)
    dormitories = list(db.scalars(select(Dormitory).order_by(Dormitory.id)))
    result = calculate_block(db, user, payload, dormitories, catalog, from_date, end, {})
    db.commit()
    return result


@router.get("/reports/{report_id}/data", response_model=StatisticsData)
def read_data(
    report_id: ReportId,
    user: SubscribedUser,
    db: DbSession,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
    dormitory_id: Annotated[int | None, Query(ge=1)] = None,
) -> StatisticsData:
    report = report_row(db, report_id, user)
    end = period_end(from_date, to_date)
    catalog = source_catalog(db)
    dormitories = list(db.scalars(select(Dormitory).order_by(Dormitory.id)))
    if dormitory_id is not None:
        if not any(dorm.id == dormitory_id for dorm in dormitories):
            raise HTTPException(404, "Общежитие не найдено")
        dormitories = [dorm for dorm in dormitories if dorm.id == dormitory_id]
    cache: dict[int, ReportResponse] = {}
    results = [
        calculate_block(
            db,
            user,
            StatisticsBlock.model_validate(block),
            dormitories,
            catalog,
            from_date,
            to_date if block["query"]["source_kind"] == "arrival_plan" else end,
            cache,
        )
        for block in report.blocks
    ]
    result = StatisticsData(
        revision=report.revision,
        from_date=from_date,
        to_date=to_date,
        through_date=end,
        results=results,
    )
    db.commit()
    return result

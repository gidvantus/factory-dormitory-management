"""Список проживающих, общий для пользователей общежития."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.reports import require_dormitory
from app.db import get_db
from app.models.hostel import Hostel
from app.models.outflow import PersonnelOutflow
from app.models.payment import PaymentEntry
from app.models.resident import Resident
from app.resident_outflow import prepare_outflow
from app.resident_payments import copy_payment_values, existing_payment
from app.resident_transfer import prepare_transfer
from app.schemas.outflow import OutflowResponse
from app.schemas.payment import PaymentKind, PaymentResponse, ResidentPaymentResponse
from app.schemas.resident import (
    HostelOption,
    ResidentResponse,
    ResidentsResponse,
    UpdateResidentRequest,
)
from app.schemas.resident_outflow import ResidentOutflowPreview, ResidentOutflowRequest
from app.schemas.resident_transfer import (
    TransferPreviewRequest,
    TransferPreviewResponse,
    TransferResidentRequest,
)
from app.security import ACTIVE_USER_RESPONSES, ActiveUser
from app.table_data import lock_dormitory

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/residents",
    tags=["residents"],
    responses={**ACTIVE_USER_RESPONSES},
)
DbSession = Annotated[Session, Depends(get_db)]
DormitoryId = Annotated[int, Path(ge=1, le=2147483647)]
ResidentId = Annotated[int, Path(ge=1, le=2147483647)]


def get_resident(db: Session, dormitory_id: int, resident_id: int) -> Resident:
    resident = db.get(Resident, resident_id)
    if resident is None or resident.dormitory_id != dormitory_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Проживающий не найден")
    return resident


def resident_response(db: Session, resident: Resident) -> ResidentResponse:
    hostel = db.get(Hostel, resident.hostel_id) if resident.hostel_id else None
    return ResidentResponse.model_validate(
        {**resident.__dict__, "hostel_name": hostel.name if hostel else None}
    )


@router.get("", response_model=ResidentsResponse, summary="Проживающие и действующие хостелы")
def list_residents(
    dormitory_id: DormitoryId,
    _user: ActiveUser,
    db: DbSession,
    month: Annotated[date, Query()],
) -> ResidentsResponse:
    require_dormitory(db, dormitory_id)
    if month.day != 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите первый день месяца")
    residents = db.scalars(
        select(Resident).where(Resident.dormitory_id == dormitory_id).order_by(Resident.id)
    ).all()
    hostels = db.scalars(
        select(Hostel)
        .where(
            Hostel.dormitory_id == dormitory_id,
            Hostel.active_from_month <= month,
            or_(Hostel.active_until_month.is_(None), Hostel.active_until_month > month),
        )
        .order_by(Hostel.name, Hostel.id)
    ).all()
    return ResidentsResponse(
        residents=[resident_response(db, resident) for resident in residents],
        hostels=[HostelOption(id=hostel.id, name=hostel.name) for hostel in hostels],
    )


@router.post(
    "",
    response_model=ResidentResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить строку",
)
def create_resident(
    dormitory_id: DormitoryId, _user: ActiveUser, db: DbSession
) -> ResidentResponse:
    require_dormitory(db, dormitory_id)
    resident = Resident(dormitory_id=dormitory_id)
    db.add(resident)
    db.commit()
    db.refresh(resident)
    return resident_response(db, resident)


@router.post(
    "/{resident_id}/payments/{kind}",
    response_model=ResidentPaymentResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Записать проживающего на аванс или расчёт",
)
def register_payment(
    dormitory_id: DormitoryId,
    resident_id: ResidentId,
    kind: PaymentKind,
    response: Response,
    _user: ActiveUser,
    db: DbSession,
) -> ResidentPaymentResponse:
    # Один замок защищает сравнение и вставку от одновременных нажатий,
    # а также от изменения пользовательских столбцов и значений во время копирования.
    lock_dormitory(db, dormitory_id)
    resident = get_resident(db, dormitory_id, resident_id)
    fields, custom, copied, skipped = copy_payment_values(db, dormitory_id, resident, kind)
    existing = existing_payment(db, dormitory_id, resident_id, kind, fields)
    if existing is not None:
        response.status_code = status.HTTP_200_OK
        db.commit()
        return ResidentPaymentResponse(
            payment=PaymentResponse.model_validate(existing),
            created=False,
            copied_columns=[],
            skipped_columns=[],
        )
    if not copied:
        raise HTTPException(422, "Нет заполненных столбцов с совпадающим названием и типом")
    row = PaymentEntry(
        dormitory_id=dormitory_id,
        kind=kind,
        source_resident_id=resident_id,
        custom_values=custom,
        **fields,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return ResidentPaymentResponse(
        payment=PaymentResponse.model_validate(row),
        created=True,
        copied_columns=copied,
        skipped_columns=skipped,
    )


@router.post("/{resident_id}/transfer/preview", response_model=TransferPreviewResponse)
def preview_transfer(
    dormitory_id: DormitoryId,
    resident_id: ResidentId,
    payload: TransferPreviewRequest,
    _user: ActiveUser,
    db: DbSession,
) -> TransferPreviewResponse:
    plan = prepare_transfer(
        db, dormitory_id, resident_id, payload.target_dormitory_id, payload.month
    )
    db.commit()
    return plan.preview


@router.post("/{resident_id}/transfer", response_model=ResidentResponse)
def transfer_resident(
    dormitory_id: DormitoryId,
    resident_id: ResidentId,
    payload: TransferResidentRequest,
    _user: ActiveUser,
    db: DbSession,
) -> ResidentResponse:
    plan = prepare_transfer(
        db, dormitory_id, resident_id, payload.target_dormitory_id, payload.month
    )
    if payload.preview_token != plan.preview.preview_token:
        raise HTTPException(409, "Данные или столбцы изменились. Повторно проверьте перевод")
    if plan.preview.warnings and not payload.confirm_loss:
        raise HTTPException(409, "Подтвердите перевод без перечисленных полей")
    for field in UpdateResidentRequest.model_fields:
        setattr(plan.resident, field, plan.fields.get(field))
    plan.resident.custom_values = plan.custom
    plan.resident.dormitory_id = payload.target_dormitory_id
    db.commit()
    db.refresh(plan.resident)
    return resident_response(db, plan.resident)


@router.post("/{resident_id}/outflow/preview", response_model=ResidentOutflowPreview)
def preview_outflow(
    dormitory_id: DormitoryId,
    resident_id: ResidentId,
    _user: ActiveUser,
    db: DbSession,
) -> ResidentOutflowPreview:
    plan = prepare_outflow(db, dormitory_id, resident_id)
    db.commit()
    return plan.preview


@router.post(
    "/{resident_id}/outflow", response_model=OutflowResponse, status_code=status.HTTP_201_CREATED
)
def move_to_outflow(
    dormitory_id: DormitoryId,
    resident_id: ResidentId,
    payload: ResidentOutflowRequest,
    _user: ActiveUser,
    db: DbSession,
) -> PersonnelOutflow:
    plan = prepare_outflow(db, dormitory_id, resident_id)
    if payload.preview_token != plan.preview.preview_token:
        raise HTTPException(409, "Данные, столбцы или выплаты изменились. Повторно проверьте отток")
    if plan.preview.warnings and not payload.confirm_loss:
        raise HTTPException(409, "Подтвердите перенос в отток без перечисленных полей")
    row = PersonnelOutflow(dormitory_id=dormitory_id, custom_values=plan.custom, **plan.fields)
    db.add(row)
    for payment in plan.payments:
        db.delete(payment)
    db.delete(plan.resident)
    db.commit()
    db.refresh(row)
    return row


@router.patch(
    "/{resident_id}", response_model=ResidentResponse, summary="Сохранить поля проживающего"
)
def update_resident(
    dormitory_id: DormitoryId,
    resident_id: ResidentId,
    payload: UpdateResidentRequest,
    _user: ActiveUser,
    db: DbSession,
    month: Annotated[date, Query()],
) -> ResidentResponse:
    lock_dormitory(db, dormitory_id)
    resident = get_resident(db, dormitory_id, resident_id)
    if month.day != 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите первый день месяца")
    changes = payload.model_dump(exclude_unset=True)
    if "hostel_id" in changes and changes["hostel_id"] is not None:
        hostel = db.get(Hostel, changes["hostel_id"])
        if (
            hostel is None
            or hostel.dormitory_id != dormitory_id
            or hostel.active_from_month > month
            or (hostel.active_until_month is not None and hostel.active_until_month <= month)
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Хостел не действует в этом месяце"
            )
    start = changes.get("shift_start", resident.shift_start)
    end = changes.get("shift_end", resident.shift_end)
    if start is not None and end is not None and end < start:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Конец вахты раньше начала")
    for field, value in changes.items():
        setattr(resident, field, value)
    db.commit()
    db.refresh(resident)
    return resident_response(db, resident)


@router.delete("/{resident_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Удалить строку")
def delete_resident(
    dormitory_id: DormitoryId,
    resident_id: ResidentId,
    _user: ActiveUser,
    db: DbSession,
) -> None:
    lock_dormitory(db, dormitory_id)
    db.delete(get_resident(db, dormitory_id, resident_id))
    db.commit()

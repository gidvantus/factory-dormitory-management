"""Каталог вкладок организации: стандартные разделы и пользовательские вкладки."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, SubscribedUser
from app.api.organization import Membership
from app.db import get_db
from app.tab_catalog import CatalogItem, catalog

router = APIRouter(tags=["tab-catalog"], responses={**SUBSCRIBED_USER_RESPONSES})


@router.get("/dormitory-tab-catalog", response_model=list[CatalogItem])
def list_catalog(
    _user: SubscribedUser,
    membership: Membership,
    db: Annotated[Session, Depends(get_db)],
) -> list[CatalogItem]:
    return catalog(db, membership.organization_id)

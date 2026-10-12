from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, SubscribedUser
from app.db import get_db
from app.tab_catalog import CatalogItem, catalog

router = APIRouter(tags=["tab-catalog"], responses={**SUBSCRIBED_USER_RESPONSES})


@router.get("/dormitory-tab-catalog", response_model=list[CatalogItem])
def list_catalog(
    _user: SubscribedUser, db: Annotated[Session, Depends(get_db)]
) -> list[CatalogItem]:
    return catalog(db)

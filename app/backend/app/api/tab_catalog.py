from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.security import ACTIVE_USER_RESPONSES, ActiveUser
from app.tab_catalog import CatalogItem, catalog

router = APIRouter(tags=["tab-catalog"], responses={**ACTIVE_USER_RESPONSES})


@router.get("/dormitory-tab-catalog", response_model=list[CatalogItem])
def list_catalog(_user: ActiveUser, db: Annotated[Session, Depends(get_db)]) -> list[CatalogItem]:
    return catalog(db)

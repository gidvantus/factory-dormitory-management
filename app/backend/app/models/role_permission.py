"""Общие для платформы права трёх должностей на обмен данными."""

from sqlalchemy import Boolean, CheckConstraint, String, true
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

ACCESS_ROLES = ("manager", "admin", "commandant")


class RolePermission(Base):
    __tablename__ = "role_permissions"
    __table_args__ = (
        CheckConstraint(
            "role IN ('manager', 'admin', 'commandant')", name="ck_role_permissions_role"
        ),
    )

    role: Mapped[str] = mapped_column(String(30), primary_key=True)
    import_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=true()
    )
    export_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=true()
    )

"""Ручные соответствия имеют приоритет при переносе между таблицами."""

from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from app.models.dormitory import Dormitory
from app.models.table_column import TableColumn
from app.schemas.transfer_columns import ColumnOption, TransferColumnChoice
from app.table_data import Record, normalize_value, record_value


def normalized_name(value: str) -> str:
    return " ".join(value.split()).casefold()


def matching_value(source: TableColumn, target: TableColumn, row: Record) -> Any:
    value = record_value(row, source)
    if value is None:
        return None
    if target.kind == "select":
        option = next((item for item in source.options if item["id"] == value), None)
        if option is None or option["archived"]:
            raise HTTPException(422, "Вариант исходного списка недоступен")
        matches = [
            item
            for item in target.options
            if not item["archived"]
            and normalized_name(item["label"]) == normalized_name(option["label"])
        ]
        if len(matches) != 1:
            raise HTTPException(422, "Вариант не найден в списке назначения")
        value = matches[0]["id"]
    return normalize_value(target, value)


class TransferColumns:
    def __init__(
        self,
        db: Session,
        sources: list[TableColumn],
        targets: list[TableColumn],
        excluded: set[int] | None = None,
    ):
        self.sources = sources
        self.targets = targets
        self.excluded = excluded or set()
        self.dormitory = db.get(Dormitory, sources[0].dormitory_id) if sources else None
        self.key = (
            f"{sources[0].table_key}:{targets[0].table_key}:{targets[0].dormitory_id}"
            if sources and targets
            else ""
        )
        self.stored = (
            (self.dormitory.transfer_column_mappings or {}).get(self.key, {})
            if self.dormitory
            else {}
        )
        sources_by_id = {str(col.id): col for col in sources}
        targets_by_id = {col.id: col for col in targets}
        self.explicit = {
            source.id: target
            for key, target_id in self.stored.items()
            if (source := sources_by_id.get(key)) is not None
            and (target := targets_by_id.get(target_id)) is not None
            and self.compatible(source, target)
        }
        self.reserved = {target.id: source_id for source_id, target in self.explicit.items()}

    def compatible(self, source: TableColumn, target: TableColumn) -> bool:
        return (
            not source.archived
            and not target.archived
            and source.kind == target.kind
            and target.kind != "action"
            and not target.fill
            and target.id not in self.excluded
        )

    def matches(self, source: TableColumn) -> list[TableColumn]:
        if assigned := self.explicit.get(source.id):
            return [assigned]
        return [
            col
            for col in self.targets
            if not col.archived
            and col.id not in self.reserved
            and normalized_name(col.name) == normalized_name(source.name)
        ]

    def ambiguous(self, source: TableColumn, matches: list[TableColumn]) -> bool:
        return source.id not in self.explicit and (
            len(matches) != 1
            or sum(
                not col.archived and normalized_name(col.name) == normalized_name(source.name)
                for col in self.sources
            )
            != 1
        )

    def choices(
        self,
        row: Record | None = None,
        *,
        copied: set[int] | None = None,
        occupied: set[int] | None = None,
        schema: type[BaseModel] | None = None,
    ) -> list[TransferColumnChoice]:
        result: list[TransferColumnChoice] = []
        for source in self.sources:
            if source.archived or source.kind == "action" or source.id in (copied or ()):
                continue
            if row is not None and record_value(row, source) in (None, ""):
                continue
            options = []
            for target in self.targets:
                if (
                    not self.compatible(source, target)
                    or target.id in (occupied or ())
                    or self.reserved.get(target.id, source.id) != source.id
                ):
                    continue
                if row is not None and source.kind != "hostel":
                    try:
                        value = matching_value(source, target, row)
                        if schema and target.builtin_key:
                            schema.model_validate({target.builtin_key: value})
                    except (HTTPException, ValidationError):
                        continue
                options.append(ColumnOption(id=target.id, name=target.name))
            saved = self.stored.get(str(source.id))
            if options or (row is None and saved):
                result.append(
                    TransferColumnChoice(
                        source=ColumnOption(id=source.id, name=source.name),
                        targets=options,
                        target_id=saved,
                    )
                )
        return result

    def save(self, changes: dict[int, int | None]) -> None:
        assert self.dormitory is not None and self.key
        sources = {col.id: col for col in self.sources}
        targets = {col.id: col for col in self.targets}
        saved = dict(self.stored)
        for source_id, target_id in changes.items():
            if target_id is None:
                saved.pop(str(source_id), None)
                continue
            source, target = sources.get(source_id), targets.get(target_id)
            if source is None or target is None or not self.compatible(source, target):
                raise HTTPException(422, "Выберите действующие столбцы одного типа")
            saved[str(source_id)] = target_id
        unique: set[int] = set()
        for stored_source_id, target_id in saved.items():
            source, target = sources.get(int(stored_source_id)), targets.get(target_id)
            if source and target and self.compatible(source, target):
                if target_id in unique:
                    raise HTTPException(422, "Столбцу назначения уже соответствует другое поле")
                unique.add(target_id)
        all_routes = dict(self.dormitory.transfer_column_mappings or {})
        if saved:
            all_routes[self.key] = saved
        else:
            all_routes.pop(self.key, None)
        self.dormitory.transfer_column_mappings = all_routes

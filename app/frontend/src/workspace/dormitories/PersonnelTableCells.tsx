import { Children, cloneElement, isValidElement } from 'react';
import type { ReactNode } from 'react';
import type { CellValue } from '../../api/client';
import type { SourceTable } from '../../api/personnel';
import { useEmployeeCard } from '../personnel/useEmployeeCard';
import { ConfiguredCells } from './ConfigurableColumns';
import { useColumns } from './tableColumnsContext';
import { personnelCellFields } from './personnelCellFields';

/** Archive and user tables can hide or omit their bound name column. */
export function PersonnelTableCells({
  row,
  children,
  readOnly = false,
  onLinked,
  extra,
}: {
  row: { id: number; custom_values?: Record<string, CellValue>; employee_id?: string | null };
  children: ReactNode;
  readOnly?: boolean;
  onLinked: (id: string) => void;
  extra?: { id: string; node: ReactNode }[];
}): JSX.Element {
  const { dormitoryId, table, columns, personnelFields, values, waitForRowSaves } = useColumns();
  const card = useEmployeeCard({
    dormitoryId,
    tableKey: table as SourceTable,
    rowId: row.id,
    employeeId: row.employee_id,
    fields: personnelCellFields(row, values, personnelFields),
    beforeOpen: () => waitForRowSaves(row.id),
    onLinked,
  });
  const hasName = columns.some(
    (column) =>
      !column.archived && column.kind === 'text' && column.id === personnelFields?.full_name,
  );
  return (
    <ConfiguredCells
      extra={extra}
      row={row}
      fields={['action_delete']}
      readOnly={readOnly}
      onPersonnelLinked={onLinked}
    >
      {Children.map(children, (child) =>
        isValidElement<{ children?: ReactNode }>(child) && child.type === 'td'
          ? cloneElement(
              child,
              {},
              <>
                {child.props.children}
                {!hasName && card.canOpen && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--compact"
                    disabled={card.busy || readOnly}
                    onClick={() => void card.open()}
                  >
                    Открыть сотрудника
                  </button>
                )}
                {card.error && <small role="alert">{card.error}</small>}
                {card.dialog}
              </>,
            )
          : child,
      )}
    </ConfiguredCells>
  );
}

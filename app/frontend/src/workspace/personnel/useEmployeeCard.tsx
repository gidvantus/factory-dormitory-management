import { useEffect, useState } from 'react';
import { useExchangePermissions } from '../../auth/exchangePermissions';
import { createPortal } from 'react-dom';
import { ApiError, waitForDormitoryWrites } from '../../api/client';
import { personnelApi } from '../../api/personnel';
import type { IdentityFields, SourceTable } from '../../api/personnel';
import { EmployeeProfileDialog } from './EmployeeProfileDialog';
import { IdentityDialog } from './IdentityDialog';

export function useEmployeeCard({
  dormitoryId,
  tableKey,
  rowId,
  employeeId,
  fields,
  beforeOpen,
  onLinked,
}: {
  dormitoryId: string;
  tableKey: SourceTable;
  rowId: number;
  employeeId?: string | null;
  fields?: Partial<IdentityFields>;
  beforeOpen?: () => Promise<unknown>;
  onLinked?: (id: string) => void;
}): {
  open: () => Promise<void>;
  canOpen: boolean;
  busy: boolean;
  error: string;
  dialog: JSX.Element | null;
} {
  const canOpen = useExchangePermissions().personnel_enabled !== false;
  const [panel, setPanel] = useState<'profile' | 'identity' | null>(null);
  const [linkedId, setLinkedId] = useState(employeeId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setLinkedId(employeeId), [employeeId]);
  useEffect(() => {
    if (!canOpen) setPanel(null);
  }, [canOpen]);
  function linked(id: string): void {
    setLinkedId(id);
    onLinked?.(id);
  }
  async function open(): Promise<void> {
    if (busy || !canOpen) return;
    setBusy(true);
    setError('');
    try {
      await beforeOpen?.();
      await waitForDormitoryWrites(dormitoryId);
      let id = linkedId;
      if (!id) {
        // Saving a bound custom cell can create a card without returning its ID.
        const data = await personnelApi.workspace();
        id = data.employees.find((employee) =>
          employee.sources.some(
            (record) =>
              record.dormitory_id === Number(dormitoryId) &&
              record.table_key === tableKey &&
              record.row_id === rowId,
          ),
        )?.id;
        if (id) linked(id);
      }
      setPanel(id ? 'profile' : 'identity');
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Не удалось открыть карточку сотрудника.',
      );
    } finally {
      setBusy(false);
    }
  }
  const dialog =
    panel === 'profile' && linkedId ? (
      <EmployeeProfileDialog
        employeeId={linkedId}
        source={{ dormitoryId: Number(dormitoryId), tableKey, rowId }}
        onClose={() => setPanel(null)}
        onSourceLinked={linked}
      />
    ) : panel === 'identity' ? (
      createPortal(
        <IdentityDialog
          dormitoryId={dormitoryId}
          tableKey={tableKey}
          rowId={rowId}
          initial={fields}
          onClose={() => setPanel(null)}
          onSaved={(id) => {
            linked(id);
            setPanel('profile');
          }}
        />,
        document.body,
      )
    ) : null;
  return { open, canOpen, busy, error, dialog: canOpen ? dialog : null };
}

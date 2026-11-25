import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { ApiError } from '../../api/client';
import { personnelApi } from '../../api/personnel';
import type { EmployeeProfileData, EmployeeProfileTarget, SourceTable } from '../../api/personnel';
import { Modal } from '../../components/Modal';
import { message } from './helpers';
import { PersonnelProfile } from './PersonnelProfile';
import s from './Personnel.module.css';

export function EmployeeProfileDialog({
  employeeId,
  fullName,
  source,
  onClose,
  onSourceLinked,
}: EmployeeProfileTarget & {
  source?: { dormitoryId: number; tableKey: SourceTable; rowId: number };
  onClose: () => void;
  onSourceLinked?: (id: string) => void;
}): JSX.Element {
  const [data, setData] = useState<EmployeeProfileData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const mutating = useRef(false);

  useLayoutEffect(() => {
    const previous = document.body.style.overflow;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const target = employeeId === undefined ? { fullName } : { employeeId };
    void personnelApi
      .profile(target, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(message(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt, employeeId, fullName]);

  async function reload(): Promise<void> {
    if (!data) return;
    const result = await personnelApi.profile({ employeeId: data.employee.id });
    setError('');
    setData(result);
    if (!source || !onSourceLinked) return;
    const linked = result.employee.sources.some(
      (record) =>
        record.dormitory_id === source.dormitoryId &&
        record.table_key === source.tableKey &&
        record.row_id === source.rowId,
    );
    if (linked) onSourceLinked(result.employee.id);
  }

  return createPortal(
    data ? (
      <PersonnelProfile
        key={data.employee.id}
        employee={data.employee}
        data={data}
        loadedDetail={data.detail}
        tab="overview"
        onClose={onClose}
        onReload={() => void reload().catch((caught) => setError(message(caught)))}
        mutate={async (action) => {
          if (mutating.current)
            throw new ApiError(409, 'Дождитесь завершения предыдущего сохранения.');
          mutating.current = true;
          try {
            await action();
            try {
              await reload();
            } catch (caught) {
              setError(`Изменение сохранено. Не удалось обновить карточку: ${message(caught)}`);
            }
          } finally {
            mutating.current = false;
          }
        }}
        refreshError={error}
      />
    ) : (
      <Modal
        title="Карточка сотрудника"
        testId="personnel-profile-loading"
        onClose={onClose}
        panelClassName={s.modal}
      >
        {loading ? (
          <p role="status">Загружаем карточку…</p>
        ) : (
          <>
            <p role="alert">{error || 'Карточка сотрудника не найдена.'}</p>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Повторить загрузку
            </button>
          </>
        )}
      </Modal>
    ),
    document.body,
  );
}

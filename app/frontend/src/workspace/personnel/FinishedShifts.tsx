import { useEffect, useState } from 'react';
import { personnelApi } from '../../api/personnel';
import type { FinishedShiftPage, PersonnelData } from '../../api/personnel';
import { WorkingTable } from '../../components/WorkingTable';
import type { DateRange } from '../dashboard/dates';
import { EmployeeProfileDialog } from './EmployeeProfileDialog';
import { dateLabel, dormName, message } from './helpers';
import { PAGE_SIZE } from './serverList';
import f from './PersonnelFocus.module.css';
import s from './Personnel.module.css';

export function FinishedShifts({
  data,
  dormitory,
  period,
  query,
  revision,
}: {
  data: PersonnelData;
  dormitory: number | null;
  period: DateRange;
  query: string;
  revision: number;
}): JSX.Element {
  const [result, setResult] = useState<FinishedShiftPage | null>(null);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const { from, to } = period;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void personnelApi
      .finishedShifts({ period: { from, to }, dormitory, query, page }, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setResult(response);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(message(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [dormitory, from, to, query, page, revision, attempt]);

  if (!result && loading) return <p role="status">Загружаем выселения…</p>;
  return (
    <>
      {error && (
        <p role="alert" className={s.error}>
          {error}{' '}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Повторить
          </button>
        </p>
      )}
      {result &&
        (result.rows.length ? (
          <>
            <div className={f.tableScroll}>
              <WorkingTable
                className={`${f.employeeTable} ${f.finishedTable}`}
                aria-label="Закончили вахту"
              >
                <thead>
                  <tr>
                    <th scope="col">Сотрудник</th>
                    <th scope="col">Общежитие</th>
                    <th scope="col">Дата выселения</th>
                    <th scope="col">Примечание</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => setEmployeeId(entry.employee_id)}
                        >
                          {entry.full_name || 'ФИО не указано'}
                        </button>
                      </td>
                      <td>{dormName(data, entry.dormitory_id)}</td>
                      <td>
                        <time dateTime={entry.departure_date}>
                          {dateLabel(entry.departure_date, true)}
                        </time>
                      </td>
                      <td className={f.finishedNotes}>{entry.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </WorkingTable>
            </div>
            <div className={s.pagination}>
              <span>
                {(result.page - 1) * PAGE_SIZE + 1}–
                {Math.min(result.total, result.page * PAGE_SIZE)} из {result.total}
              </span>
              <button
                type="button"
                disabled={loading || result.page <= 1}
                onClick={() => setPage(result.page - 1)}
              >
                Назад
              </button>
              <button
                type="button"
                disabled={loading || result.page * PAGE_SIZE >= result.total}
                onClick={() => setPage(result.page + 1)}
              >
                Далее
              </button>
            </div>
          </>
        ) : (
          <p className={s.empty}>За выбранный период выселений по этим условиям нет.</p>
        ))}
      {employeeId && (
        <EmployeeProfileDialog employeeId={employeeId} onClose={() => setEmployeeId(null)} />
      )}
    </>
  );
}

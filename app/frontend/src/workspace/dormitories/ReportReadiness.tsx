import { useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../../api/client';
import type { DailyReportReadiness } from '../../api/client';
import { formatDate } from '../dashboard/dates';
import { usePageRefresh } from '../usePageRefresh';
import styles from './ReportReadiness.module.css';

export function ReportReadiness({ dormitoryId }: { dormitoryId: string }): JSX.Element {
  const [data, setData] = useState<DailyReportReadiness | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const revision = usePageRefresh();
  const version = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(false);
  const reading = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (busy.current) return;
    const controller = new AbortController();
    reading.current = controller;
    const requestVersion = ++version.current;
    void api
      .reportReadiness(dormitoryId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && version.current === requestVersion) {
          setData(result);
          setError('');
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted && version.current === requestVersion) {
          setError(
            caught instanceof ApiError ? caught.message : 'Не удалось загрузить статус отчёта.',
          );
        }
      });
    return () => controller.abort();
  }, [dormitoryId, attempt, revision]);

  async function toggle(checked: boolean): Promise<void> {
    if (!data || busy.current) return;
    busy.current = true;
    version.current += 1;
    reading.current?.abort();
    setSaving(true);
    setError('');
    try {
      const result = await api.setReportReadiness(dormitoryId, data.report_date, checked);
      if (mounted.current) setData(result);
    } catch (caught: unknown) {
      if (mounted.current) {
        setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить отметку.');
        if (caught instanceof ApiError && caught.status === 409) setAttempt((value) => value + 1);
      }
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <div className={styles.readiness} aria-busy={saving}>
      <label className={styles.toggle} data-ready={data?.is_ready ? 'true' : 'false'}>
        <input
          type="checkbox"
          checked={data?.is_ready ?? false}
          disabled={!data || saving}
          onChange={(event) => void toggle(event.target.checked)}
          aria-describedby="report-readiness-date"
        />
        <span>
          {data ? (data.is_ready ? 'Отчёт готов' : 'Отчёт не готов') : 'Загружаем статус отчёта…'}
        </span>
      </label>
      <span className={styles.date} id="report-readiness-date">
        {data && `За сегодня · ${formatDate(data.report_date)}`}
        {saving && <span role="status"> · Сохраняем…</span>}
      </span>
      {error && (
        <div className={styles.error} role="alert">
          {error}
          <button type="button" disabled={saving} onClick={() => setAttempt((value) => value + 1)}>
            Обновить статус
          </button>
        </div>
      )}
    </div>
  );
}

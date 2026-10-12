import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { PlaceMetric, PlaceReportLink, ReportLink } from '../../api/client';
import styles from './ReportTable.module.css';

const metrics: { key: PlaceMetric; name: string }[] = [
  { key: 'residents_m', name: 'Проживает М' },
  { key: 'residents_f', name: 'Проживает Ж' },
  { key: 'residents_total', name: 'Проживает — итого М+Ж' },
  { key: 'free_m', name: 'Свободных мест М' },
  { key: 'free_f', name: 'Свободных мест Ж' },
  { key: 'free_total', name: 'Свободных мест — итого М+Ж' },
  { key: 'paid_m', name: 'Оплачено мест М' },
  { key: 'paid_f', name: 'Оплачено мест Ж' },
  { key: 'paid_total', name: 'Оплачено мест — итого М+Ж' },
];

export function PlaceLinkEditor({
  dormitoryId,
  initial,
  onChange,
}: {
  dormitoryId: string;
  initial: PlaceReportLink | null;
  onChange: (link: ReportLink | null) => void;
}): JSX.Element {
  const [hostels, setHostels] = useState<{ id: number; name: string }[]>([]);
  const [hostel, setHostel] = useState(initial?.hostel_id ? String(initial.hostel_id) : 'all');
  const [metric, setMetric] = useState<PlaceMetric | ''>(initial?.metric ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api
      .reportHostels(dormitoryId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setHostels(result);
          setLoading(false);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить хостелы.');
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [dormitoryId, attempt]);
  const hostelExists = hostel === 'all' || hostels.some((item) => String(item.id) === hostel);
  useEffect(() => {
    onChange(
      !loading && !error && hostelExists && metric
        ? {
            table_key: 'places',
            hostel_id: hostel === 'all' ? null : Number(hostel),
            metric,
          }
        : null,
    );
  }, [loading, error, hostelExists, hostel, metric, onChange]);
  if (loading) return <p role="status">Загружаем хостелы…</p>;
  if (error)
    return (
      <p role="alert" className={styles.formError}>
        {error}{' '}
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          Повторить загрузку хостелов
        </button>
      </p>
    );
  return (
    <>
      <label className={styles.field}>
        Хостел
        <select
          value={hostel}
          onChange={(event) => {
            setHostel(event.target.value);
          }}
        >
          <option value="all">Все хостелы — сумма</option>
          {hostels.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {!hostelExists && (
        <p role="alert" className={styles.formError}>
          Хостел из связи не найден. Выберите другой хостел.
        </p>
      )}
      <label className={styles.field}>
        Показатель
        <select
          value={metric}
          onChange={(event) => {
            const next = event.target.value as PlaceMetric | '';
            setMetric(next);
          }}
        >
          <option value="">Выберите показатель</option>
          {metrics.map((item) => (
            <option key={item.key} value={item.key}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <p className={styles.formulaHelp}>
        В отчёт попадёт значение показателя за каждую дату. Свободные места: оплачено минус
        проживает. Хостелы учитываются только в месяцы их действия; пустые даты дают 0.
      </p>
      {metric && (
        <p className={styles.linkSummary}>
          Брать из «Мест»: {metrics.find((item) => item.key === metric)?.name}.{' '}
          {hostel === 'all'
            ? 'Сумма по всем хостелам.'
            : hostels.find((item) => String(item.id) === hostel)?.name}{' '}
          По дате показателя.
        </p>
      )}
    </>
  );
}

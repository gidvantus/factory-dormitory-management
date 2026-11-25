import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { Dormitory, TransferColumnChoice, TransferColumnRoute } from '../../api/client';
import { EditorSection } from '../../components/EditorSection';
import { TransferColumnFields } from './TransferColumnFields';
import styles from './TransferResidentDialog.module.css';

const routes = [
  { source: 'residents', target: 'outflow', label: 'Проживающие → Отток' },
  { source: 'residents', target: 'advance', label: 'Проживающие → На аванс' },
  { source: 'residents', target: 'settlement', label: 'Проживающие → На расчёт' },
  { source: 'inflow', target: 'residents', label: 'Приток → Проживающие' },
  { source: 'inflow', target: 'outflow', label: 'Приток → Отток' },
  { source: 'residents', target: 'residents', label: 'Перевод в другое общежитие' },
] as const;

export function TransferColumnSettings({
  dormitoryId,
  disabled,
  onBusy,
}: {
  dormitoryId: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
}): JSX.Element {
  const [direction, setDirection] = useState('');
  const [destination, setDestination] = useState('');
  const [dormitories, setDormitories] = useState<Dormitory[]>([]);
  const [choices, setChoices] = useState<TransferColumnChoice[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const current = direction ? routes[Number(direction)] : undefined;
  const source = current?.source;
  const target = current?.target;
  const crossDormitory = target === 'residents' && source === 'residents';
  const targetDormitoryId = crossDormitory && destination ? Number(destination) : undefined;
  const ready = !!source && !!target && (!crossDormitory || !!targetDormitoryId);
  const route: TransferColumnRoute | null = ready ? { source, target, targetDormitoryId } : null;

  useEffect(() => {
    if (!crossDormitory) return;
    const controller = new AbortController();
    void api
      .dormitories(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setDormitories(
            items.filter((item) => String(item.id) !== dormitoryId && !item.is_archived),
          );
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Не удалось загрузить общежития.');
      });
    return () => controller.abort();
  }, [crossDormitory, dormitoryId]);

  useEffect(() => {
    if (!source || !target || !ready) return;
    const controller = new AbortController();
    setChoices(null);
    setError('');
    void api
      .transferColumns(dormitoryId, { source, target, targetDormitoryId }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setChoices(result);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            caught instanceof ApiError ? caught.message : 'Не удалось загрузить соответствия.',
          );
        }
      });
    return () => controller.abort();
  }, [dormitoryId, ready, source, target, targetDormitoryId, attempt]);

  return (
    <EditorSection title="Сопоставление столбцов при переносе">
      <div className={styles.summary}>
        <label className={styles.field}>
          Направление переноса
          <select
            value={direction}
            disabled={disabled || saving}
            onChange={(event) => {
              setDirection(event.target.value);
              setDestination('');
              setChoices(null);
              setNotice('');
              setError('');
            }}
          >
            <option value="">Выберите направление</option>
            {routes.map(({ label }, index) => (
              <option key={label} value={index}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {crossDormitory && (
          <label className={styles.field}>
            Общежитие назначения
            <select
              value={destination}
              disabled={disabled || saving}
              onChange={(event) => {
                setDestination(event.target.value);
                setChoices(null);
                setNotice('');
                setError('');
              }}
            >
              <option value="">Выберите общежитие</option>
              {dormitories.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
        {route && !choices && !error && <p role="status">Загружаем столбцы…</p>}
        {route && choices?.length === 0 && <p>Доступных пар столбцов нет.</p>}
        {route && !!choices?.length && (
          <TransferColumnFields
            key={`${direction}:${destination}:${attempt}`}
            dormitoryId={dormitoryId}
            route={route}
            choices={choices}
            settings
            disabled={disabled}
            onBusy={(busy) => {
              setSaving(busy);
              onBusy(busy);
            }}
            onSaved={() => {
              setNotice('Соответствия сохранены.');
              setAttempt((value) => value + 1);
            }}
          />
        )}
      </div>
    </EditorSection>
  );
}

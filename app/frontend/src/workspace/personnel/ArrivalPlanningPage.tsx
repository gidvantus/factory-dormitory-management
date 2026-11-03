import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { personnelApi } from '../../api/personnel';
import type { ArrivalPlanningData } from '../../api/personnel';
import { ApiError } from '../../api/client';
import { useSession } from '../../auth/SessionProvider';
import { usePageRefresh } from '../usePageRefresh';
import { ArrivalPlanningBoard } from './ArrivalPlanningBoard';
import { addDays, message } from './helpers';
import type { Mutate } from './Forms';
import s from './Personnel.module.css';
import w from './PersonnelWorkspace.module.css';
import f from './PersonnelFocus.module.css';

export function ArrivalPlanningPage(): JSX.Element {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const rawId = Number(params.get('dormitory'));
  const dormitory = Number.isSafeInteger(rawId) && rawId > 0 ? rawId : null;
  const sourcePlanId = params.get('arrival');
  const [data, setData] = useState<ArrivalPlanningData | null>(null);
  const requestedDate = params.get('date') ?? '';
  const validDate =
    /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) &&
    !Number.isNaN(Date.parse(`${requestedDate}T00:00:00Z`)) &&
    new Date(`${requestedDate}T00:00:00Z`).toISOString().slice(0, 10) === requestedDate;
  const [start, setStart] = useState<string | undefined>(validDate ? requestedDate : undefined);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mutating = useRef(false);
  const reloadingSaved = useRef(false);
  const refresh = usePageRefresh();
  useEffect(() => {
    if (user?.is_active === false) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void personnelApi
      .arrivals(
        start ? { from: start, to: addDays(start, 6) } : undefined,
        dormitory,
        controller.signal,
      )
      .then(async (result) => {
        if (sourcePlanId && !result.arrival_plans.some((plan) => plan.id === sourcePlanId)) {
          const source = await personnelApi.arrival(sourcePlanId, controller.signal);
          result = { ...result, arrival_plans: [...result.arrival_plans, source] };
          if (!result.dormitories.some((dorm) => dorm.id === source.dormitory_id))
            result.dormitories = [
              ...result.dormitories,
              {
                id: source.dormitory_id,
                name: source.dormitory_name ?? 'Общежитие',
                client_name: '',
                is_archived: source.is_archived ?? false,
              },
            ];
        }
        if (!controller.signal.aborted) {
          setData(result);
          reloadingSaved.current = false;
          setLoading(false);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(
            `${reloadingSaved.current ? 'Изменение сохранено. Не удалось обновить план: ' : ''}${message(caught)}`,
          );
          reloadingSaved.current = false;
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [start, dormitory, refresh, attempt, user?.is_active, sourcePlanId]);
  const onPeriodChange = useCallback(
    (next: string) => {
      // Первый ответ уже содержит неделю «сегодня»: повторный запрос не нужен.
      setStart((current) => (current === undefined && next === data?.from ? current : next));
    },
    [data?.from],
  );
  const mutate: Mutate = async (action) => {
    if (mutating.current) throw new ApiError(409, 'Дождитесь завершения предыдущего сохранения.');
    mutating.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      reloadingSaved.current = true;
      setAttempt((value) => value + 1);
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  };
  if (user?.is_active === false)
    return (
      <section className={s.page}>
        <h1>Персонал</h1>
        <p>Активируйте кабинет, чтобы работать с сотрудниками.</p>
      </section>
    );
  return (
    <section className={`${s.page} ${w.surface} ${f.surface}`} aria-busy={busy}>
      <div className={`${s.heading} ${w.heading}`}>
        <div>
          <span className={s.eyebrow}>ЛЮДИ И ИХ ИСТОРИЯ</span>
          <h1>Персонал</h1>
          <p>Планирование заездов по общежитиям.</p>
        </div>
      </div>
      <div className={`${s.tabs} ${w.tabs}`} role="tablist" aria-label="Раздел персонала">
        {(
          [
            ['workspace', 'Рабочая поверхность'],
            ['list', 'Сотрудники'],
            ['planning', 'План заездов'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={id === 'planning'}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set('view', id);
              setParams(next);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={s.toolbar}>
        <label>
          Общежитие{' '}
          <select
            aria-label="Общежитие на странице"
            value={dormitory ?? 'all'}
            disabled={!data || busy}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.target.value === 'all') next.delete('dormitory');
              else next.set('dormitory', event.target.value);
              setParams(next);
            }}
          >
            <option value="all">Все общежития</option>
            {data?.dormitories
              .filter((item) => !item.is_archived)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      {error && (
        <p role="alert">
          {error} <button onClick={() => setAttempt((value) => value + 1)}>Повторить</button>
        </p>
      )}
      {!data && loading && <p role="status">Загружаем план заездов…</p>}
      {data && (
        <ArrivalPlanningBoard
          data={data}
          dormitory={dormitory}
          mutate={mutate}
          onPeriodChange={onPeriodChange}
          loading={loading || !!error}
          initialDate={start ?? data.today}
          initialPlanId={params.get('arrival') ?? undefined}
        />
      )}
    </section>
  );
}

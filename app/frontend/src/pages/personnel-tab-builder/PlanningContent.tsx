import { useState } from 'react';
import type { PersonnelData } from '../../api/personnel';
import { ArrivalCard } from '../../workspace/personnel/arrivals/ArrivalFields';
import { ArrivalDialog } from '../../workspace/personnel/arrivals/ArrivalDialog';
import { SettingsDialog } from '../../workspace/personnel/arrivals/SettingsDialog';
import type { ArrivalDraft } from '../../workspace/personnel/arrivals/adapter';
import type { Arrival } from '../../workspace/personnel/arrivals/data';
import {
  initialSettings,
  newArrival,
  peopleAtCount,
  personCount,
  reconfigureArrival,
} from '../../workspace/personnel/arrivals/data';
import { addDays, dateLabel } from '../../workspace/personnel/helpers';
import { Sandbox } from '../constructor-sandbox/store';
import s from './Tabs.module.css';

/** Исходный конструктор заездов с локальными обработчиками; API не вызывается. */
export function PlanningContent({
  data,
  onPlansChange,
}: {
  data: PersonnelData;
  onPlansChange?: (plans: PersonnelData['arrival_plans']) => void;
}): JSX.Element {
  const [date, setDate] = useState(data.today);
  const [settings, setSettings] = useState(initialSettings);
  const [arrivals, setArrivals] = useState<Arrival[]>(() =>
    data.arrival_plans.map((plan, index) => {
      const sample =
        index === 0
          ? new Sandbox().arrivalSample
          : newArrival(
              data.dormitories.find((dorm) => dorm.id === plan.dormitory_id)?.name ?? '',
              plan.date,
            );
      return {
        ...sample,
        id: plan.id,
        date: plan.date,
        count: String(plan.count),
        dorm: data.dormitories.find((dorm) => dorm.id === plan.dormitory_id)?.name ?? sample.dorm,
        people: peopleAtCount(sample.people, plan.count),
      };
    }),
  );
  function publish(next: Arrival[]): void {
    setArrivals(next);
    onPlansChange?.(
      next.map((arrival) => ({
        id: arrival.id,
        dormitory_id:
          data.dormitories.find((dorm) => dorm.name === arrival.dorm)?.id ?? data.dormitories[0].id,
        date: arrival.date,
        count: personCount(arrival.count),
        names: arrival.people.map((person) => person.name),
        revision: 1,
      })),
    );
  }
  const [draft, setDraft] = useState<ArrivalDraft | null>(null);
  const [configuring, setConfiguring] = useState(false);
  function edit(arrival?: Arrival): void {
    const value = structuredClone(arrival ?? newArrival(data.dormitories[0].name, date));
    setDraft({
      ...value,
      dormitory_id:
        data.dormitories.find((dorm) => dorm.name === value.dorm)?.id ?? data.dormitories[0].id,
      revision: 0,
      settings_revision: 0,
    });
  }
  return (
    <>
      <div className={s.toolbar}>
        <div className={s.buttons}>
          <button
            className="btn btn--ghost btn--compact"
            aria-label="Предыдущий день"
            onClick={() => setDate(addDays(date, -1))}
          >
            ←
          </button>
          <strong>{dateLabel(date, true)}</strong>
          <button
            className="btn btn--ghost btn--compact"
            aria-label="Следующий день"
            onClick={() => setDate(addDays(date, 1))}
          >
            →
          </button>
          <button className="btn btn--quiet btn--compact" onClick={() => setDate(data.today)}>
            Сегодня
          </button>
        </div>
        <div className={s.buttons}>
          <button className="btn btn--ghost btn--compact" onClick={() => setConfiguring(true)}>
            Настроить вид
          </button>
          <button className="btn btn--primary btn--compact" onClick={() => edit()}>
            + Добавить заезд
          </button>
        </div>
      </div>
      <div className={s.arrivals}>
        {arrivals
          .filter((arrival) => arrival.date === date)
          .map((arrival) => (
            <article key={arrival.id}>
              <ArrivalCard arrival={arrival} settings={settings} />
              <button className="btn btn--ghost btn--compact" onClick={() => edit(arrival)}>
                Изменить заезд
              </button>
            </article>
          ))}
      </div>
      {!arrivals.some((arrival) => arrival.date === date) && (
        <div className={s.empty}>
          <strong>На этот день заезды не запланированы</strong>
          <p>Добавьте запись для нужного общежития.</p>
        </div>
      )}
      {draft && !configuring && (
        <ArrivalDialog
          draft={draft}
          settings={settings}
          dormitories={data.dormitories}
          busy={false}
          error=""
          onClose={() => setDraft(null)}
          onSettings={() => setConfiguring(true)}
          onChange={(patch) =>
            setDraft((current) =>
              current
                ? {
                    ...current,
                    ...patch,
                    ...(patch.count !== undefined
                      ? {
                          people: peopleAtCount(
                            current.people,
                            Math.max(current.people.length, personCount(patch.count)),
                          ),
                        }
                      : {}),
                    ...(patch.dormitory_id !== undefined
                      ? {
                          dorm:
                            data.dormitories.find((dorm) => dorm.id === patch.dormitory_id)?.name ??
                            current.dorm,
                        }
                      : {}),
                  }
                : null,
            )
          }
          onSave={async () => {
            const value = {
              ...draft,
              id: draft.id || crypto.randomUUID(),
              people: draft.people.slice(0, personCount(draft.count)),
            };
            publish(
              draft.id
                ? arrivals.map((item) => (item.id === value.id ? value : item))
                : [...arrivals, value],
            );
            setDraft(null);
          }}
          onDelete={async () => {
            publish(arrivals.filter((item) => item.id !== draft.id));
            setDraft(null);
          }}
        />
      )}
      {configuring && (
        <SettingsDialog
          settings={settings}
          initialTab="fields"
          sample={draft ?? arrivals[0] ?? newArrival(data.dormitories[0].name, date)}
          onClose={() => setConfiguring(false)}
          onSave={(next) => {
            setArrivals((current) =>
              current.map((arrival) => reconfigureArrival(arrival, settings, next)),
            );
            if (draft) setDraft({ ...draft, ...reconfigureArrival(draft, settings, next) });
            setSettings(next);
            setConfiguring(false);
          }}
        />
      )}
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useUnsavedChanges } from '../../../components/useUnsavedChanges';
import { personnelApi } from '../../../api/personnel';
import type {
  ArrivalConfiguration,
  ArrivalPlan,
  PersonnelData,
  ArrivalWorkflowResult,
} from '../../../api/personnel';
import { ApiError } from '../../../api/client';
import type { Mutate } from '../Forms';
import { addDays, dateLabel, message } from '../helpers';
import { PersonnelBlockIcon as Icon } from '../PersonnelBlockIcon';
import { ArrivalCard } from './ArrivalFields';
import { ArrivalDialog } from './ArrivalDialog';
import { ArrivalDetailsDialog } from './ArrivalDetailsDialog';
import { SettingsDialog } from './SettingsDialog';
import type { ArrivalDraft } from './adapter';
import { defaultConfiguration, draftOf, inputOf, viewOf } from './adapter';
import type { Settings, Person } from './data';
import { ArrivalMoveDialog } from './WorkflowDialogs';
import type { WorkflowAction } from './WorkflowPeople';
import q from './Workflow.module.css';
import { isEmpty, newArrival, peopleAtCount, personCount } from './data';
import s from '../Personnel.module.css';
import p from '../ArrivalPlanningBoard.module.css';
import f from '../PersonnelFocus.module.css';
import a from './Arrivals.module.css';

type SettingsEditor = { tab: 'fields' | 'display'; configuration: ArrivalConfiguration };

export function ArrivalPlanningBoard({
  data,
  dormitory,
  mutate,
  onPeriodChange,
  loading = false,
  initialDate,
  initialPlanId,
}: {
  data: Pick<PersonnelData, 'today' | 'dormitories' | 'arrival_plans' | 'arrival_settings'>;
  dormitory: number | null;
  mutate: Mutate;
  onPeriodChange?: (start: string) => void;
  loading?: boolean;
  initialDate?: string;
  initialPlanId?: string;
}): JSX.Element {
  const [start, setStart] = useState(initialDate ?? data.today);
  const [selectedDate, setSelectedDate] = useState(initialDate ?? data.today);
  const [plans, setPlans] = useState(data.arrival_plans);
  const [configuration, setConfiguration] = useState(
    data.arrival_settings ?? defaultConfiguration(),
  );
  const [draft, setDraft] = useState<ArrivalDraft | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(initialPlanId ?? null);
  const [workflowDialog, setWorkflowDialog] = useState<{
    plan: ArrivalPlan;
    person: Person;
  } | null>(null);
  const [notice, setNotice] = useState('');
  const workflowPending = useRef(false);
  const [settingsEditor, setSettingsEditor] = useState<SettingsEditor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const baseline = useRef('');
  const confirmDiscard = useUnsavedChanges(
    !!draft && JSON.stringify({ ...draft, settings_revision: 0 }) !== baseline.current,
  );
  useEffect(() => onPeriodChange?.(start), [onPeriodChange, start]);
  useEffect(() => setPlans(data.arrival_plans), [data.arrival_plans]);
  useEffect(() => {
    if (data.arrival_settings) setConfiguration(data.arrival_settings);
  }, [data.arrival_settings]);
  const dormitories = data.dormitories.filter(
    (item) => !item.is_archived && (dormitory == null || item.id === dormitory),
  );
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  const allowed = new Set(dormitories.map((item) => item.id));
  const visiblePlans = plans.filter(
    (plan) => allowed.has(plan.dormitory_id) && plan.date >= start && plan.date <= days[6],
  );
  const activeDay = days.includes(selectedDate) ? selectedDate : start;
  const dayPlans = visiblePlans.filter((plan) => plan.date === activeDay);
  const expected = (plan: ArrivalPlan): number =>
    plan.count -
    Object.values(plan.workflow ?? {}).filter((visit) => visit.status !== 'expected').length;
  const total = visiblePlans.reduce((sum, plan) => sum + expected(plan), 0);
  const dayTotal = dayPlans.reduce((sum, plan) => sum + expected(plan), 0);
  const dayVisits = dayPlans.flatMap((plan) => Object.values(plan.workflow ?? {}));
  const details = plans.find((plan) => plan.id === detailsId);
  const modalOpen = !!draft || !!details || !!settingsEditor || !!workflowDialog;
  useEffect(() => {
    if (!modalOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [modalOpen]);

  function dormName(id: number): string {
    return data.dormitories.find((item) => item.id === id)?.name ?? 'Общежитие';
  }
  async function runWorkflow(
    action: () => Promise<ArrivalWorkflowResult>,
  ): Promise<ArrivalWorkflowResult> {
    if (workflowPending.current)
      throw new ApiError(409, 'Дождитесь завершения предыдущего действия.');
    workflowPending.current = true;
    setBusy(true);
    setError('');
    try {
      let result: ArrivalWorkflowResult | undefined;
      await mutate(async () => {
        result = await action();
        const saved = result;
        setPlans((previous) => [
          ...previous.filter(
            (plan) =>
              !saved.deleted_plan_ids.includes(plan.id) &&
              !saved.plans.some((item) => item.id === plan.id),
          ),
          ...saved.plans,
        ]);
      });
      return result!;
    } finally {
      workflowPending.current = false;
      setBusy(false);
    }
  }
  function personAction(plan: ArrivalPlan, action: WorkflowAction, personId: string): void {
    if (busy || loading) return;
    setError('');
    const person = viewOf(plan, dormName(plan.dormitory_id)).people.find(
      (item) => item.id === personId,
    );
    if (!person) return;
    if (action === 'details') {
      setDetailsId(plan.id);
      return;
    }
    if (action === 'move') {
      setDetailsId(null);
      setWorkflowDialog({ plan, person });
      return;
    }
    const request =
      action === 'expected' || action === 'arrived' || action === 'no_show'
        ? () => personnelApi.markArrival(plan.id, personId, action, plan.revision)
        : null;
    if (request)
      void runWorkflow(request)
        .then(() =>
          setNotice(
            `${person.name}: ${action === 'arrived' ? 'прибытие отмечено.' : action === 'no_show' ? 'не приехал.' : 'снова ожидается.'}`,
          ),
        )
        .catch((caught) => setError(message(caught)));
  }
  function open(location: number, plan?: ArrivalPlan): void {
    const dorm = dormitories.find((item) => item.id === location);
    if (!dorm) return;
    setError('');
    const next = draftOf(plan, dorm, activeDay, configuration.revision);
    baseline.current = JSON.stringify({ ...next, settings_revision: 0 });
    setDraft(next);
  }
  function change(values: Partial<ArrivalDraft>): void {
    setError('');
    setDraft((previous) => {
      if (!previous) return previous;
      const count = values.count === undefined ? 0 : personCount(values.count);
      return {
        ...previous,
        ...values,
        ...(count > previous.people.length
          ? { people: peopleAtCount(previous.people, count) }
          : {}),
      };
    });
  }
  async function save(): Promise<void> {
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    try {
      const values = inputOf(draft, configuration);
      await mutate(async () => {
        const saved = draft.id
          ? await personnelApi.updateArrival(draft.id, { ...values, revision: draft.revision })
          : await personnelApi.createArrival(values);
        setPlans((previous) => [...previous.filter((plan) => plan.id !== saved.id), saved]);
      });
      setSelectedDate(draft.date);
      if (!days.includes(draft.date)) setStart(draft.date);
      setDraft(null);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }
  async function remove(): Promise<void> {
    if (!draft?.id || busy) return;
    setBusy(true);
    setError('');
    try {
      await mutate(async () => {
        await personnelApi.deleteArrival(draft.id, draft.revision);
        setPlans((previous) => previous.filter((plan) => plan.id !== draft.id));
      });
      setDetailsId(null);
      setDraft(null);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }
  function settings(tab: 'fields' | 'display'): void {
    setSettingsEditor({ tab, configuration: structuredClone(configuration) });
  }
  async function saveSettings(next: Settings): Promise<void> {
    if (!settingsEditor) return;
    await mutate(async () => {
      const saved = await personnelApi.saveArrivalSettings({
        fields: next.fields,
        display: next.display,
        revision: settingsEditor.configuration.revision,
      });
      setConfiguration(saved);
      setDraft((previous) =>
        previous ? { ...previous, settings_revision: saved.revision } : previous,
      );
    });
    setSettingsEditor(null);
  }
  const draftUsed = draft
    ? [draft.values, ...draft.people.map((person) => person.values)].flatMap((values) =>
        Object.keys(values).filter((id) => !isEmpty(values[id])),
      )
    : [];

  return (
    <section
      className={`${f.planning} ${a.production}`}
      data-testid="personnel-planning"
      aria-busy={loading}
    >
      {loading && <p role="status">Обновляем план заездов…</p>}
      {notice && (
        <p role="status" className={q.notice}>
          {notice}
        </p>
      )}
      {error && !draft && !details && <p role="alert">{error}</p>}
      <fieldset
        disabled={loading || busy}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <div className={s.toolbar}>
          <div>
            <h2>План заездов</h2>
            <p className={s.hint}>Количество, ФИО и дополнительные сведения о приезжающих.</p>
          </div>
          <div className={s.actions}>
            <button className="btn btn--ghost btn--compact" onClick={() => settings('fields')}>
              <Icon name="settings" />
              Настроить вид
            </button>
            <button
              className="btn btn--primary btn--compact"
              disabled={!dormitories.length}
              onClick={() => {
                const dorm =
                  dormitories.find(
                    (item) => !dayPlans.some((plan) => plan.dormitory_id === item.id),
                  ) ?? dormitories[0];
                open(dorm.id);
              }}
            >
              Добавить заезд
            </button>
          </div>
        </div>
        <div className={s.toolbar}>
          <div className={s.actions}>
            <button aria-label="Предыдущие 7 дней" onClick={() => setStart(addDays(start, -7))}>
              ←
            </button>
            <label className={p.period}>
              С даты
              <input
                aria-label="Начало периода плана"
                type="date"
                value={start}
                onChange={(event) => {
                  if (event.target.value) setStart(event.target.value);
                }}
              />
            </label>
            <span>по {dateLabel(days[6], true)}</span>
            <button aria-label="Следующие 7 дней" onClick={() => setStart(addDays(start, 7))}>
              →
            </button>
            <button
              onClick={() => {
                setStart(data.today);
                setSelectedDate(data.today);
              }}
            >
              Сегодня
            </button>
          </div>
          <strong>Ожидается за период: {total} чел.</strong>
        </div>
        {dormitories.length ? (
          <div className={`${f.focusLayout} ${a.arrivalLayout}`}>
            <div className={f.days} role="group" aria-label="Даты заездов">
              {days.map((day) => {
                const items = visiblePlans.filter((plan) => plan.date === day);
                const count = items.reduce((sum, plan) => sum + expected(plan), 0);
                const date = new Date(`${day}T00:00:00Z`);
                return (
                  <button
                    type="button"
                    key={day}
                    className={f.dayChoice}
                    aria-label={`Выбрать дату: ${day}`}
                    aria-pressed={activeDay === day}
                    onClick={() => setSelectedDate(day)}
                  >
                    <span className={f.dateTile}>
                      <b>{Number(day.slice(-2))}</b>
                      <small>
                        {new Intl.DateTimeFormat('ru-RU', {
                          month: 'short',
                          timeZone: 'UTC',
                        }).format(date)}
                      </small>
                    </span>
                    <span>
                      <strong>
                        {new Intl.DateTimeFormat('ru-RU', {
                          weekday: 'long',
                          timeZone: 'UTC',
                        }).format(date)}
                        {day === data.today ? ' · сегодня' : ''}
                      </strong>
                      <small>
                        {items.length
                          ? items.map((plan) => dormName(plan.dormitory_id)).join(' · ')
                          : 'Заезды не запланированы'}
                      </small>
                    </span>
                    <b>{count ? `${count} чел.` : '—'}</b>
                  </button>
                );
              })}
            </div>
            <aside className={f.dayDetail} aria-label="Заезды на выбранную дату">
              <div className={a.panelHeading}>
                <div>
                  <span className={s.hint}>Выбранный день</span>
                  <h3>{dateLabel(activeDay, true)}</h3>
                </div>
              </div>
              {configuration.display.summary && (
                <dl className={q.metrics}>
                  <div>
                    <dt>В плане</dt>
                    <dd>{dayPlans.reduce((sum, plan) => sum + plan.count, 0)}</dd>
                  </div>
                  <div>
                    <dt>Ожидаются</dt>
                    <dd>{dayTotal}</dd>
                  </div>
                  <div>
                    <dt>Прибыли</dt>
                    <dd>
                      {
                        dayVisits.filter(
                          (visit) => visit.status === 'arrived' || visit.status === 'settled',
                        ).length
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>Не приехали</dt>
                    <dd>{dayVisits.filter((visit) => visit.status === 'no_show').length}</dd>
                  </div>
                </dl>
              )}
              {dormitories.map((dorm) => {
                const plan = dayPlans.find((item) => item.dormitory_id === dorm.id);
                return plan && plan.count > 0 ? (
                  <ArrivalCard
                    key={dorm.id}
                    arrival={viewOf(plan, dorm.name)}
                    settings={configuration}
                    onOpen={() => setDetailsId(plan.id)}
                    editLabel={`Изменить заезд: ${dorm.name}, ${activeDay}`}
                    onEdit={() => open(dorm.id, plan)}
                    workflow={plan.workflow}
                    busy={busy || loading}
                    onPersonAction={(action, personId) => personAction(plan, action, personId)}
                  />
                ) : (
                  <article className={f.emptyArrival} key={dorm.id}>
                    <h4>{dorm.name}</h4>
                    <p>Заезд не запланирован</p>
                    <button
                      aria-label={`Добавить заезд: ${dorm.name}, ${activeDay}`}
                      onClick={() => open(dorm.id, plan)}
                    >
                      + Добавить заезд
                    </button>
                  </article>
                );
              })}
            </aside>
          </div>
        ) : (
          <p className={s.empty}>Нет действующих общежитий для планирования заездов.</p>
        )}
        <p className={s.hint}>
          Нажмите на блок заезда, чтобы увидеть все заполненные поля. Количество приезжающих
          доступно в «Общем отчёте» как источник «План заездов».
        </p>
      </fieldset>
      {draft && !settingsEditor && (
        <ArrivalDialog
          draft={draft}
          settings={configuration}
          dormitories={dormitories}
          busy={busy}
          error={error}
          onChange={change}
          onClose={() => {
            if (confirmDiscard()) setDraft(null);
          }}
          onSettings={() => settings('fields')}
          onSave={save}
          onDelete={remove}
        />
      )}
      {details && !draft && !settingsEditor && (
        <ArrivalDetailsDialog
          arrival={viewOf(details, dormName(details.dormitory_id))}
          fields={[...configuration.fields, ...configuration.archived_fields]}
          onClose={() => setDetailsId(null)}
          onEdit={() => open(details.dormitory_id, details)}
          workflow={details.workflow}
          readOnly={
            details.is_archived ||
            data.dormitories.find((dorm) => dorm.id === details.dormitory_id)?.is_archived
          }
          busy={busy || loading}
          error={error}
          onPersonAction={(action, personId) => personAction(details, action, personId)}
        />
      )}
      {workflowDialog && (
        <ArrivalMoveDialog
          plan={workflowDialog.plan}
          person={workflowDialog.person}
          dorm={dormName(workflowDialog.plan.dormitory_id)}
          onClose={() => setWorkflowDialog(null)}
          onSave={async (date) => {
            await runWorkflow(() =>
              personnelApi.moveArrival(
                workflowDialog.plan.id,
                workflowDialog.person.id,
                date,
                workflowDialog.plan.revision,
              ),
            );
            setWorkflowDialog(null);
            setNotice('');
          }}
        />
      )}
      {settingsEditor && (
        <SettingsDialog
          settings={settingsEditor.configuration}
          initialTab={settingsEditor.tab}
          sample={
            draft ??
            (dayPlans[0]
              ? viewOf(dayPlans[0], dormName(dayPlans[0].dormitory_id))
              : newArrival(dormitories[0]?.name ?? 'Общежитие', activeDay))
          }
          preview={false}
          usedFields={[...settingsEditor.configuration.used_fields, ...draftUsed]}
          onClose={() => setSettingsEditor(null)}
          onSave={saveSettings}
        />
      )}
    </section>
  );
}

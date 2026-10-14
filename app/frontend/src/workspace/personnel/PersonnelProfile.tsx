import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { personnelApi } from '../../api/personnel';
import type { Employee, EmployeeDetail, PersonnelData, Source } from '../../api/personnel';
import { Modal } from '../../components/Modal';
import { DecisionForm, EmployeeEditForm, NoteForm } from './Forms';
import type { Mutate } from './Forms';
import { dateLabel, dormName, message, personName, sourceUrl, value } from './helpers';
import { IdentityDialog } from './IdentityDialog';
import s from './Personnel.module.css';

export type ProfileTab = 'overview' | 'history' | 'shifts' | 'notes';
export function SourceCard({
  source,
  data,
  onRelink,
}: {
  source: Source;
  data: PersonnelData;
  onRelink?: (source: Source) => void;
}): JSX.Element {
  return (
    <article className={s.source}>
      <strong>
        {dormName(data, source.dormitory_id)} · {source.source_name}
      </strong>
      <p>
        {value(source, 'full_name') || 'ФИО не указано'} · Т/н{' '}
        {value(source, 'personnel_number') || '—'}
      </p>
      {value(source, 'phone') && <p>{value(source, 'phone')}</p>}
      {source.table_key === 'residents' && (
        <p>
          {value(source, 'hostel_name') || 'Место не указано'} ·{' '}
          {dateLabel(value(source, 'shift_start'))} — {dateLabel(value(source, 'shift_end'))}
        </p>
      )}
      {source.table_key === 'outflow' && (
        <p>
          {dateLabel(value(source, 'departure_date'), true)} ·{' '}
          {value(source, 'reason') || 'Причина не указана'}
        </p>
      )}
      {source.table_key === 'inflow' && (
        <p>Заселение: {dateLabel(value(source, 'settlement_date'), true)}</p>
      )}
      <Link to={sourceUrl(source)}>Открыть исходную таблицу →</Link>
      {onRelink && <button onClick={() => onRelink(source)}>Изменить связь</button>}
    </article>
  );
}
const labels: Record<string, string> = {
  full_name: 'ФИО',
  personnel_number: 'Табельный номер',
  phone: 'Телефон',
  shift_start: 'Начало вахты',
  shift_end: 'Окончание вахты',
  departure_date: 'Дата выезда',
  settlement_date: 'Дата заселения',
  reason: 'Причина / статус',
  notes: 'Примечание',
  additional_info: 'Дополнительные сведения',
  hostel_name: 'Место проживания',
  text: 'Текст',
  comment: 'Комментарий',
};
export function PersonnelProfile({
  employee,
  data,
  tab: initialTab,
  onClose,
  mutate,
  onReload,
  refreshError,
}: {
  employee: Employee;
  data: PersonnelData;
  tab: ProfileTab;
  onClose: () => void;
  mutate: Mutate;
  onReload: () => void;
  refreshError?: string;
}): JSX.Element {
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  const [detail, setDetail] = useState<EmployeeDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void personnelApi
      .detail(employee.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setDetail(result);
          setLoading(false);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(message(caught));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [employee.id, data, attempt]);
  const [residentId, setResidentId] = useState(employee.current[0]?.row_id ?? 0);
  const [relink, setRelink] = useState<Source | null>(null);
  const resident =
    employee.current.find((source) => source.row_id === residentId) ?? employee.current[0];
  const shifts = new Map<string, EmployeeDetail['events'][number]>();
  for (const event of [...(detail?.events ?? [])].sort((a, b) => a.id - b.id)) {
    if (event.snapshot.shift_start && (event.snapshot.shift_end || event.snapshot.departure_date))
      shifts.set(`${event.source_table}:${event.source_id}:${event.dormitory_id}`, event);
  }
  if (relink)
    return (
      <IdentityDialog
        dormitoryId={String(relink.dormitory_id)}
        tableKey={relink.table_key}
        rowId={relink.row_id}
        selectedEmployeeId={employee.id}
        initial={{
          full_name: value(relink, 'full_name') || null,
          personnel_number: value(relink, 'personnel_number') || null,
          phone: value(relink, 'phone') || null,
        }}
        onClose={() => setRelink(null)}
        onSaved={() => {
          setRelink(null);
          onReload();
        }}
      />
    );
  return (
    <Modal
      title="Карточка сотрудника"
      testId="personnel-profile"
      initialFocus="panel"
      onClose={onClose}
      panelClassName={`${s.modal} ${s.drawer}`}
      containerClassName={s.drawerContainer}
    >
      <div className={s.profileHero}>
        <div>
          <span className={s.badge}>
            {employee.current.length ? 'Проживает' : 'Сейчас не проживает'}
          </span>
          {employee.identity_status === 'pending' && (
            <span className={s.badge}>Личность требует проверки</span>
          )}
          <h3>{personName(employee)}</h3>
          <p>
            Т/н {employee.personnel_number ?? '—'} · {employee.phone ?? 'Телефон не указан'}
          </p>
        </div>
      </div>
      {employee.current.length > 1 && (
        <p className={s.notice}>
          У карточки несколько записей проживания. Проверьте, не относятся ли они к разным людям или
          повторному вводу.
        </p>
      )}
      <div className={s.tabs} role="tablist" aria-label="Карточка сотрудника">
        {(
          [
            ['overview', 'Обзор'],
            ['history', 'История'],
            ['shifts', 'Вахты'],
            ['notes', 'Заметки'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
            {id === 'history' && detail && <b>{detail.events.length}</b>}
          </button>
        ))}
      </div>
      {refreshError && (
        <p role="alert" className={s.error}>
          {refreshError}
          <button onClick={onReload}>Повторить загрузку карточки</button>
        </p>
      )}
      {error && (
        <p role="alert" className={s.error}>
          {error}
          <button onClick={() => setAttempt((n) => n + 1)}>Повторить загрузку истории</button>
        </p>
      )}
      <div className={s.profileBody} role="tabpanel" aria-label={tab}>
        {tab === 'overview' && (
          <>
            <section className={s.softCard}>
              <div className={s.cardHead}>
                <h4>Основные данные</h4>
                <button onClick={() => setEditing((value) => !value)}>
                  {editing ? 'Закрыть редактирование' : 'Уточнить данные'}
                </button>
              </div>
              {editing ? (
                <EmployeeEditForm
                  employee={employee}
                  mutate={mutate}
                  onDone={() => setEditing(false)}
                />
              ) : (
                <>
                  <dl className={s.facts}>
                    <div>
                      <dt>ФИО</dt>
                      <dd>{personName(employee)}</dd>
                    </div>
                    <div>
                      <dt>Табельный номер</dt>
                      <dd>{employee.personnel_number ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Телефон</dt>
                      <dd>{employee.phone ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Проверка личности</dt>
                      <dd>
                        {employee.identity_status === 'confirmed'
                          ? 'Данные проверены'
                          : 'Требует проверки'}
                      </dd>
                    </div>
                  </dl>
                  {Object.entries(employee.variants).some(([, values]) => values.length > 1) && (
                    <details>
                      <summary>Другие варианты данных из источников</summary>
                      {Object.entries(employee.variants).map(([field, values]) => (
                        <p key={field}>
                          <strong>{labels[field]}:</strong> {values.join(' · ')}
                        </p>
                      ))}
                    </details>
                  )}
                </>
              )}
            </section>
            {resident ? (
              <>
                <section>
                  <h4>Текущее проживание</h4>
                  {employee.current.map((source) => (
                    <SourceCard
                      key={source.row_id}
                      source={source}
                      data={data}
                      onRelink={setRelink}
                    />
                  ))}
                </section>
                {employee.current.length > 1 && (
                  <label>
                    Проживание для решения
                    <select
                      value={resident.row_id}
                      onChange={(event) => setResidentId(Number(event.target.value))}
                    >
                      {employee.current.map((source) => (
                        <option key={source.row_id} value={source.row_id}>
                          {dormName(data, source.dormitory_id)} · строка {source.row_id}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <DecisionForm
                  key={`${resident.row_id}-${data.decisions.find((d) => d.resident_id === resident.row_id)?.status ?? 'waiting'}`}
                  employee={employee}
                  source={resident}
                  data={data}
                  mutate={mutate}
                />
              </>
            ) : (
              <p className={s.notice}>
                Активного проживания нет. Следующий приезд можно подготовить во вкладке «Следующая
                вахта».
              </p>
            )}
            <section>
              <h4>Связанные записи · {employee.sources.length}</h4>
              {employee.sources
                .filter((source) => source.table_key !== 'residents')
                .map((source) => (
                  <SourceCard
                    key={`${source.table_key}-${source.row_id}`}
                    source={source}
                    data={data}
                    onRelink={setRelink}
                  />
                ))}
              {!employee.sources.length && (
                <p className={s.hint}>
                  Исходные строки удалены. Сохранённая история доступна во вкладке «История».
                </p>
              )}
            </section>
          </>
        )}
        {tab === 'history' && (
          <>
            {loading && <p role="status">Загружаем историю…</p>}
            <div className={s.timeline}>
              {detail?.events.map((event) => (
                <article key={event.id}>
                  <time>{dateLabel(event.date, true)}</time>
                  <strong>{event.title}</strong>
                  <small>
                    {String(
                      event.snapshot.dormitory_name ??
                        (event.dormitory_id ? dormName(data, event.dormitory_id) : ''),
                    )}{' '}
                    · {event.actor}
                  </small>
                  {event.snapshot.reason != null && (
                    <p>Статус / причина: {String(event.snapshot.reason)}</p>
                  )}
                  {event.snapshot.text != null && <p>{String(event.snapshot.text)}</p>}
                  {event.snapshot.comment != null && <p>{String(event.snapshot.comment)}</p>}
                  {Object.keys(event.snapshot).some((key) => labels[key]) && (
                    <details>
                      <summary>Сведения на момент события</summary>
                      {Object.entries(event.snapshot)
                        .filter(
                          ([key, raw]) => labels[key] && raw != null && typeof raw !== 'object',
                        )
                        .map(([key, raw]) => (
                          <p key={key}>
                            <strong style={{ display: 'inline' }}>{labels[key]}:</strong>{' '}
                            {String(raw)}
                          </p>
                        ))}
                    </details>
                  )}
                </article>
              ))}
            </div>
            {!loading && !detail?.events.length && <p className={s.empty}>Событий пока нет.</p>}
            {detail?.merges.length ? (
              <section className={s.softCard}>
                <h4>Связывание карточек</h4>
                {detail.merges.map((merge) => (
                  <article className={s.source} key={merge.id}>
                    <p>
                      {dateLabel(merge.created_at, true)} · {merge.actor}
                    </p>
                    <p>{merge.reason}</p>
                    {merge.undone_at ? (
                      <small>Объединение отменено {dateLabel(merge.undone_at, true)}</small>
                    ) : (
                      <button
                        onClick={() =>
                          void mutate(() => personnelApi.undoMerge(merge.id)).catch(() => {})
                        }
                      >
                        Отменить объединение
                      </button>
                    )}
                  </article>
                ))}
                <p className={s.hint}>
                  При отмене исходные записи и заметки вернутся к своим карточкам. Новые записи,
                  добавленные к основной карточке после объединения, останутся у неё.
                </p>
              </section>
            ) : null}
          </>
        )}
        {tab === 'shifts' && (
          <>
            <h4>Периоды проживания и вахт</h4>
            {[...shifts.values()]
              .sort((a, b) =>
                String(b.snapshot.shift_start).localeCompare(String(a.snapshot.shift_start)),
              )
              .map((event) => (
                <article className={s.source} key={event.id}>
                  <strong>
                    {dateLabel(String(event.snapshot.shift_start), true)} —{' '}
                    {dateLabel(
                      String(event.snapshot.departure_date ?? event.snapshot.shift_end),
                      true,
                    )}
                  </strong>
                  <p>
                    {String(event.snapshot.dormitory_name ?? 'Общежитие удалено')} ·{' '}
                    {event.source_table === 'outflow'
                      ? 'Оформлен отток'
                      : 'Период из исходной записи'}
                  </p>
                  {event.snapshot.reason != null && <p>{String(event.snapshot.reason)}</p>}
                </article>
              ))}
            {!loading && !shifts.size && (
              <p className={s.empty}>В источниках пока нет заполненных периодов вахт.</p>
            )}
          </>
        )}
        {tab === 'notes' && (
          <>
            <section className={s.softCard}>
              <h4>Заметки и договорённости</h4>
              <NoteForm employeeId={employee.id} mutate={mutate} />
              <div className={s.notes}>
                {detail?.notes.map((note) => (
                  <article key={note.id}>
                    <strong>{note.author}</strong>
                    <small> · {dateLabel(note.created_at, true)}</small>
                    <p>{note.text}</p>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}

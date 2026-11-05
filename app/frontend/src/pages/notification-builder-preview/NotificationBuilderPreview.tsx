import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Modal } from '../../components/Modal';
import {
  DEMO_MONDAY,
  DEMO_TODAY,
  FREQUENCIES,
  OPERATORS,
  SOURCES,
  WEEKDAYS,
  dateLabel,
  groupLines,
  makeBlock,
  makeDraft,
  nextDispatches,
  previewGroups,
  scheduleLabel,
  sourceFor,
  uid,
} from './model';
import type { Block, Condition, Field, NotificationDraft, Schedule, Source } from './model';
import styles from './NotificationBuilderPreview.module.css';

const STORAGE_KEY = 'domovoy:notification-builder-preview:v1';
const STEPS = ['Данные', 'Условия', 'Расписание', 'Сообщение'];
function countLabel(count: number, forms: [string, string, string]): string {
  const last = count % 10;
  const tens = count % 100;
  return `${count} ${forms[tens >= 11 && tens <= 14 ? 2 : last === 1 ? 0 : last >= 2 && last <= 4 ? 1 : 2]}`;
}
type IconName =
  | 'bell'
  | 'plus'
  | 'table'
  | 'clock'
  | 'check'
  | 'arrow'
  | 'trash'
  | 'filter'
  | 'send'
  | 'user'
  | 'calendar'
  | 'search'
  | 'bookmark';
function Icon({ name }: { name: IconName }): JSX.Element {
  const paths: Record<IconName, ReactNode> = {
    bell: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    table: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M3 10h18M9 10v10" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v6M14 10v6" />
      </>
    ),
    filter: (
      <>
        <path d="M4 5h16l-6 7v7l-4 2v-9Z" />
      </>
    ),
    send: (
      <>
        <path d="m21 3-7 18-4-7-7-4 18-7ZM10 14l11-11" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M7 3v4M17 3v4M3 11h18M7 15h2M13 15h2" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 6 6" />
      </>
    ),
    bookmark: <path d="M6 3h12v18l-6-4-6 4V3Z" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function readDrafts(): NotificationDraft[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (
      Array.isArray(stored) &&
      stored.length > 0 &&
      stored.every(
        (item: NotificationDraft) =>
          item?.id &&
          typeof item.name === 'string' &&
          Array.isArray(item.blocks) &&
          Array.isArray(item.schedule?.times) &&
          Array.isArray(item.schedule?.weekdays),
      )
    )
      return stored as NotificationDraft[];
  } catch {
    /* Закрытое хранилище не мешает просмотру. */
  }
  const morning = makeDraft();
  const shifts = makeDraft('Завершение вахты');
  shifts.enabled = false;
  shifts.blocks = [makeBlock('residents')];
  shifts.blocks[0].period = 'all';
  shifts.blocks[0].conditions = [{ id: uid(), field: 'date', operator: 'next_days', value: '7' }];
  shifts.schedule.frequency = 'weekly';
  shifts.schedule.weekdays = [0];
  const repairs = makeDraft('Новые заявки на ремонт');
  repairs.blocks = [makeBlock('custom')];
  repairs.schedule.frequency = 'event';
  repairs.intro = 'Заявки, которые требуют внимания';
  return [morning, shifts, repairs];
}

const compact = 'btn btn--ghost btn--compact';

export function NotificationBuilderPreview(): JSX.Element {
  const [drafts, setDrafts] = useState(readDrafts);
  const [draft, setDraft] = useState<NotificationDraft>(() => structuredClone(drafts[0]));
  const [step, setStep] = useState(0);
  const [picker, setPicker] = useState<string | 'new' | null>(null);
  const [monday, setMonday] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [testOpen, setTestOpen] = useState(false);
  const [mobileList, setMobileList] = useState(false);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(drafts.find((item) => item.id === draft.id));
  const dispatches = nextDispatches(draft.schedule);
  const previewDay = monday ? DEMO_MONDAY : DEMO_TODAY;
  const groups = draft.blocks.map((block) => ({
    block,
    groups: previewGroups(block, previewDay, draft.schedule.weekends),
  }));
  const matched = groups.reduce(
    (total, item) => total + item.groups.reduce((count, group) => count + group.rows.length, 0),
    0,
  );

  useEffect(() => {
    const old = document.title;
    document.title = 'Конструктор уведомлений — Домовой';
    return () => {
      document.title = old;
    };
  }, []);

  function patch(values: Partial<NotificationDraft>): void {
    setDraft((current) => ({ ...current, ...values }));
    setNotice('');
    setError('');
  }
  function goToStep(next: number): void {
    setStep(next);
    window.scrollTo({ top: 0 });
  }
  function patchBlock(id: string, values: Partial<Block>): void {
    setDraft((current) => ({
      ...current,
      blocks: current.blocks.map((block) => (block.id === id ? { ...block, ...values } : block)),
    }));
    setNotice('');
    setError('');
  }
  function patchSchedule(values: Partial<Schedule>): void {
    setDraft((current) => ({ ...current, schedule: { ...current.schedule, ...values } }));
    setNotice('');
    setError('');
  }
  function selectDraft(item: NotificationDraft): void {
    if (
      dirty &&
      !window.confirm('В этом макете есть несохранённые изменения. Перейти к другому уведомлению?')
    )
      return;
    setDraft(structuredClone(item));
    setNotice('');
    setError('');
    setMobileList(false);
  }
  function createDraft(): void {
    if (dirty && !window.confirm('Начать новый макет без сохранения текущих изменений?')) return;
    const next = makeDraft('Новое уведомление');
    next.blocks = [];
    setDraft(next);
    setStep(0);
    setNotice('');
    setError('');
    setMobileList(false);
  }
  function saveDraft(): void {
    if (!draft.name.trim()) {
      setError('Укажите название уведомления.');
      return;
    }
    if (
      !draft.blocks.length ||
      draft.blocks.some((block) => block.format === 'rows' && !block.fields.length)
    ) {
      setStep(0);
      setError('Добавьте блок данных и выберите поля для сообщения.');
      return;
    }
    if (
      draft.blocks.some((block) =>
        block.conditions.some(
          (condition) =>
            !['filled', 'empty', 'today'].includes(condition.operator) && !condition.value.trim(),
        ),
      )
    ) {
      setStep(1);
      setError('Заполните значения всех условий.');
      return;
    }
    if (draft.schedule.frequency === 'weekly' && !draft.schedule.weekdays.length) {
      setStep(2);
      setError('Выберите хотя бы один день недели.');
      return;
    }
    if (
      draft.schedule.times.some((time) => !time) ||
      (draft.schedule.frequency === 'once' && !draft.schedule.onceDate)
    ) {
      setStep(2);
      setError('Укажите дату и время отправки.');
      return;
    }
    const next = drafts.some((item) => item.id === draft.id)
      ? drafts.map((item) => (item.id === draft.id ? structuredClone(draft) : item))
      : [...drafts, structuredClone(draft)];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setDrafts(next);
      setNotice('Макет сохранён в этом браузере.');
      setError('');
    } catch {
      setError('Браузер запретил сохранение. Макет можно продолжить настраивать на странице.');
    }
  }
  function selectSource(source: Source): void {
    const block = makeBlock(source.id);
    if (picker === 'new') patch({ blocks: [...draft.blocks, block] });
    else if (picker) patchBlock(picker, { ...block, id: picker });
    setPicker(null);
  }

  const message = (
    <div className={styles.message} data-testid="notification-message">
      <div className={styles.botName}>Домовой</div>
      <h3>{draft.name || 'Название уведомления'}</h3>
      <p className={styles.messageDate}>{dateLabel(previewDay)} 2026</p>
      {draft.intro && <p>{draft.intro}</p>}
      {groups.map(({ block, groups: sections }) => {
        const count = sections.reduce((total, group) => total + group.rows.length, 0);
        if (!count && draft.empty === 'skip') return null;
        return (
          <section className={styles.messageBlock} key={block.id}>
            <h4>{block.title || sourceFor(block.sourceId).name}</h4>
            {count === 0 ? (
              <p className={styles.muted}>Подходящих данных нет</p>
            ) : (
              sections
                .filter((group) => group.rows.length)
                .map((group) => (
                  <div key={group.label || 'main'} className={styles.messageGroup}>
                    {group.label && (
                      <span className={group.weekend ? styles.weekendLabel : styles.dayLabel}>
                        {group.label}
                      </span>
                    )}
                    {groupLines(block, group).map((line, index) => (
                      <p key={index}>{line}</p>
                    ))}
                  </div>
                ))
            )}
          </section>
        );
      })}
      {matched === 0 && (
        <p className={styles.emptyMessage}>
          {draft.empty === 'skip'
            ? 'Подходящих данных нет — отправку пропустим.'
            : 'За выбранный период подходящих данных нет.'}
        </p>
      )}
      <span className={styles.messageTime}>
        {draft.schedule.times[0]} <Icon name="check" />
      </span>
    </div>
  );

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <Link className={styles.brand} to="/" aria-label="Домовой, главная">
          <span className={styles.brandMark}>
            <Icon name="bell" />
          </span>
          Домовой<span className={styles.brandDot}>.</span>
        </Link>
        <div className={styles.breadcrumb}>
          Уведомления <span>/</span> <strong>Конструктор</strong>
        </div>
        <span className={styles.demoBadge}>Тестовая страница</span>
        <span className={styles.user}>
          <Icon name="user" /> Личные настройки
        </span>
      </header>

      <div className={styles.layout}>
        <aside
          className={`${styles.sidebar} ${mobileList ? styles.sidebarOpen : ''}`}
          aria-label="Мои уведомления"
        >
          <div className={styles.sidebarTitle}>
            <Icon name="bell" />
            <h2>Мои уведомления</h2>
            <span>{drafts.length}</span>
          </div>
          <button
            type="button"
            className={`btn btn--primary btn--compact ${styles.newButton}`}
            onClick={createDraft}
          >
            <Icon name="plus" /> Создать уведомление
          </button>
          <nav className={styles.draftList}>
            {drafts.map((item) => (
              <button
                type="button"
                className={`btn btn--quiet ${styles.draftButton}`}
                key={item.id}
                aria-pressed={item.id === draft.id}
                onClick={() => selectDraft(item)}
              >
                <span className={styles.draftButtonTitle}>{item.name}</span>
                <span>
                  <i className={item.enabled ? styles.statusOn : styles.statusOff} />
                  {item.enabled ? 'Включено в макете' : 'На паузе'}
                </span>
                <small>{FREQUENCIES[item.schedule.frequency]}</small>
              </button>
            ))}
          </nav>
          <div className={styles.personalNote}>
            <Icon name="user" />
            <strong>Только для вас</strong>
            <p>Ваши уведомления, данные и расписание. Коллеги настраивают свои отдельно.</p>
          </div>
          <div className={styles.sidebarFoot}>
            <Icon name="bookmark" />
            <p>
              Демонстрационные таблицы.
              <br />
              Настройки сохраняются в браузере.
            </p>
          </div>
        </aside>

        <main className={styles.main}>
          <div className={styles.pageHeading}>
            <div>
              <button
                type="button"
                className={`${compact} ${styles.mobileListToggle}`}
                onClick={() => setMobileList(!mobileList)}
              >
                Мои уведомления
              </button>
              <h1>Конструктор уведомлений</h1>
              <p>Соберите нужные данные и выберите, когда их получать.</p>
            </div>
            <span className={styles.personalBadge}>
              <Icon name="user" /> Личное уведомление
            </span>
          </div>
          <div className={styles.draftHeading}>
            <label className={styles.nameField}>
              <span>Название уведомления</span>
              <input
                aria-label="Название уведомления"
                value={draft.name}
                maxLength={120}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </label>
            <label className={styles.enabledSwitch}>
              <input
                type="checkbox"
                role="switch"
                checked={draft.enabled}
                onChange={(event) => patch({ enabled: event.target.checked })}
              />
              <span>{draft.enabled ? 'Включено' : 'На паузе'}</span>
            </label>
          </div>
          <div className={styles.workbench}>
            <div className={styles.editor}>
              <nav className={styles.steps} aria-label="Шаги конструктора">
                {STEPS.map((label, index) => (
                  <button
                    type="button"
                    key={label}
                    className={`btn btn--quiet ${styles.step}`}
                    aria-current={step === index ? 'step' : undefined}
                    onClick={() => goToStep(index)}
                  >
                    <span>{index + 1}</span>
                    {label}
                  </button>
                ))}
              </nav>
              <div className={styles.stepContent}>
                {step === 0 && (
                  <>
                    <StepHeading
                      title="Что включить в уведомление"
                      text="Каждая таблица — отдельный блок в одном сообщении. Выбирайте любые доступные вам данные компании."
                    />
                    {draft.blocks.map((block, index) => (
                      <DataBlock
                        key={block.id}
                        block={block}
                        index={index}
                        count={draft.blocks.length}
                        onChange={(values) => patchBlock(block.id, values)}
                        onSource={() => setPicker(block.id)}
                        onRemove={() =>
                          patch({ blocks: draft.blocks.filter((item) => item.id !== block.id) })
                        }
                        onMove={(direction) => {
                          const blocks = [...draft.blocks];
                          const other = index + direction;
                          [blocks[index], blocks[other]] = [blocks[other], blocks[index]];
                          patch({ blocks });
                        }}
                      />
                    ))}
                    <button
                      type="button"
                      className={`btn btn--ghost ${styles.addBlock}`}
                      onClick={() => setPicker('new')}
                    >
                      <Icon name="plus" />
                      <span>
                        Добавить блок данных<small>Из другой таблицы или другого общежития</small>
                      </span>
                    </button>
                    {!draft.blocks.length && (
                      <p className={styles.muted}>
                        Начните с выбора таблицы. Затем отметьте поля, которые хотите получать.
                      </p>
                    )}
                  </>
                )}

                {step === 1 && (
                  <>
                    <StepHeading
                      title="Какие данные отбирать"
                      text="Настройте условия отдельно для каждого блока. Без условий в сообщение попадут все данные выбранного периода."
                    />
                    {draft.blocks.map((block) => (
                      <ConditionEditor
                        key={block.id}
                        block={block}
                        onChange={(values) => patchBlock(block.id, values)}
                      />
                    ))}
                    {!draft.blocks.length && (
                      <p className={styles.emptyState}>
                        Сначала добавьте таблицу на шаге «Данные».
                      </p>
                    )}
                    <div className={styles.ruleNote}>
                      <Icon name="filter" />
                      <p>
                        Условия проверяются при каждой отправке. Можно сравнивать значения, искать
                        текст и выбирать даты относительно дня отправки.
                      </p>
                    </div>
                  </>
                )}

                {step === 2 && (
                  <>
                    <StepHeading
                      title="Когда присылать"
                      text="Выберите периодичность, время и правила отправки в выходные."
                    />
                    <div className={styles.frequencyGrid}>
                      {(Object.entries(FREQUENCIES) as [Schedule['frequency'], string][]).map(
                        ([key, label]) => (
                          <button
                            type="button"
                            key={key}
                            className={`btn btn--choice ${styles.frequency}`}
                            aria-pressed={draft.schedule.frequency === key}
                            onClick={() => patchSchedule({ frequency: key })}
                          >
                            <Icon
                              name={
                                key === 'event' ? 'bell' : key === 'interval' ? 'clock' : 'calendar'
                              }
                            />
                            {label}
                            {draft.schedule.frequency === key && <Icon name="check" />}
                          </button>
                        ),
                      )}
                    </div>
                    {draft.schedule.frequency === 'weekly' && (
                      <fieldset className={styles.fieldset}>
                        <legend>Дни недели</legend>
                        <div className={styles.weekdays}>
                          {WEEKDAYS.map((day, index) => (
                            <button
                              type="button"
                              key={day}
                              className={`btn btn--choice ${styles.weekday}`}
                              disabled={!draft.schedule.weekends && index > 4}
                              aria-pressed={
                                draft.schedule.weekdays.includes(index) &&
                                (draft.schedule.weekends || index < 5)
                              }
                              onClick={() =>
                                patchSchedule({
                                  weekdays: draft.schedule.weekdays.includes(index)
                                    ? draft.schedule.weekdays.filter((value) => value !== index)
                                    : [...draft.schedule.weekdays, index].sort(),
                                })
                              }
                            >
                              {day}
                            </button>
                          ))}
                        </div>
                      </fieldset>
                    )}
                    {draft.schedule.frequency === 'monthly' && (
                      <label className={styles.field}>
                        <span>Число месяца</span>
                        <input
                          type="number"
                          min="1"
                          max="31"
                          value={draft.schedule.monthDay}
                          onChange={(event) =>
                            patchSchedule({
                              monthDay: Math.max(1, Math.min(31, Number(event.target.value))),
                            })
                          }
                        />
                        <small>Если такого числа нет, отправим в последний день месяца.</small>
                      </label>
                    )}
                    {draft.schedule.frequency === 'once' && (
                      <label className={styles.field}>
                        <span>Дата отправки</span>
                        <input
                          type="date"
                          required
                          value={draft.schedule.onceDate}
                          onChange={(event) => patchSchedule({ onceDate: event.target.value })}
                        />
                      </label>
                    )}
                    {draft.schedule.frequency === 'interval' && (
                      <label className={styles.field}>
                        <span>Интервал в часах</span>
                        <select
                          value={draft.schedule.interval}
                          onChange={(event) =>
                            patchSchedule({ interval: Number(event.target.value) })
                          }
                        >
                          {[1, 2, 3, 4, 6, 8, 12, 24].map((hour) => (
                            <option key={hour} value={hour}>
                              {hour} ч
                            </option>
                          ))}
                        </select>
                        <small>От первого выбранного времени до конца каждого дня.</small>
                      </label>
                    )}
                    {draft.schedule.frequency !== 'event' && (
                      <div className={styles.twoColumns}>
                        <fieldset className={styles.fieldset}>
                          <legend>
                            {draft.schedule.frequency === 'interval'
                              ? 'Первое время дня'
                              : 'Время отправки'}
                          </legend>
                          <div className={styles.times}>
                            {draft.schedule.times
                              .slice(
                                0,
                                ['interval', 'once'].includes(draft.schedule.frequency)
                                  ? 1
                                  : undefined,
                              )
                              .map((time, index) => (
                                <div key={index}>
                                  <input
                                    type="time"
                                    aria-label={`Время отправки ${index + 1}`}
                                    required
                                    value={time}
                                    onChange={(event) =>
                                      patchSchedule({
                                        times: draft.schedule.times.map((value, at) =>
                                          index === at ? event.target.value : value,
                                        ),
                                      })
                                    }
                                  />
                                  {index > 0 && (
                                    <button
                                      type="button"
                                      className={compact}
                                      aria-label={`Удалить время ${index + 1}`}
                                      onClick={() =>
                                        patchSchedule({
                                          times: draft.schedule.times.filter(
                                            (_, at) => at !== index,
                                          ),
                                        })
                                      }
                                    >
                                      ×
                                    </button>
                                  )}
                                </div>
                              ))}
                          </div>
                          {!['interval', 'once'].includes(draft.schedule.frequency) &&
                            draft.schedule.times.length < 3 && (
                              <button
                                type="button"
                                className={`${compact} ${styles.addTime}`}
                                onClick={() =>
                                  patchSchedule({ times: [...draft.schedule.times, '18:00'] })
                                }
                              >
                                <Icon name="plus" />
                                Ещё время
                              </button>
                            )}
                        </fieldset>
                        <label className={styles.field}>
                          <span>Часовой пояс</span>
                          <select
                            value={draft.schedule.timezone}
                            onChange={(event) => patchSchedule({ timezone: event.target.value })}
                          >
                            <option value="Europe/Moscow">Москва, UTC+3</option>
                            <option value="Asia/Yekaterinburg">Екатеринбург, UTC+5</option>
                            <option value="Asia/Novosibirsk">Новосибирск, UTC+7</option>
                            <option value="Asia/Vladivostok">Владивосток, UTC+10</option>
                          </select>
                        </label>
                      </div>
                    )}
                    {draft.schedule.frequency === 'event' && (
                      <div className={styles.ruleNote}>
                        <Icon name="bell" />
                        <p>
                          Отправляем после добавления или изменения записи, если она подходит под
                          условия блока.
                        </p>
                      </div>
                    )}
                    <div className={styles.weekendSetting}>
                      <label className={styles.switchRow}>
                        <span>
                          <strong>Отправлять в выходные</strong>
                          <small>Суббота и воскресенье</small>
                        </span>
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label="Отправлять в выходные"
                          checked={draft.schedule.weekends}
                          onChange={(event) => patchSchedule({ weekends: event.target.checked })}
                        />
                      </label>
                      {!draft.schedule.weekends && (
                        <div className={styles.weekendNote}>
                          <Icon name="calendar" />
                          <p>
                            <strong>Данные за выходные придут в понедельник.</strong> В одном
                            сообщении с данными за понедельник, отдельными частями «За субботу» и
                            «За воскресенье».
                          </p>
                          <button type="button" className={compact} onClick={() => setMonday(true)}>
                            Посмотреть пример
                          </button>
                        </div>
                      )}
                    </div>
                    <div className={styles.scheduleSummary}>
                      <Icon name="clock" />
                      <div>
                        <strong>{scheduleLabel(draft.schedule)}</strong>
                        <p>
                          {draft.schedule.weekends
                            ? 'Включая субботу и воскресенье.'
                            : 'Без отправки в выходные. Данные сохраняются до понедельника.'}
                        </p>
                      </div>
                    </div>
                  </>
                )}

                {step === 3 && (
                  <>
                    <StepHeading
                      title="Как выглядит сообщение"
                      text="Заголовок, пояснение и блоки с выбранными полями. Результат сразу виден справа."
                    />
                    <label className={styles.field}>
                      <span>Заголовок сообщения</span>
                      <input
                        value={draft.name}
                        maxLength={120}
                        onChange={(event) => patch({ name: event.target.value })}
                      />
                    </label>
                    <label className={styles.field}>
                      <span>Текст перед данными</span>
                      <textarea
                        rows={3}
                        value={draft.intro}
                        placeholder="Например: На что обратить внимание сегодня"
                        onChange={(event) => patch({ intro: event.target.value })}
                      />
                      <small>Можно оставить пустым.</small>
                    </label>
                    <div className={styles.sectionTitle}>
                      <h3>Блоки в сообщении</h3>
                      <span>{draft.blocks.length}</span>
                    </div>
                    {draft.blocks.map((block, index) => (
                      <label className={styles.field} key={block.id}>
                        <span>
                          {index + 1}. {sourceFor(block.sourceId).name}
                        </span>
                        <input
                          aria-label={`Заголовок блока ${index + 1}`}
                          value={block.title}
                          onChange={(event) => patchBlock(block.id, { title: event.target.value })}
                        />
                      </label>
                    ))}
                    <fieldset className={styles.fieldset}>
                      <legend>Если подходящих данных нет</legend>
                      <label className={styles.radioLine}>
                        <input
                          type="radio"
                          name="empty-behavior"
                          checked={draft.empty === 'skip'}
                          onChange={() => patch({ empty: 'skip' })}
                        />
                        Пропустить пустые блоки и пустую отправку
                      </label>
                      <label className={styles.radioLine}>
                        <input
                          type="radio"
                          name="empty-behavior"
                          checked={draft.empty === 'send'}
                          onChange={() => patch({ empty: 'send' })}
                        />
                        Прислать сообщение «Данных нет»
                      </label>
                    </fieldset>
                    <div className={styles.recipient}>
                      <span className={styles.recipientIcon}>
                        <Icon name="send" />
                      </span>
                      <div>
                        <strong>Ваш личный Telegram</strong>
                        <p>Получатель — только вы</p>
                      </div>
                      <span className={styles.demoBadge}>Пример</span>
                    </div>
                    <button type="button" className={compact} onClick={() => setTestOpen(true)}>
                      <Icon name="send" />
                      Посмотреть тестовое сообщение
                    </button>
                  </>
                )}
              </div>
              <div className={styles.stepFooter}>
                <span>Шаг {step + 1} из 4</span>
                <div>
                  {step > 0 && (
                    <button type="button" className={compact} onClick={() => goToStep(step - 1)}>
                      Назад
                    </button>
                  )}
                  {step < 3 ? (
                    <button
                      type="button"
                      className="btn btn--primary btn--compact"
                      onClick={() => goToStep(step + 1)}
                    >
                      Далее: {STEPS[step + 1].toLocaleLowerCase('ru')}
                      <Icon name="arrow" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--primary btn--compact"
                      onClick={saveDraft}
                    >
                      <Icon name="check" />
                      Сохранить макет
                    </button>
                  )}
                </div>
              </div>
            </div>

            <aside className={styles.preview} aria-label="Предпросмотр уведомления">
              <div className={styles.previewHeading}>
                <h2>Ваше сообщение</h2>
                <span className={styles.liveDot}>Предпросмотр</span>
              </div>
              <div className={styles.previewTabs}>
                <button
                  type="button"
                  className="btn btn--segment btn--compact"
                  aria-pressed={!monday}
                  onClick={() => setMonday(false)}
                >
                  Обычный день
                </button>
                <button
                  type="button"
                  className="btn btn--segment btn--compact"
                  aria-pressed={monday}
                  onClick={() => setMonday(true)}
                >
                  Понедельник
                </button>
              </div>
              <div className={styles.telegram}>
                <div className={styles.telegramHeader}>
                  <span className={styles.botAvatar}>
                    <Icon name="bell" />
                  </span>
                  <div>
                    <strong>Домовой</strong>
                    <span>бот · личные уведомления</span>
                  </div>
                  <Icon name="send" />
                </div>
                <div className={styles.chat}>
                  <div className={styles.chatDate}>
                    {monday ? 'Понедельник, 9 ноября' : 'Вторник, 3 ноября'}
                  </div>
                  {message}
                </div>
              </div>
              {monday && !draft.schedule.weekends && (
                <p className={styles.previewHint}>
                  <Icon name="calendar" />
                  Данные за субботу и воскресенье отмечены отдельно.
                </p>
              )}
              <div className={styles.previewMeta}>
                <span>
                  <Icon name="table" />
                  {countLabel(draft.blocks.length, ['блок', 'блока', 'блоков'])}
                </span>
                <span>{countLabel(matched, ['запись', 'записи', 'записей'])} в примере</span>
              </div>
              <div className={styles.nextSends}>
                <h3>
                  <Icon name="clock" />
                  Ближайшие отправки
                </h3>
                {!draft.enabled ? (
                  <p>Уведомление на паузе.</p>
                ) : draft.schedule.frequency === 'event' ? (
                  <p>Когда данные изменятся и подойдут под условия.</p>
                ) : dispatches.length ? (
                  dispatches.map((item) => (
                    <div key={`${item.day}-${item.time}`}>
                      <span>
                        {dateLabel(item.day)}
                        {!draft.schedule.weekends &&
                        new Date(`${item.day}T12:00:00Z`).getUTCDay() === 1
                          ? ' + выходные'
                          : ''}
                      </span>
                      <strong>{item.time}</strong>
                    </div>
                  ))
                ) : (
                  <p>Выберите будущую дату отправки.</p>
                )}
                <small>
                  {draft.schedule.timezone === 'Europe/Moscow'
                    ? 'Время московское'
                    : draft.schedule.timezone}
                </small>
              </div>
            </aside>
          </div>
          <footer className={styles.saveBar}>
            <div>
              <span className={dirty ? styles.unsavedDot : styles.savedDot} />
              {dirty ? 'Есть несохранённые изменения' : 'Изменений нет'}
              <small>Демо: сообщения в Telegram не отправляются</small>
            </div>
            <button type="button" className="btn btn--primary btn--compact" onClick={saveDraft}>
              <Icon name="check" />
              Сохранить макет
            </button>
          </footer>
          {notice && (
            <p role="status" className={styles.notice}>
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
        </main>
      </div>
      {picker && <SourcePicker onClose={() => setPicker(null)} onSelect={selectSource} />}
      {testOpen && (
        <Modal
          title="Тестовое сообщение"
          testId="notification-test-preview"
          onClose={() => setTestOpen(false)}
          protectChanges={false}
          panelClassName={styles.testDialog}
        >
          <p className={styles.modalNote}>
            Так будет выглядеть уведомление в вашем Telegram. На тестовой странице показан только
            предпросмотр.
          </p>
          <div className={styles.testChat}>{message}</div>
          <div className="dialog-actions">
            <button type="button" className={compact} onClick={() => setTestOpen(false)}>
              Закрыть
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function StepHeading({ title, text }: { title: string; text: string }): JSX.Element {
  return (
    <div className={styles.stepHeading}>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

function DataBlock({
  block,
  index,
  count,
  onChange,
  onSource,
  onRemove,
  onMove,
}: {
  block: Block;
  index: number;
  count: number;
  onChange: (values: Partial<Block>) => void;
  onSource: () => void;
  onRemove: () => void;
  onMove: (direction: number) => void;
}): JSX.Element {
  const source = sourceFor(block.sourceId);
  const hasScope = source.fields.some((field) => field.id === 'dormitory');
  return (
    <section className={styles.block} aria-label={`Блок данных ${index + 1}`}>
      <div className={styles.blockHead}>
        <span className={styles.blockIcon}>
          <Icon name="table" />
        </span>
        <div>
          <h3>{block.title}</h3>
          <p>
            {source.group} / {source.name}
          </p>
        </div>
        <div className={styles.blockTools}>
          <button
            type="button"
            className={compact}
            disabled={index === 0}
            aria-label={`Поднять блок ${index + 1}`}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className={compact}
            disabled={index === count - 1}
            aria-label={`Опустить блок ${index + 1}`}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className={compact}
            aria-label={`Удалить блок ${index + 1}`}
            onClick={onRemove}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>
      <div className={styles.sourceLine}>
        <span>Источник данных</span>
        <button type="button" className={compact} onClick={onSource}>
          {source.name}
          <Icon name="table" />
        </button>
      </div>
      <div className={styles.twoColumns}>
        {hasScope && (
          <label className={styles.field}>
            <span>Общежития</span>
            <select
              aria-label={`Общежития блока ${index + 1}`}
              value={block.scope}
              onChange={(event) => onChange({ scope: event.target.value })}
            >
              <option value="all">Все общежития компании</option>
              <option>Северное</option>
              <option>Центральное</option>
            </select>
          </label>
        )}
        <label className={styles.field}>
          <span>Период данных</span>
          <select
            aria-label={`Период блока ${index + 1}`}
            value={block.period}
            onChange={(event) => onChange({ period: event.target.value as Block['period'] })}
            disabled={!block.dateField}
          >
            <option value="day">За день отправки</option>
            <option value="yesterday">За предыдущий день</option>
            <option value="week">За последние 7 дней</option>
            <option value="month">С начала месяца</option>
            <option value="all">Все подходящие данные</option>
          </select>
        </label>
      </div>
      {block.dateField && (
        <p className={styles.dateBasis}>
          Период по полю «{source.fields.find((field) => field.id === block.dateField)?.name}»
        </p>
      )}
      <fieldset className={styles.fieldset}>
        <legend>
          Поля в сообщении <span>{block.fields.length} выбрано</span>
        </legend>
        <div className={styles.fieldChips}>
          {source.fields.map((field) => (
            <label
              key={field.id}
              className={styles.fieldChip}
              data-checked={block.fields.includes(field.id)}
            >
              <input
                type="checkbox"
                checked={block.fields.includes(field.id)}
                onChange={(event) =>
                  onChange({
                    fields: event.target.checked
                      ? [...block.fields, field.id]
                      : block.fields.filter((id) => id !== field.id),
                  })
                }
              />
              {field.name}
            </label>
          ))}
        </div>
      </fieldset>
      {block.fields.length > 1 && (
        <div className={styles.fieldOrder}>
          <span>Порядок:</span>
          {block.fields.map((id, at) => (
            <span key={id}>
              {source.fields.find((field) => field.id === id)?.name}
              {at > 0 && (
                <button
                  className="btn btn--quiet"
                  type="button"
                  aria-label={`Поле ${source.fields.find((field) => field.id === id)?.name} раньше в блоке ${index + 1}`}
                  onClick={() => {
                    const fields = [...block.fields];
                    [fields[at - 1], fields[at]] = [fields[at], fields[at - 1]];
                    onChange({ fields });
                  }}
                >
                  ←
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <label className={styles.field}>
        <span>Как показать</span>
        <select
          aria-label={`Формат блока ${index + 1}`}
          value={block.format}
          onChange={(event) => onChange({ format: event.target.value as Block['format'] })}
        >
          <option value="rows">Список записей с выбранными полями</option>
          <option value="count">Только количество записей</option>
          {source.fields.some((field) => field.kind === 'number') && (
            <option value="sum">Сумма по числовому полю</option>
          )}
        </select>
      </label>
      {block.format === 'sum' && (
        <label className={styles.field}>
          <span>Какое поле суммировать</span>
          <select
            value={block.sumField}
            onChange={(event) => onChange({ sumField: event.target.value })}
          >
            {source.fields
              .filter((field) => field.kind === 'number')
              .map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
          </select>
        </label>
      )}
    </section>
  );
}

function operatorsFor(field: Field | undefined): string[] {
  if (field?.kind === 'date') return ['today', 'next_days', 'equals', 'filled', 'empty'];
  if (field?.kind === 'number')
    return ['greater', 'less', 'equals', 'not_equals', 'filled', 'empty'];
  return ['equals', 'not_equals', 'contains', 'filled', 'empty'];
}

function ConditionEditor({
  block,
  onChange,
}: {
  block: Block;
  onChange: (values: Partial<Block>) => void;
}): JSX.Element {
  const source = sourceFor(block.sourceId);
  const patchCondition = (id: string, values: Partial<Condition>): void =>
    onChange({
      conditions: block.conditions.map((condition) =>
        condition.id === id ? { ...condition, ...values } : condition,
      ),
    });
  return (
    <section className={styles.block}>
      <div className={styles.blockHead}>
        <span className={styles.blockIcon}>
          <Icon name="filter" />
        </span>
        <div>
          <h3>{block.title}</h3>
          <p>
            {source.group} / {source.name}
          </p>
        </div>
        <span className={styles.conditionCount}>
          {countLabel(block.conditions.length, ['условие', 'условия', 'условий'])}
        </span>
      </div>
      {block.conditions.length > 0 && (
        <label className={styles.matchMode}>
          Включать запись, если
          <select
            aria-label={`Объединение условий ${block.title}`}
            value={block.match}
            onChange={(event) => onChange({ match: event.target.value as Block['match'] })}
          >
            <option value="all">выполнены все условия</option>
            <option value="any">выполнено хотя бы одно</option>
          </select>
        </label>
      )}
      {block.conditions.map((condition, index) => {
        const field = source.fields.find((item) => item.id === condition.field);
        const noValue = ['filled', 'empty', 'today'].includes(condition.operator);
        return (
          <div className={styles.conditionRow} key={condition.id}>
            <span className={styles.conditionJoin}>
              {index ? (block.match === 'all' ? 'И' : 'ИЛИ') : 'Если'}
            </span>
            <select
              aria-label={`Поле условия ${index + 1} в ${block.title}`}
              value={condition.field}
              onChange={(event) => {
                const next = source.fields.find((item) => item.id === event.target.value);
                patchCondition(condition.id, {
                  field: event.target.value,
                  operator: operatorsFor(next)[0],
                  value: '',
                });
              }}
            >
              {source.fields.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <select
              aria-label={`Оператор условия ${index + 1} в ${block.title}`}
              value={condition.operator}
              onChange={(event) =>
                patchCondition(condition.id, {
                  operator: event.target.value,
                  value: event.target.value === 'next_days' ? '7' : '',
                })
              }
            >
              {operatorsFor(field).map((operator) => (
                <option key={operator} value={operator}>
                  {OPERATORS[operator]}
                </option>
              ))}
            </select>
            {!noValue && (
              <input
                aria-label={`Значение условия ${index + 1} в ${block.title}`}
                type={
                  condition.operator === 'next_days' || field?.kind === 'number'
                    ? 'number'
                    : field?.kind === 'date'
                      ? 'date'
                      : 'text'
                }
                min={condition.operator === 'next_days' ? 0 : undefined}
                value={condition.value}
                placeholder="Значение"
                onChange={(event) => patchCondition(condition.id, { value: event.target.value })}
              />
            )}
            <button
              type="button"
              className={compact}
              aria-label={`Удалить условие ${index + 1} в ${block.title}`}
              onClick={() =>
                onChange({
                  conditions: block.conditions.filter((item) => item.id !== condition.id),
                })
              }
            >
              <Icon name="trash" />
            </button>
          </div>
        );
      })}
      {!block.conditions.length && <p className={styles.muted}>Все записи выбранного периода.</p>}
      <button
        type="button"
        className={`${compact} ${styles.addCondition}`}
        onClick={() => {
          const field = source.fields[0];
          onChange({
            conditions: [
              ...block.conditions,
              { id: uid(), field: field.id, operator: operatorsFor(field)[0], value: '' },
            ],
          });
        }}
      >
        <Icon name="plus" />
        Добавить условие
      </button>
    </section>
  );
}

function SourcePicker({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (source: Source) => void;
}): JSX.Element {
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('Все разделы');
  const groups = ['Все разделы', ...new Set(SOURCES.map((source) => source.group))];
  const filtered = SOURCES.filter(
    (source) =>
      (group === 'Все разделы' || group === source.group) &&
      `${source.name} ${source.group} ${source.fields.map((field) => field.name).join(' ')}`
        .toLocaleLowerCase('ru')
        .includes(search.toLocaleLowerCase('ru')),
  );
  return (
    <Modal
      title="Выберите таблицу компании"
      testId="notification-source-picker"
      onClose={onClose}
      protectChanges={false}
      panelClassName={styles.sourceDialog}
    >
      <p className={styles.modalNote}>
        Таблицы общежитий, персонал, отчёты и свои таблицы. Здесь показан пример каталога компании.
      </p>
      <label className={styles.search}>
        <Icon name="search" />
        <input
          aria-label="Найти таблицу или поле"
          placeholder="Найти таблицу или поле…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className={styles.sourceGroups}>
        {groups.map((item) => (
          <button
            key={item}
            type="button"
            className="btn btn--segment btn--compact"
            aria-pressed={group === item}
            onClick={() => setGroup(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div className={styles.sourceGrid}>
        {filtered.map((source) => (
          <button
            type="button"
            key={source.id}
            className={`btn btn--choice ${styles.sourceChoice}`}
            onClick={() => onSelect(source)}
          >
            <span className={styles.blockIcon}>
              <Icon name="table" />
            </span>
            <strong>{source.name}</strong>
            <span>{source.group}</span>
            <small>{source.fields.map((field) => field.name).join(', ')}</small>
            <span className={styles.sourceChoiceAction}>
              Выбрать таблицу <Icon name="plus" />
            </span>
          </button>
        ))}
      </div>
      {!filtered.length && (
        <p className={styles.emptyState}>
          Таблиц с таким названием или полем нет. Попробуйте другой запрос.
        </p>
      )}
    </Modal>
  );
}

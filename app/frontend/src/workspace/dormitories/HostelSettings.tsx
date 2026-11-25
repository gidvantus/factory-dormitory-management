import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { HostelRow, HostelSettings as Settings } from '../../api/client';
import { useUnsavedChanges } from '../../components/useUnsavedChanges';
import { ReportLinkEditor } from './ReportLinkEditor';
import reportStyles from './ReportTable.module.css';
import styles from './HostelPlaces.module.css';

const errorText = (error: unknown): string =>
  error instanceof ApiError
    ? error.message
    : 'Не удалось сохранить или загрузить настройки хостела.';

export function HostelRuleMark({
  row,
}: {
  row: Pick<HostelRow, 'formula' | 'link'>;
}): JSX.Element | null {
  if (!row.formula && !row.link) return null;
  return (
    <sup
      className="table-rule-mark"
      title={row.formula ?? 'Значение из другой таблицы'}
      aria-label={row.formula ? 'Формула' : 'Связь с таблицей'}
    >
      {row.formula ? 'ƒ' : '↗'}
    </sup>
  );
}

type Draft = {
  id?: number;
  name: string;
  rows: HostelRow[];
  version: number;
  until?: string | null;
};

function HostelEditor({
  initial,
  month,
  dormitoryId,
  templates,
  onBack,
  onSave,
  onTemplate,
  onDirty,
  onBusy,
}: {
  initial: Draft;
  month: string;
  dormitoryId: string;
  templates: Settings['templates'];
  onBack: () => void;
  onSave: () => void;
  onTemplate: (template: Settings['templates'][number]) => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(initial);
  const [selected, setSelected] = useState(initial.rows[0]?.key ?? '');
  const [pending, setPending] = useState<Record<string, string>>({});
  const [linkModes, setLinkModes] = useState<Record<string, boolean>>({});
  const [templateName, setTemplateName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [archived, setArchived] = useState(false);
  const row = draft.rows.find((item) => item.key === selected && item.archived === archived);
  const listed = draft.rows.filter((item) => item.archived === archived);
  const mode =
    row?.formula != null ? 'formula' : row?.link || linkModes[selected] ? 'link' : 'manual';
  const dirty = draft !== initial || templateName !== null;
  const confirmDiscard = useUnsavedChanges(dirty);
  const formulaField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);

  function clearPending(): void {
    setPending((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => key !== selected)),
    );
  }

  function insertFormula(name: string): void {
    const field = formulaField.current;
    const formula = row?.formula || '=';
    const start = Math.max(field?.selectionStart ?? formula.length, 1);
    const end = Math.max(field?.selectionEnd ?? start, start);
    const token = `[${name.trim()}]`;
    patchRow({ formula: formula.slice(0, start) + token + formula.slice(end) });
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function patchRow(patch: Partial<HostelRow>): void {
    if (!row) return;
    setDraft({
      ...draft,
      rows: draft.rows.map((item) => {
        if (item.key === row.key) return { ...item, ...patch };
        if (patch.name === undefined || !item.formula) return item;
        return {
          ...item,
          formula: item.formula.replaceAll(`[${row.name.trim()}]`, `[${patch.name.trim()}]`),
        };
      }),
    });
  }

  function changeMode(next: 'manual' | 'formula' | 'link'): void {
    setLinkModes({ ...linkModes, [selected]: next === 'link' });
    clearPending();
    patchRow({ formula: next === 'formula' ? '=' : null, link: null });
  }

  function move(offset: number): void {
    const target = listed[listed.findIndex((item) => item.key === selected) + offset];
    if (!row || !target) return;
    setDraft({
      ...draft,
      rows: draft.rows.map((item) => (item === row ? target : item === target ? row : item)),
    });
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  function canSave(): boolean {
    if (
      draft.rows.some(
        (item) => !item.archived && (!item.name.trim() || (linkModes[item.key] && !item.link)),
      )
    ) {
      setError('Заполните названия строк и выберите источники для всех связей.');
      return false;
    }
    return true;
  }

  function save(): void {
    if (!draft.name.trim()) {
      setError('Введите название хостела.');
      return;
    }
    if (!canSave()) return;
    void run(async () => {
      if (draft.id)
        await api.updateHostelSettings(
          dormitoryId,
          draft.id,
          month,
          draft.name,
          draft.rows,
          draft.version,
        );
      else await api.createHostel(dormitoryId, draft.name, month, draft.rows);
      onSave();
    });
  }

  return (
    <fieldset className={styles.builder} disabled={busy}>
      <legend>{initial.id ? 'Настройка хостела' : 'Добавить хостел'}</legend>
      <button
        type="button"
        className="btn btn--ghost btn--compact"
        onClick={() => {
          if (confirmDiscard()) onBack();
        }}
      >
        ← К списку хостелов
      </button>
      <label className={styles.hostelField}>
        Название хостела
        <input
          maxLength={120}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      {!initial.id && templates.length > 0 && (
        <label className={styles.hostelField}>
          Загрузить строки из шаблона
          <select
            value=""
            onChange={(event) => {
              const id = Number(event.target.value);
              if (!id) return;
              if (
                draft.rows !== initial.rows &&
                !window.confirm('Заменить текущую настройку строк шаблоном?')
              )
                return;
              void run(async () => {
                const result = await api.hostelTemplate(dormitoryId, id);
                setDraft({ ...draft, rows: result.rows });
                setSelected(result.rows[0]?.key ?? '');
                setArchived(false);
                setPending(result.warnings);
                setLinkModes(
                  Object.fromEntries(Object.keys(result.warnings).map((key) => [key, true])),
                );
                if (Object.keys(result.warnings).length)
                  setMessage('Выберите источники для строк с пометкой об ошибке.');
              });
            }}
          >
            <option value="">Выберите шаблон</option>
            {templates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className={reportStyles.formulaHelp}>
        Строки действуют с {month.slice(0, 7).split('-').reverse().join('.')}
        {initial.until
          ? ` до следующей настройки в ${initial.until.slice(0, 7).split('-').reverse().join('.')}`
          : ' и в следующих месяцах'}
        .
      </p>
      <div className={styles.builderGrid}>
        <div className={styles.builderList}>
          <button
            type="button"
            className="btn btn--outline btn--compact"
            disabled={draft.rows.length >= 100}
            onClick={() => {
              const key =
                'r_' +
                Array.from(crypto.getRandomValues(new Uint8Array(10)), (value) =>
                  value.toString(16).padStart(2, '0'),
                ).join('');
              setDraft({
                ...draft,
                rows: [
                  ...draft.rows,
                  { key, name: '', formula: null, link: null, archived: false },
                ],
              });
              setArchived(false);
              setSelected(key);
            }}
          >
            + Добавить строку
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            aria-pressed={archived}
            onClick={() => {
              setArchived(!archived);
              setSelected(draft.rows.find((item) => item.archived !== archived)?.key ?? '');
            }}
          >
            {archived ? 'Действующие строки' : 'Архивные строки'}
          </button>
          {listed.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`btn btn--quiet btn--compact ${styles.builderRow}`}
              aria-pressed={selected === item.key}
              onClick={() => setSelected(item.key)}
            >
              <span>
                {item.name || 'Новая строка'} <HostelRuleMark row={item} />
              </span>
              {pending[item.key] && (
                <span title={pending[item.key]} aria-label="Проверьте источник">
                  !
                </span>
              )}
            </button>
          ))}
        </div>
        {row && (
          <div className={styles.builderEditor} key={row.key}>
            {archived ? (
              <button
                type="button"
                className="btn btn--outline btn--compact"
                onClick={() => {
                  patchRow({ archived: false });
                  setArchived(false);
                }}
              >
                Восстановить строку «{row.name}»
              </button>
            ) : (
              <>
                <label className={styles.hostelField}>
                  Название строки
                  <input
                    maxLength={120}
                    value={row.name}
                    onChange={(event) => patchRow({ name: event.target.value })}
                  />
                </label>
                <fieldset className={reportStyles.modeGroup}>
                  <legend>Как заполняется строка</legend>
                  {(
                    [
                      ['manual', 'Вручную по дням'],
                      ['formula', 'Формулой для всех дней'],
                      ['link', 'Связь с таблицей'],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      <input
                        type="radio"
                        name="hostel-row-mode"
                        checked={mode === key}
                        onChange={() => changeMode(key)}
                      />{' '}
                      {label}
                    </label>
                  ))}
                </fieldset>
                {mode === 'formula' && (
                  <>
                    <label className={styles.hostelField}>
                      Формула
                      <textarea
                        ref={formulaField}
                        rows={3}
                        maxLength={1000}
                        value={row.formula ?? '='}
                        onChange={(event) => patchRow({ formula: event.target.value })}
                      />
                    </label>
                    <div className={styles.hostelActions} aria-label="Строки для подстановки">
                      {listed
                        .filter((item) => item !== row && item.name.trim())
                        .map((item) => (
                          <button
                            key={item.key}
                            type="button"
                            className="btn btn--outline btn--compact"
                            onClick={() => insertFormula(item.name)}
                          >
                            {item.name}
                          </button>
                        ))}
                    </div>
                  </>
                )}
                {mode === 'link' && (
                  <ReportLinkEditor
                    hostel
                    disabled={busy}
                    dormitoryId={dormitoryId}
                    initial={row.link}
                    onChange={(link) => {
                      patchRow({ link });
                      if (link) clearPending();
                    }}
                  />
                )}
                {pending[row.key] && (
                  <p role="alert" className={styles.error}>
                    {pending[row.key]}
                  </p>
                )}
                <div className={styles.hostelActions}>
                  <button
                    type="button"
                    className="btn btn--ghost btn--compact"
                    disabled={row === listed[0]}
                    onClick={() => move(-1)}
                  >
                    ↑ Строку выше
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--compact"
                    disabled={row === listed.at(-1)}
                    onClick={() => move(1)}
                  >
                    ↓ Строку ниже
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--compact"
                    onClick={() => {
                      if (initial.rows.some((item) => item.key === row.key)) {
                        patchRow({ archived: true });
                      } else {
                        setDraft({ ...draft, rows: draft.rows.filter((item) => item !== row) });
                      }
                      setSelected(listed.find((item) => item !== row)?.key ?? '');
                    }}
                  >
                    Убрать строку
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {templateName !== null && (
        <label className={styles.hostelField}>
          Название шаблона
          <input
            maxLength={120}
            value={templateName}
            onChange={(event) => setTemplateName(event.target.value)}
          />
        </label>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className={styles.hostelActions}>
        {templateName === null ? (
          <button
            type="button"
            className="btn btn--outline btn--compact"
            onClick={() => setTemplateName(draft.name)}
          >
            Сохранить как шаблон
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              onClick={() => setTemplateName(null)}
            >
              Отменить шаблон
            </button>
            <button
              type="button"
              className="btn btn--outline btn--compact"
              disabled={!templateName.trim()}
              onClick={() => {
                if (!canSave()) return;
                void run(async () => {
                  const template = await api.saveHostelTemplate(
                    dormitoryId,
                    templateName,
                    draft.rows,
                  );
                  onTemplate(template);
                  setTemplateName(null);
                  setMessage(`Шаблон «${template.name}» доступен в общежитиях организации.`);
                });
              }}
            >
              Сохранить шаблон
            </button>
          </>
        )}
        <button type="button" className="btn btn--primary btn--compact" onClick={save}>
          {initial.id ? 'Сохранить хостел' : 'Добавить хостел'}
        </button>
      </div>
    </fieldset>
  );
}

export function HostelSettings({
  dormitoryId,
  month,
  creating,
  onChanged,
  onDirty,
  onBusy,
}: {
  dormitoryId: string;
  month: string;
  creating: boolean;
  onChanged: () => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}): JSX.Element {
  const [data, setData] = useState<Settings | null>(null);
  const [editor, setEditor] = useState<Draft | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const openedCreate = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .hostelSettings(dormitoryId, month, controller.signal)
      .then((settings) => {
        if (controller.signal.aborted) return;
        setData(settings);
        setError('');
        if (creating && !openedCreate.current) {
          openedCreate.current = true;
          setEditor({ name: '', rows: settings.defaults, version: 0 });
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(errorText(caught));
      });
    return () => controller.abort();
  }, [dormitoryId, month, attempt, creating]);

  if (error)
    return (
      <p role="alert">
        {error}{' '}
        <button
          type="button"
          className="link-button"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Повторить
        </button>
      </p>
    );
  if (!data) return <p role="status">Загружаем хостелы…</p>;
  if (editor)
    return (
      <HostelEditor
        initial={editor}
        month={month}
        dormitoryId={dormitoryId}
        templates={data.templates}
        onDirty={onDirty}
        onBusy={onBusy}
        onBack={() => setEditor(null)}
        onTemplate={(template) => setData({ ...data, templates: [...data.templates, template] })}
        onSave={() => {
          setEditor(null);
          setData(null);
          setAttempt((value) => value + 1);
          setNotice('Хостел сохранён.');
          onChanged();
        }}
      />
    );
  return (
    <section className={styles.builder} aria-label="Хостелы и строки">
      <h4>Хостелы и строки</h4>
      {notice && <p role="status">{notice}</p>}
      <button
        type="button"
        className="btn btn--outline btn--compact"
        onClick={() => setEditor({ name: '', rows: data.defaults, version: 0 })}
      >
        + Добавить хостел
      </button>
      {data.hostels.length ? (
        <ul className={styles.hostelCards}>
          {data.hostels.map((hostel) => (
            <li key={hostel.id}>
              <button type="button" className={styles.hostelCard} onClick={() => setEditor(hostel)}>
                <span className={styles.hostelCardKind}>Хостел</span>
                <strong className={styles.hostelCardName}>{hostel.name}</strong>
                <span className={styles.hostelCardAction}>Настроить строки</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>В выбранном месяце нет действующих хостелов.</p>
      )}
    </section>
  );
}

import { useRef, useState } from 'react';
import { Modal, ModalCancelButton } from '../../components/Modal';
import { WorkspaceIcon } from '../../workspace/WorkspaceIcon';
import {
  demoId,
  evaluate,
  makeRow,
  modeNames,
  readFormula,
  rowErrors,
  sampleDay,
  showFormula,
  sourceOptions,
  sources,
} from './model';
import type { Hostel, Mode, Row, SourceTable, Template } from './model';
import styles from './HostelBuilderPreview.module.css';

export const outline = 'btn btn--outline btn--compact';
export const primary = 'btn btn--primary btn--compact';

export function ModeMark({ mode }: { mode: Mode }): JSX.Element {
  return (
    <span className={styles.modeMark} data-mode={mode} aria-hidden="true">
      {mode === 'formula' ? (
        'ƒx'
      ) : (
        <WorkspaceIcon name={mode === 'source' ? 'building' : 'document'} />
      )}
    </span>
  );
}

function FormulaField({
  row,
  rows,
  change,
}: {
  row: Row;
  rows: Row[];
  change: (patch: Partial<Row>) => void;
}): JSX.Element {
  const field = useRef<HTMLTextAreaElement>(null);
  const expression = showFormula(row.formula, rows);
  const available = rows.filter((item) => item.id !== row.id && item.name.trim());

  function insert(item: Row): void {
    const element = field.current;
    const start = element?.selectionStart ?? expression.length;
    const end = element?.selectionEnd ?? expression.length;
    const prefix = expression ? expression.slice(0, start) : '=';
    const token = `[${item.name.trim()}]`;
    change({ formula: readFormula(`${prefix}${token}${expression.slice(end)}`, rows) });
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(prefix.length + token.length, prefix.length + token.length);
    });
  }

  return (
    <>
      <label className={styles.field}>
        Формула
        <textarea
          ref={field}
          value={expression}
          rows={2}
          placeholder="=[Проживает М]+[Проживает Ж]"
          onChange={(event) => change({ formula: readFormula(event.target.value, rows) })}
          spellCheck={false}
        />
      </label>
      <div className={styles.insertRow}>
        <span>Вставить в формулу</span>
        <div>
          {available.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.formulaToken}
              onClick={() => insert(item)}
            >
              {item.name.trim()}
            </button>
          ))}
          {!available.length && <small>Добавьте другие строки, чтобы сослаться на них.</small>}
        </div>
      </div>
    </>
  );
}

function RowSettings({
  row,
  rows,
  change,
}: {
  row: Row;
  rows: Row[];
  change: (patch: Partial<Row>) => void;
}): JSX.Element {
  return (
    <>
      <label className={styles.field}>
        Название строки
        <input
          value={row.name}
          maxLength={80}
          onChange={(event) => change({ name: event.target.value })}
        />
      </label>
      <fieldset className={styles.modes}>
        <legend>Как заполняется строка</legend>
        <div>
          {(Object.entries(modeNames) as [Mode, string][]).map(([mode, name]) => (
            <label key={mode} className={styles.modeOption}>
              <input
                type="radio"
                name="hostel-row-mode"
                checked={row.mode === mode}
                onChange={() => change({ mode })}
              />
              <ModeMark mode={mode} />
              {name}
            </label>
          ))}
        </div>
      </fieldset>
      {row.mode === 'manual' && (
        <p className={styles.fieldHint}>
          Введите значения в ячейки по датам после сохранения хостела.
        </p>
      )}
      {row.mode === 'formula' && <FormulaField row={row} rows={rows} change={change} />}
      {row.mode === 'source' && (
        <>
          <div className={styles.sourceFields}>
            <label className={styles.field}>
              Таблица-источник
              <select
                value={row.source}
                onChange={(event) => {
                  const source = event.target.value as SourceTable;
                  change({ source, indicator: sourceOptions(source)[0][0] });
                }}
              >
                {Object.entries(sources).map(([key, source]) => (
                  <option key={key} value={key}>
                    {source.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              Что брать
              <select
                value={row.indicator}
                onChange={(event) => change({ indicator: event.target.value })}
              >
                {sourceOptions(row.source).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className={styles.fieldHint}>
            {row.source === 'residents'
              ? 'Количество проживающих в этом хостеле на выбранную дату.'
              : 'Данные текущего общежития за выбранную дату.'}
          </p>
        </>
      )}
    </>
  );
}

export function HostelBuilder({
  hostel,
  creating,
  templates,
  onClose,
  onSave,
  onTemplateSave,
}: {
  hostel: Hostel;
  creating: boolean;
  templates: Template[];
  onClose: () => void;
  onSave: (hostel: Hostel) => void;
  onTemplateSave: (template: Template) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(hostel);
  const [selected, setSelected] = useState<string | undefined>(hostel.rows[0]?.id);
  const [templateName, setTemplateName] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [shownErrors, setShownErrors] = useState(false);
  const active = draft.rows.find((row) => row.id === selected);
  const index = draft.rows.findIndex((row) => row.id === selected);
  const errors = rowErrors(draft);
  const cells = evaluate(draft, sampleDay);

  function update(rows: Row[]): void {
    setDraft({ ...draft, rows });
    setNotice('');
  }

  function add(): void {
    const row = makeRow();
    update([...draft.rows, row]);
    setSelected(row.id);
  }

  function move(offset: number): void {
    const rows = [...draft.rows];
    const target = index + offset;
    [rows[index], rows[target]] = [rows[target], rows[index]];
    update(rows);
  }

  function remove(row: Row): void {
    const remaining = draft.rows.filter((item) => item.id !== row.id);
    update(remaining);
    setSelected((remaining[index] ?? remaining[index - 1])?.id);
    const used = remaining.some(
      (item) =>
        item.mode === 'formula' &&
        item.formula.some((part) => typeof part !== 'string' && part.rowId === row.id),
    );
    if (used) {
      setShownErrors(true);
      setNotice(`Проверьте формулы, которые использовали строку «${row.name}».`);
    }
  }

  function validRows(): boolean {
    setShownErrors(true);
    setNotice('');
    if (!draft.rows.length) {
      setError('Добавьте хотя бы одну строку.');
      return false;
    }
    if (errors.size) {
      setSelected(errors.keys().next().value);
      setError('Проверьте настройки выделенных строк.');
      return false;
    }
    return true;
  }

  function save(): void {
    setError('');
    if (!draft.name.trim()) {
      setError('Введите название хостела.');
      return;
    }
    if (!validRows()) return;
    const values = Object.fromEntries(
      Object.entries(draft.values).filter(([id]) => draft.rows.some((row) => row.id === id)),
    );
    onSave({ ...draft, name: draft.name.trim(), values });
  }

  function saveTemplate(): void {
    setError('');
    const name = templateName?.trim();
    if (!name) {
      setError('Введите название шаблона.');
      return;
    }
    if (
      templates.some((item) => item.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))
    ) {
      setError('Шаблон с таким названием уже есть.');
      return;
    }
    if (!validRows()) return;
    onTemplateSave({ id: demoId(), name, dormitory: draft.dormitory, rows: draft.rows });
    setTemplateName(null);
    setNotice(`Шаблон «${name}» сохранён и доступен в обоих общежитиях.`);
  }

  return (
    <Modal
      title={creating ? 'Добавить хостел' : 'Настроить хостел'}
      testId="hostel-preview-builder"
      panelClassName={styles.builderPanel}
      onClose={onClose}
      dirty={draft !== hostel || templateName !== null}
    >
      <div className={styles.builderTop}>
        <label className={styles.field}>
          Название хостела
          <input
            value={draft.name}
            maxLength={100}
            placeholder="Например, Восточный корпус"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        {creating && (
          <label className={styles.field}>
            Загрузить строки из шаблона
            <select
              value=""
              onChange={(event) => {
                const template = templates.find((item) => item.id === event.target.value);
                if (!template) return;
                if (
                  draft.rows.length &&
                  !window.confirm('Заменить текущие строки строками из шаблона?')
                )
                  return;
                update(template.rows);
                setSelected(template.rows[0]?.id);
                setError('');
                setNotice(`Загружен шаблон «${template.name}».`);
              }}
            >
              <option value="">Выбрать шаблон</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className={styles.editGrid}>
        <section className={styles.rowList} aria-label="Строки хостела">
          <header>
            <h3>
              Строки <small>{draft.rows.length}</small>
            </h3>
            <button type="button" className={outline} onClick={add}>
              + Строка
            </button>
          </header>
          <ol>
            {draft.rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className={styles.pickRow}
                  aria-pressed={row.id === selected}
                  onClick={() => setSelected(row.id)}
                >
                  <ModeMark mode={row.mode} />
                  <span>{row.name.trim() || 'Новая строка'}</span>
                  {shownErrors && errors.has(row.id) && (
                    <b className={styles.rowError} aria-label="Ошибка">
                      !
                    </b>
                  )}
                </button>
              </li>
            ))}
          </ol>
          {!draft.rows.length && (
            <p className={styles.fieldHint}>Добавьте строку или выберите шаблон.</p>
          )}
        </section>

        <section className={styles.inspector} aria-label="Настройки выбранной строки">
          {active ? (
            <>
              <header>
                <h3>Настройки строки</h3>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.iconButton}
                    title="Выше"
                    aria-label="Переместить строку выше"
                    disabled={index === 0}
                    onClick={() => move(-1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={styles.iconButton}
                    title="Ниже"
                    aria-label="Переместить строку ниже"
                    disabled={index === draft.rows.length - 1}
                    onClick={() => move(1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={styles.iconButton}
                    title="Убрать строку"
                    aria-label="Убрать строку"
                    onClick={() => remove(active)}
                  >
                    <WorkspaceIcon name="trash" />
                  </button>
                </div>
              </header>
              <RowSettings
                row={active}
                rows={draft.rows}
                change={(patch) =>
                  update(
                    draft.rows.map((row) => (row.id === active.id ? { ...row, ...patch } : row)),
                  )
                }
              />
              {shownErrors && errors.has(active.id) && (
                <p className={styles.error} role="alert">
                  {errors.get(active.id)}
                </p>
              )}
              <div className={styles.readout}>
                <span>Значение за {sampleDay} ноября</span>
                <strong>{cells.get(active.id)?.value ?? '—'}</strong>
                {cells.get(active.id)?.error && !errors.has(active.id) && (
                  <small>{cells.get(active.id)?.error}</small>
                )}
              </div>
            </>
          ) : (
            <div className={styles.inspectorEmpty}>
              <WorkspaceIcon name="document" />
              <h3>Настройки строки</h3>
              <p>Выберите строку, чтобы задать способ заполнения.</p>
            </div>
          )}
        </section>
      </div>

      {templateName !== null && (
        <div className={styles.templateForm}>
          <label className={styles.field}>
            Название шаблона
            <input
              autoFocus
              value={templateName}
              maxLength={100}
              onChange={(event) => setTemplateName(event.target.value)}
            />
          </label>
          <button type="button" className={outline} onClick={() => setTemplateName(null)}>
            Свернуть
          </button>
          <button type="button" className={primary} onClick={saveTemplate}>
            Сохранить шаблон
          </button>
        </div>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <footer className={styles.builderFoot}>
        <button
          type="button"
          className={outline}
          onClick={() => {
            setError('');
            setTemplateName(draft.name.trim());
          }}
          disabled={!draft.rows.length || templateName !== null}
        >
          <WorkspaceIcon name="document" /> Сохранить как шаблон
        </button>
        <div>
          <ModalCancelButton className={outline} />
          <button type="button" className={primary} onClick={save}>
            {creating ? 'Создать хостел' : 'Сохранить изменения'}
          </button>
        </div>
      </footer>
    </Modal>
  );
}

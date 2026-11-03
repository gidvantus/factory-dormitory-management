import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { WorkspaceIcon } from '../../workspace/WorkspaceIcon';
import {
  cellValue,
  columnError,
  configureColumn,
  formatValue,
  initialDemo,
  kindNames,
  modeNames,
  newColumn,
  selectRecord,
  updateSource,
} from './model';
import type { Column, Demo, FillMode, Kind, Row } from './model';
import s from './Cells.module.css';

function LinkMark(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d="m9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1" />
    </svg>
  );
}

export function CellFillPreview(): JSX.Element {
  const [demo, setDemo] = useState(initialDemo);
  const [selectedId, setSelectedId] = useState('checkin');
  const [editing, setEditing] = useState(true);
  const [showSource, setShowSource] = useState(false);
  const [sourceId, setSourceId] = useState('residents');
  const [notice, setNotice] = useState('');
  const nextId = useRef(1);
  const column = demo.columns.find((item) => item.id === selectedId)!;
  const invalid = !demo.name.trim() || demo.columns.some((item) => columnError(demo, item));

  useEffect(() => {
    const previous = document.title;
    document.title = 'Заполнение ячеек — тест конструктора — Домовой';
    return () => {
      document.title = previous;
    };
  }, []);

  function change(update: (current: Demo) => Demo): void {
    setDemo(update);
    setNotice('');
  }
  function patchColumn(patch: Partial<Column>): void {
    change((current) => configureColumn(current, column.id, patch));
  }
  function reset(): void {
    setDemo(initialDemo());
    setSelectedId('checkin');
    setEditing(true);
    setShowSource(false);
    setSourceId('residents');
    setNotice('Исходный пример восстановлен.');
  }

  return (
    <div className={s.page}>
      <header className={s.header}>
        <Link className={s.brand} to="/preview/constructors-organized?section=table">
          <span>
            <WorkspaceIcon name="house" />
          </span>
          Домовой
        </Link>
        <span className={s.testBadge}>Тестовая страница</span>
        <Link className={s.back} to="/preview/constructors-organized?section=table">
          Все конструкторы
        </Link>
      </header>
      <main className={s.main}>
        <div className={s.breadcrumb}>
          Общежития <span>/</span> Учебное общежитие <span>/</span> Конструктор
        </div>
        <div className={s.heading}>
          <div>
            <h1>Как заполняются ячейки</h1>
            <p>Свяжите столбцы с другой таблицей — данные нужного человека подставятся сами.</p>
          </div>
          <button type="button" className="btn btn--outline btn--sm" onClick={reset}>
            Сбросить пример
          </button>
        </div>
        <div className={s.demoNote}>
          <WorkspaceIcon name="info" />
          <span>
            Все люди и таблицы в примере вымышлены. Изменения действуют до перезагрузки страницы.
          </span>
        </div>
        {notice && (
          <p role="status" className={s.notice}>
            {notice}
          </p>
        )}
        <div className={`${s.layout} ${!editing ? s.resultOnly : ''}`}>
          {editing && (
            <aside className={s.builder} aria-label="Конструктор подвкладки">
              <div className={s.panelHeading}>
                <div>
                  <h2>Конструктор подвкладки</h2>
                  <p>Столбцы и правила заполнения</p>
                </div>
                <WorkspaceIcon name="document" />
              </div>
              <div className={s.settings}>
                <label className={s.field}>
                  Название подвкладки
                  <input
                    value={demo.name}
                    maxLength={60}
                    onChange={(event) =>
                      change((current) => ({ ...current, name: event.target.value }))
                    }
                  />
                </label>
                <div className={s.columnsHeading}>
                  <h3>
                    Столбцы <span>{demo.columns.length}</span>
                  </h3>
                  <button
                    type="button"
                    className={s.textButton}
                    onClick={() => {
                      const id = `column-${nextId.current++}`;
                      change((current) => ({
                        ...current,
                        columns: [
                          ...current.columns,
                          newColumn(id, `Столбец ${current.columns.length + 1}`),
                        ],
                      }));
                      setSelectedId(id);
                    }}
                  >
                    + Добавить столбец
                  </button>
                </div>
                <div className={s.columnList} aria-label="Столбцы таблицы">
                  {demo.columns.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={item.id === selectedId}
                      className={s.columnButton}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <span className={s.typeIcon} aria-hidden="true">
                        {item.kind === 'date' ? '▦' : item.kind === 'number' ? '#' : 'Аа'}
                      </span>
                      <span className={s.columnName}>
                        {item.name || 'Без названия'}
                        {columnError(demo, item) && (
                          <small className={s.error}>Проверьте настройку</small>
                        )}
                      </span>
                      <span className={item.mode === 'manual' ? s.manualTag : s.linkTag}>
                        {item.mode !== 'manual' && <LinkMark />}
                        {modeNames[item.mode]}
                      </span>
                      <span className={s.chevron} aria-hidden="true">
                        ›
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <ColumnSettings
                demo={demo}
                column={column}
                patch={patchColumn}
                remove={() => {
                  change((current) => ({
                    ...current,
                    columns: current.columns.filter((item) => item.id !== column.id),
                  }));
                  setSelectedId(demo.columns.find((item) => item.id !== column.id)!.id);
                }}
              />
              <div className={s.apply}>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={Boolean(invalid)}
                  onClick={() => {
                    setEditing(false);
                    setNotice(
                      'Настройки применены в тестовом примере. Теперь попробуйте заполнить таблицу.',
                    );
                  }}
                >
                  Применить настройки
                </button>
                <small>Предпросмотр меняется сразу</small>
              </div>
            </aside>
          )}
          <section className={s.preview} aria-label="Предпросмотр подвкладки">
            <div className={s.previewLabel}>
              <span className={s.liveDot} />
              {editing ? 'Предпросмотр' : 'Готовая подвкладка'}
              <span>Попробуйте заполнить строку</span>
            </div>
            <div className={s.workspace}>
              <div className={s.workspaceHeading}>
                <div>
                  <p>Учебное общежитие</p>
                  <h2>{demo.name || 'Новая подвкладка'}</h2>
                </div>
                <button
                  type="button"
                  className="btn btn--outline btn--sm"
                  aria-pressed={editing}
                  onClick={() => setEditing(!editing)}
                >
                  {editing ? 'Скрыть настройки' : 'Настроить подвкладку'}
                </button>
              </div>
              <div className={s.relation}>
                <span className={s.relationIcon}>
                  <LinkMark />
                </span>
                <p>
                  <strong>Один человек — одна связанная строка</strong>
                  <span>Выберите ФИО. Связанные ячейки получат данные из выбранной записи.</span>
                </p>
              </div>
              <div className={s.tableWrap}>
                <table className={s.table} aria-label={demo.name || 'Предпросмотр таблицы'}>
                  <thead>
                    <tr>
                      <th scope="col" className={s.rowNumber}>
                        №
                      </th>
                      {demo.columns.map((item) => (
                        <th scope="col" key={item.id}>
                          <span>{item.name || 'Без названия'}</span>
                          <small className={item.mode === 'manual' ? '' : s.linkedLabel}>
                            {item.mode !== 'manual' && <LinkMark />}
                            {item.mode === 'lookup'
                              ? item.update === 'live'
                                ? 'Автозаполнение'
                                : 'Разовая копия'
                              : modeNames[item.mode]}
                          </small>
                        </th>
                      ))}
                      <th scope="col">
                        <span className={s.srOnly}>Действия</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {demo.rows.map((row, index) => (
                      <tr key={row.id}>
                        <td className={s.rowNumber}>{index + 1}</td>
                        {demo.columns.map((item) => (
                          <td key={item.id} className={item.mode === 'lookup' ? s.linkedCell : ''}>
                            <PreviewCell
                              demo={demo}
                              column={item}
                              row={row}
                              index={index}
                              change={change}
                            />
                          </td>
                        ))}
                        <td>
                          <button
                            className={s.deleteRow}
                            type="button"
                            aria-label={`Удалить строку ${index + 1}`}
                            onClick={() =>
                              change((current) => ({
                                ...current,
                                rows: current.rows.filter((item) => item.id !== row.id),
                              }))
                            }
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!demo.rows.length && (
                  <p className={s.empty}>
                    Добавьте строку и выберите человека, чтобы увидеть заполнение.
                  </p>
                )}
              </div>
              <div className={s.tableFooter}>
                <button
                  type="button"
                  className={s.textButton}
                  onClick={() =>
                    change((current) => ({
                      ...current,
                      rows: [
                        ...current.rows,
                        { id: `added-${nextId.current++}`, selected: {}, manual: {}, copies: {} },
                      ],
                    }))
                  }
                >
                  + Добавить строку
                </button>
                <span>Строк: {demo.rows.length}</span>
              </div>
              <div className={s.legend}>
                <span>
                  <i className={s.linkedSwatch} />
                  Из таблицы-источника
                </span>
                <span>
                  <i />
                  Ручной ввод
                </span>
              </div>
            </div>
            <section className={s.sourcePanel} aria-label="Проверка источника">
              <button
                type="button"
                className={s.sourceToggle}
                aria-expanded={showSource}
                aria-controls="cell-demo-source"
                onClick={() => setShowSource(!showSource)}
              >
                <span>
                  <WorkspaceIcon name="document" />
                  <strong>Таблица-источник</strong>
                  <small>Измените данные и проверьте связь</small>
                </span>
                <span aria-hidden="true">{showSource ? '−' : '+'}</span>
              </button>
              {showSource && (
                <div id="cell-demo-source" className={s.sourceContent}>
                  <label className={s.field}>
                    Показать таблицу
                    <select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
                      {demo.sources.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.path} / {source.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className={s.sourceHint}>
                    Поменяйте дату ниже. При постоянной связи она обновится в подвкладке, при
                    разовом копировании останется прежней.
                  </p>
                  <SourceTable demo={demo} sourceId={sourceId} change={change} />
                </div>
              )}
            </section>
            <p className={s.exampleHint}>
              Например: «ФИО» — выбор из «Проживающих», «Дата заселения» — из той же записи, даты
              отпуска — вручную.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}

function ColumnSettings({
  demo,
  column,
  patch,
  remove,
}: {
  demo: Demo;
  column: Column;
  patch: (value: Partial<Column>) => void;
  remove: () => void;
}): JSX.Element {
  const source = demo.sources.find((item) => item.id === column.sourceId)!;
  const matching = demo.columns.filter(
    (item) => item.id !== column.id && item.mode === 'pick' && item.sourceId === column.sourceId,
  );
  const fields = source.fields.filter((item) => item.kind === column.kind);
  const dependent = demo.columns.find(
    (item) => item.mode === 'lookup' && item.matchColumnId === column.id,
  );
  const error = columnError(demo, column);

  function changeSource(id: string): void {
    const target = demo.sources.find((item) => item.id === id)!;
    patch({
      sourceId: id,
      fieldId: target.fields.find((item) => item.kind === column.kind)?.id ?? '',
      matchColumnId:
        demo.columns.find(
          (item) => item.mode === 'pick' && item.sourceId === id && item.id !== column.id,
        )?.id ?? '',
    });
  }
  return (
    <div className={s.columnSettings} aria-label={`Настройки столбца ${column.name}`}>
      <div className={s.editorTitle}>
        <h3>{column.name || 'Новый столбец'}</h3>
        <span>{kindNames[column.kind]}</span>
      </div>
      <div className={s.twoFields}>
        <label className={s.field}>
          Название столбца
          <input
            value={column.name}
            maxLength={60}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </label>
        <label className={s.field}>
          Тип данных
          <select
            value={column.kind}
            onChange={(event) => {
              const kind = event.target.value as Kind;
              patch({
                kind,
                mode: column.mode === 'pick' && kind !== 'text' ? 'manual' : column.mode,
                fieldId: source.fields.find((item) => item.kind === kind)?.id ?? '',
              });
            }}
          >
            {Object.entries(kindNames).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className={s.modeGroup}>
        <legend>Как заполнять ячейки</legend>
        <div className={s.modeOptions}>
          {(Object.keys(modeNames) as FillMode[])
            .filter((mode) => mode !== 'pick' || column.kind === 'text')
            .map((mode) => (
              <label key={mode} className={column.mode === mode ? s.modeSelected : ''}>
                <input
                  type="radio"
                  name={`mode-${column.id}`}
                  value={mode}
                  checked={column.mode === mode}
                  onChange={() => patch({ mode })}
                />
                <span>{modeNames[mode]}</span>
              </label>
            ))}
        </div>
      </fieldset>
      {column.mode === 'manual' ? (
        <p className={s.help}>
          Значение вводится отдельно в каждой строке. Другие таблицы на него не влияют.
        </p>
      ) : (
        <div className={s.bindingFields}>
          <label className={s.field}>
            Таблица-источник
            <select value={column.sourceId} onChange={(event) => changeSource(event.target.value)}>
              {demo.sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.path} / {item.name}
                </option>
              ))}
            </select>
          </label>
          {column.mode === 'pick' ? (
            <p className={s.help}>
              В ячейке появится список людей из этой таблицы. Другая ячейка сможет взять данные
              выбранного человека. Одинаковые ФИО различаются по табельному номеру.
            </p>
          ) : (
            <>
              <div className={s.twoFields}>
                <label className={s.field}>
                  Взять значение из столбца
                  <select
                    value={fields.some((item) => item.id === column.fieldId) ? column.fieldId : ''}
                    onChange={(event) => patch({ fieldId: event.target.value })}
                  >
                    <option value="" disabled>
                      Выберите столбец
                    </option>
                    {fields.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={s.field}>
                  Человека выбрать в столбце
                  <select
                    value={
                      matching.some((item) => item.id === column.matchColumnId)
                        ? column.matchColumnId
                        : ''
                    }
                    onChange={(event) => patch({ matchColumnId: event.target.value })}
                  >
                    <option value="" disabled>
                      Выберите столбец
                    </option>
                    {matching.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {!matching.length && (
                <p className={s.help}>
                  Добавьте столбец типа «Текст» со способом «Выбор записи» из таблицы «{source.name}
                  ».
                </p>
              )}
              <div className={s.rule}>
                <LinkMark />
                <span>
                  {matching.find((item) => item.id === column.matchColumnId)?.name ||
                    'Выбор человека'}
                  <b> → </b>
                  {source.name}
                  <b> → </b>
                  {fields.find((item) => item.id === column.fieldId)?.name || 'Значение'}
                </span>
              </div>
              <fieldset className={s.updateGroup}>
                <legend>Если данные в источнике изменятся</legend>
                <label>
                  <input
                    type="radio"
                    name={`update-${column.id}`}
                    checked={column.update === 'live'}
                    onChange={() => patch({ update: 'live' })}
                  />
                  <span>
                    <strong>Обновлять автоматически</strong>
                    <small>Ячейка всегда показывает актуальное значение.</small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name={`update-${column.id}`}
                    checked={column.update === 'copy'}
                    onChange={() => patch({ update: 'copy' })}
                  />
                  <span>
                    <strong>Скопировать один раз</strong>
                    <small>Значение фиксируется при выборе человека.</small>
                  </span>
                </label>
              </fieldset>
              <p className={s.help}>
                Связанная ячейка заполняется по выбранной записи, даже если у людей одинаковые ФИО.
                Пустое значение в источнике остаётся пустым.
              </p>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      <div className={s.removeColumn}>
        <button
          type="button"
          className={s.textButton}
          disabled={demo.columns.length < 2 || Boolean(dependent)}
          onClick={remove}
        >
          Убрать столбец из примера
        </button>
        {dependent && <small>Используется в столбце «{dependent.name}».</small>}
      </div>
    </div>
  );
}

function PreviewCell({
  demo,
  column,
  row,
  index,
  change,
}: {
  demo: Demo;
  column: Column;
  row: Row;
  index: number;
  change: (update: (current: Demo) => Demo) => void;
}): JSX.Element {
  const label = `${column.name}, строка ${index + 1}`;
  if (column.mode === 'pick') {
    const source = demo.sources.find((item) => item.id === column.sourceId)!;
    return (
      <select
        aria-label={label}
        value={row.selected[column.id] ?? ''}
        onChange={(event) =>
          change((current) => selectRecord(current, row.id, column.id, event.target.value))
        }
      >
        <option value="">Выберите человека</option>
        {source.records.map((record) => (
          <option value={record.id} key={record.id}>
            {record.values.full_name} · Т/н {record.values.number}
          </option>
        ))}
      </select>
    );
  }
  if (column.mode === 'lookup') {
    const error = columnError(demo, column);
    const value = cellValue(demo, row, column);
    return (
      <span
        className={s.autoValue}
        aria-label={label}
        title={
          error ||
          (column.update === 'live'
            ? 'Обновляется из таблицы-источника'
            : 'Копия на момент выбора человека')
        }
      >
        <LinkMark />
        {error
          ? 'Настройте связь'
          : value
            ? formatValue(value, column.kind)
            : row.selected[column.matchColumnId]
              ? 'Не заполнено'
              : 'Выберите человека'}
      </span>
    );
  }
  return (
    <input
      aria-label={label}
      type={column.kind === 'date' ? 'date' : column.kind === 'number' ? 'number' : 'text'}
      value={row.manual[column.id] ?? ''}
      placeholder="Введите значение"
      onChange={(event) =>
        change((current) => ({
          ...current,
          rows: current.rows.map((item) =>
            item.id !== row.id
              ? item
              : { ...item, manual: { ...item.manual, [column.id]: event.target.value } },
          ),
        }))
      }
    />
  );
}

function SourceTable({
  demo,
  sourceId,
  change,
}: {
  demo: Demo;
  sourceId: string;
  change: (update: (current: Demo) => Demo) => void;
}): JSX.Element {
  const source = demo.sources.find((item) => item.id === sourceId)!;
  return (
    <div className={s.tableWrap}>
      <table className={`${s.table} ${s.sourceTable}`} aria-label={`Источник: ${source.name}`}>
        <thead>
          <tr>
            {source.fields.map((field) => (
              <th scope="col" key={field.id}>
                {field.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {source.records.map((record) => (
            <tr key={record.id}>
              {source.fields.map((field) => (
                <td key={field.id}>
                  {field.kind === 'date' ? (
                    <input
                      type="date"
                      aria-label={`${field.name}, ${record.values.full_name}, Т/н ${record.values.number}`}
                      value={record.values[field.id] ?? ''}
                      onChange={(event) =>
                        change((current) =>
                          updateSource(current, sourceId, record.id, field.id, event.target.value),
                        )
                      }
                    />
                  ) : (
                    record.values[field.id]
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import type { EditorSnapshot } from '../../components/EditorSurface';
import type { ColumnInput, ReportLink, ReportRow, TableKey } from '../../api/client';
import type { Block } from '../../api/personnel';
import type { WidgetConfig } from '../../api/dashboardBlocks';
import { WidgetChart } from '../../workspace/dashboard/WidgetChart';
import { PersonnelWorkspaceBlock } from '../../workspace/personnel/PersonnelWorkspaceBlock';
import { calculate } from './formula';
import { dates, RANGE, Sandbox } from './store';
import type { Scene } from './inventory';
import s from './Sandbox.module.css';

const formatted = (value: number): string =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(value);
export function TablePreview({
  store,
  dorm,
  table,
  inputs,
}: {
  store: Sandbox;
  dorm: string;
  table: TableKey;
  inputs?: ColumnInput[];
}): JSX.Element {
  const columns =
    inputs ??
    store.columns(dorm, table).filter((column) => !column.archived && column.kind !== 'action');
  const records = store.dorm(dorm).records[table] ?? [];
  return (
    <div className={s.scroll}>
      <table className={s.table}>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index}>
                {column.name || 'Без названия'}
                <small>
                  {
                    {
                      text: 'Текст',
                      number: 'Число',
                      date: 'Дата',
                      checkbox: 'Чекбокс',
                      select: 'Список',
                      hostel: 'Хостел',
                      action: 'Действие',
                    }[column.kind]
                  }
                </small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[0, 1, 2].map((index) => (
            <tr key={index}>
              {columns.map((column, n) => {
                const saved =
                  'id' in column ? records[index]?.values[String(column.id)] : undefined;
                const value =
                  saved === undefined
                    ? column.kind === 'number'
                      ? [1200, 2400, 3600][index]
                      : column.kind === 'date'
                        ? ['2026-10-29', '2026-10-30', '2026-10-31'][index]
                        : column.kind === 'checkbox'
                          ? index % 2 === 0
                          : column.kind === 'select'
                            ? (column.options.find((option) => !option.archived)?.id ??
                              column.options.find((option) => !option.archived)?.label)
                            : ['Иванов Алексей', 'Петрова Анна', 'Соколов Игорь'][index]
                    : saved;
                return (
                  <td key={n}>
                    {column.kind === 'select'
                      ? (column.options.find((option) => option.id === value)?.label ??
                        column.options.find((option) => !option.archived)?.label ??
                        'Нет вариантов')
                      : typeof value === 'boolean'
                        ? value
                          ? '☑ Да'
                          : '☐ Нет'
                        : String(value ?? '—')}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {columns.length === 0 && (
        <p className={s.note}>Добавьте столбец — здесь появится пример ячейки выбранного типа.</p>
      )}
    </div>
  );
}

export function LivePreview({
  store,
  scene,
  dorm,
  table,
  snapshot,
  form,
  rowId,
}: {
  store: Sandbox;
  scene: Scene;
  dorm: string;
  table: TableKey;
  snapshot: EditorSnapshot | null;
  form: Record<string, string>;
  rowId: number | null;
}): JSX.Element {
  const value = snapshot?.value;
  if (snapshot?.kind === 'structure') {
    const draft = value as {
      selected: string;
      nodes: { key: string; name: string; status: string }[];
      columns: ColumnInput[];
    };
    if (draft.selected === 'report')
      return (
        <LivePreview
          store={store}
          scene="report"
          dorm={dorm}
          table={table}
          snapshot={null}
          form={form}
          rowId={null}
        />
      );
    return (
      <>
        <h2>
          {draft.nodes.find((node) => node.key === draft.selected)?.name ?? 'Результат структуры'}
        </h2>
        <p className={s.note}>
          Названия, порядок и варианты столбцов показаны по текущему черновику.
        </p>
        {draft.columns.length > 0 ? (
          <TablePreview
            store={store}
            dorm={dorm}
            table={draft.selected as TableKey}
            inputs={draft.columns.filter((column) => !('archived' in column && column.archived))}
          />
        ) : (
          <p className={s.note}>
            Состав разделов и вложенных вкладок показан ниже. Для предпросмотра столбцов выберите
            таблицу.
          </p>
        )}
        <h3>Состав вкладок</h3>
        <div className={s.pills}>
          {draft.nodes
            .filter((node) => node.status !== 'deleted')
            .map((node) => (
              <span key={node.key}>
                {node.name}
                {node.status === 'hidden' ? ' · скрыта' : ''}
              </span>
            ))}
        </div>
      </>
    );
  }
  if (['report', 'formula', 'links', 'places'].includes(scene) && snapshot?.kind !== 'report-row') {
    const report = store.report(dorm, RANGE.from, RANGE.to);
    const days = dates(RANGE.from, RANGE.to).slice(-3);
    return (
      <>
        <h2>Общий отчёт после сохранения</h2>
        <div className={s.scroll}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Строка</th>
                {days.map((day) => (
                  <th key={day}>{day.slice(8)} октября</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.name}</th>
                  {days.map((day) => (
                    <td key={day}>{row.errors[day] ?? row.values[day] ?? '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  if (snapshot?.kind === 'report-row') {
    const draft = value as { name: string; mode: string; formula: string; link: ReportLink | null };
    const rows = store.dorm(dorm).rows;
    const target: ReportRow = {
      ...(rows.find((row) => row.id === rowId) ?? {
        id: -1,
        position: rows.length,
        values: {},
        errors: {},
      }),
      name: draft.name || 'Новая строка',
      formula: draft.mode === 'formula' ? draft.formula : null,
      link: draft.mode === 'link' ? draft.link : null,
    };
    const selected = rows.some((row) => row.id === target.id)
      ? rows.map((row) => (row.id === target.id ? target : row))
      : [...rows, target];
    function rowValue(row: ReportRow, date: string, path = new Set<number>()): number {
      if (path.has(row.id)) throw new Error('Циклическая ссылка');
      if (row.link) return store.linkValue(dorm, row.link, date);
      if (!row.formula) return Number(row.values[date] || 0);
      return calculate(row.formula, (name) => {
        const reference = selected.find((item) => item.name === name);
        if (!reference) throw new Error(`Строка «${name}» не найдена`);
        return rowValue(reference, date, new Set([...path, row.id]));
      });
    }
    const days = dates(RANGE.from, RANGE.to).slice(-3);
    return (
      <>
        <h2>{target.name}</h2>
        {draft.mode === 'formula' && <code className={s.formula}>{draft.formula}</code>}
        <div className={s.scroll}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Строка отчёта</th>
                {days.map((date) => (
                  <th key={date}>{date.slice(8)} октября</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {selected.map((row) => (
                <tr key={row.id} data-result={row.id === target.id}>
                  <th scope="row">{row.name}</th>
                  {days.map((date) => {
                    try {
                      return <td key={date}>{formatted(rowValue(row, date))}</td>;
                    } catch (error) {
                      return (
                        <td className={s.error} key={date}>
                          {error instanceof Error ? error.message : 'Ошибка'}
                        </td>
                      );
                    }
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={s.note}>
          {draft.mode === 'manual'
            ? 'Строка заполняется вручную за каждую дату в общем отчёте.'
            : draft.mode === 'link'
              ? 'Каждая подходящая запись даёт 1. Распределение по датам задано в связи.'
              : 'Все действия и скобки рассчитываются для каждой даты. Ошибки показаны рядом с результатом.'}
        </p>
      </>
    );
  }
  if (snapshot?.kind === 'column') {
    const column = value as ColumnInput;
    return (
      <>
        <h2>Так будут выглядеть ячейки</h2>
        <TablePreview store={store} dorm={dorm} table={table} inputs={[column]} />
      </>
    );
  }
  if (snapshot?.kind === 'create-table') {
    const data = value as { columns: ColumnInput[] };
    return (
      <>
        <h2>Новая таблица</h2>
        <TablePreview store={store} dorm={dorm} table={table} inputs={data.columns} />
      </>
    );
  }
  if (snapshot?.kind === 'create-tab') {
    const draft = value as {
      name: string;
      mode: string;
      sourceId: string;
      withSubtabs: boolean;
      subtabs: string[];
      options: {
        table_format: string;
        period_mode: string;
        add_row: boolean;
        clear_list: boolean;
        row_actions: boolean;
        show_dates: boolean;
      };
    };
    const sourceDorm = store.dorms.find((item) =>
      item.settings.tabs.some((tab) => tab.id === Number(draft.sourceId)),
    );
    const source = sourceDorm?.settings.tabs.find((tab) => tab.id === Number(draft.sourceId));
    return (
      <>
        <h2>{draft.name || 'Новая вкладка'}</h2>
        {draft.mode === 'template' ? (
          source && sourceDorm ? (
            <>
              <p className={s.note}>
                По образцу «{sourceDorm.info.name} / {source.name}», с новыми идентификаторами и без
                записей.
              </p>
              <TablePreview
                store={store}
                dorm={String(sourceDorm.info.id)}
                table={source.table_key}
              />
            </>
          ) : (
            <p>Выберите вкладку-образец слева.</p>
          )
        ) : (
          <>
            <div className={s.settingsSummary}>
              <span>
                Формат
                <strong>
                  {draft.options.table_format === 'calendar' ? 'Дни в столбцах' : 'Список записей'}
                </strong>
              </span>
              <span>
                Период
                <strong>
                  {
                    { none: 'За всё время', range: 'Диапазон дат', month: 'По месяцам' }[
                      draft.options.period_mode
                    ]
                  }
                </strong>
              </span>
            </div>
            {draft.withSubtabs && (
              <ul>
                {draft.subtabs.map((name, index) => (
                  <li key={index}>{name || 'Новая подвкладка'}</li>
                ))}
              </ul>
            )}
            <p className={s.note}>
              После создания вкладки можно создать её таблицу. Кнопки:{' '}
              {[
                draft.options.add_row && 'Добавить строку',
                draft.options.clear_list && 'Очистить список',
                draft.options.row_actions && 'Удалить строку',
              ]
                .filter(Boolean)
                .join(', ') || 'не включены'}
              .
            </p>
            {draft.options.table_format === 'calendar' && (
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Показатель</th>
                    <th>29 окт.</th>
                    <th>30 окт.</th>
                    <th>31 окт.</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th>Ваш показатель</th>
                    <td>0</td>
                    <td>0</td>
                    <td>0</td>
                  </tr>
                </tbody>
              </table>
            )}
          </>
        )}
      </>
    );
  }
  if (snapshot?.kind === 'dashboard-block') {
    const config = value as WidgetConfig;
    const result = store.widget(config, RANGE.from, RANGE.to);
    return (
      <>
        <h2>{config.name || 'Новый блок'}</h2>
        <p className={s.note}>
          {RANGE.from} — {RANGE.to}
        </p>
        {config.display === 'chart' ? (
          <WidgetChart name={config.name} result={result} range={RANGE} />
        ) : config.display === 'number' ? (
          <strong className={s.bigNumber}>
            {result.value === null ? '—' : formatted(result.value)}
          </strong>
        ) : (
          <ul className={s.valueList}>
            {result.items.map((item) => (
              <li key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value === null ? '—' : formatted(item.value)}</strong>
              </li>
            ))}
          </ul>
        )}
        {result.errors.map((message) => (
          <p className={s.error} key={message}>
            {message}
          </p>
        ))}
        <p className={s.note}>
          {config.period === 'snapshot' ? 'Срез на последнюю дату.' : 'Расчёт за период.'} Источник
          и общежития задаются в полном редакторе слева.
        </p>
      </>
    );
  }
  if (snapshot?.kind === 'personnel-block') {
    const original = value as Block;
    const block = {
      ...original,
      title: form.title ?? original.title,
      days: Number(form.days ?? original.days),
      limit: Number(form.limit ?? original.limit),
    };
    return (
      <>
        <h2>Блок рабочей поверхности</h2>
        <PersonnelWorkspaceBlock
          block={block}
          data={store.personnel}
          dormitory={null}
          configuring={false}
          busy={false}
          first
          last
          onPerson={() => undefined}
          onList={() => undefined}
          onPlanning={() => undefined}
          onEdit={() => undefined}
          onMove={() => undefined}
          onRemove={() => undefined}
        />
        <p className={s.note}>
          {block.wide ? 'Блок займёт всю ширину.' : 'Блок займёт одну колонку.'} До {block.limit}{' '}
          строк.
        </p>
      </>
    );
  }
  if (snapshot?.kind === 'binding') {
    const fields = (value as { fields: Record<string, number> }).fields;
    return (
      <>
        <h2>Связь с карточкой сотрудника</h2>
        <dl className={s.mapping}>
          {Object.entries({
            full_name: 'ФИО',
            personnel_number: 'Табельный номер',
            phone: 'Телефон',
            shift_start: 'Начало вахты',
            shift_end: 'Окончание вахты',
            reason: 'Причина / статус',
          }).map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                {store.columns(dorm, table).find((column) => column.id === fields[key])?.name ??
                  'Не используется'}
              </dd>
            </div>
          ))}
        </dl>
        <p className={s.note}>
          После привязки существующие заполненные строки получат статус «Требует проверки».
          Совпадения объединяются вручную.
        </p>
      </>
    );
  }
  if (scene === 'dashboard')
    return (
      <>
        <h2>Сохранённые блоки</h2>
        {store.layout.blocks
          .filter((block) => !store.layout.hidden.includes(`custom:${block.id}`))
          .map((block) => (
            <LivePreview
              key={block.id}
              store={store}
              scene={scene}
              dorm={dorm}
              table={table}
              snapshot={{ kind: 'dashboard-block', value: block.config }}
              form={{}}
              rowId={null}
            />
          ))}
        <p className={s.note}>Добавьте или настройте блок слева, чтобы проверить его черновик.</p>
      </>
    );
  if (scene === 'personnel-blocks')
    return (
      <>
        <h2>Рабочая поверхность персонала</h2>
        {(store.personnel.preferences.blocks ?? []).map((block) => (
          <LivePreview
            key={block.id}
            store={store}
            scene={scene}
            dorm={dorm}
            table={table}
            snapshot={{ kind: 'personnel-block', value: block }}
            form={{}}
            rowId={null}
          />
        ))}
      </>
    );
  if (scene === 'report-templates')
    return (
      <>
        <h2>Состав сохранённых шаблонов</h2>
        {store.templates.map((template) => (
          <details key={template.id} open>
            <summary>
              {template.name} · {template.rows.length} строк
            </summary>
            <ul>
              {template.rows.map((row) => (
                <li key={row.name}>
                  {row.name}
                  <small>
                    {row.formula ?? (row.linked ? 'Связь с источником' : 'Ручное заполнение')}
                  </small>
                </li>
              ))}
            </ul>
          </details>
        ))}
        {!store.templates.length && <p>Сохраните шаблон из общего отчёта.</p>}
      </>
    );
  if (scene === 'tabs' || scene === 'create-tab')
    return (
      <>
        <h2>Вкладки тестового общежития</h2>
        <div className={s.pills}>
          {store.dorm(dorm).settings.tabs.map((tab) => (
            <span key={tab.id}>
              {tab.name} · {tab.is_active ? 'видна' : 'скрыта'} ·{' '}
              {tab.table_created ? 'с таблицей' : 'без таблицы'}
            </span>
          ))}
        </div>
        <p className={s.note}>
          Копируются настройки и структура. Записи источника остаются в исходном общежитии.
        </p>
        {scene === 'tabs' && <TablePreview store={store} dorm={dorm} table={table} />}
      </>
    );
  return (
    <>
      <h2>{scene === 'columns' ? 'Текущая таблица' : 'Сохранённый результат'}</h2>
      <TablePreview store={store} dorm={dorm} table={table} />
      <p className={s.note}>
        Выберите действие слева. Здесь появится результат изменения до сохранения.
      </p>
    </>
  );
}

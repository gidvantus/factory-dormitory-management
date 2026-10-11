import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { Modal } from '../components/Modal';
import { WorkspaceIcon } from '../workspace/WorkspaceIcon';
import styles from './StatisticsDesignPreview.module.css';

type Display = 'number' | 'line' | 'bar' | 'area' | 'pie' | 'table';
type Operation = 'sum' | 'average' | 'last' | 'max';
type Metric = { id: string; name: string; base: number };
type Source = { id: string; name: string; metrics: Metric[] };
type Dormitory = { id: string; name: string; client: string; factor: number; phase: number };
type Block = {
  id: string;
  name: string;
  display: Display;
  sourceId: string;
  metricId: string;
  operation: Operation;
  grouping: 'date' | 'dormitory';
  scope: 'all' | 'selected';
  dormitoryIds: string[];
  gender: 'all' | 'male' | 'female';
};
type Report = { id: string; name: string; description: string; personal: boolean; blocks: Block[] };
type DataRow = { dormitory: Dormitory; values: number[]; value: number };
type Result = {
  rows: DataRow[];
  daily: number[];
  total: number;
  days: number;
  availableDays: number;
};
type IconName =
  | 'plus'
  | 'arrow'
  | 'chevron'
  | 'search'
  | 'edit'
  | 'trash'
  | 'check'
  | 'table'
  | 'line'
  | 'bar'
  | 'area'
  | 'pie'
  | 'number'
  | 'layers'
  | 'refresh'
  | 'calendar';

const format = (value: number): string =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
const colors = ['#2f7d62', '#7899bd', '#c49a53', '#9a8abf', '#c77f65'];
const displayNames: Record<Display, string> = {
  number: 'Показатель',
  line: 'Линейный',
  bar: 'Столбчатый',
  area: 'С областями',
  pie: 'Круговая',
  table: 'Сводная таблица',
};
const operations: Record<Operation, string> = {
  sum: 'Сумма за период',
  average: 'Среднее за день',
  last: 'На последнюю дату',
  max: 'Максимум за день',
};
const initialDormitories: Dormitory[] = [
  { id: 'north', name: 'Северное', client: 'Технопром', factor: 1, phase: 0 },
  { id: 'central', name: 'Центральное', client: 'Вектор', factor: 0.79, phase: 1 },
  { id: 'south', name: 'Южное', client: 'Меридиан', factor: 0.61, phase: 2 },
  { id: 'park', name: 'Парковое', client: 'Технопром', factor: 0.47, phase: 3 },
];
const initialSources: Source[] = [
  {
    id: 'report',
    name: 'Большой отчёт',
    metrics: [
      { id: 'attendance', name: 'Выход Итого', base: 138 },
      { id: 'residents', name: 'Проживает Итого', base: 172 },
      { id: 'inflow', name: 'Приток Итого', base: 8 },
      { id: 'outflow', name: 'Отток Итого', base: 5 },
    ],
  },
  {
    id: 'places',
    name: 'Места',
    metrics: [
      { id: 'occupied', name: 'Проживает', base: 172 },
      { id: 'paid', name: 'Оплачено мест', base: 200 },
      { id: 'free', name: 'Свободных мест', base: 28 },
    ],
  },
  {
    id: 'residents',
    name: 'Проживающие',
    metrics: [
      { id: 'people', name: 'Количество записей', base: 172 },
      { id: 'medical', name: 'Есть действующая медкнижка', base: 149 },
    ],
  },
  {
    id: 'inflow',
    name: 'Движение персонала / Приток',
    metrics: [{ id: 'arrivals', name: 'Количество заселений', base: 8 }],
  },
  {
    id: 'outflow',
    name: 'Движение персонала / Отток',
    metrics: [{ id: 'departures', name: 'Количество выездов', base: 5 }],
  },
  {
    id: 'custom-documents',
    name: 'Документы / Проверки',
    metrics: [
      { id: 'checks', name: 'Количество проверок', base: 18 },
      { id: 'issues', name: 'Требуют внимания', base: 3 },
    ],
  },
];

function makeBlock(id: string, name: string, display: Display, extra: Partial<Block> = {}): Block {
  return {
    id,
    name,
    display,
    sourceId: 'report',
    metricId: 'attendance',
    operation: 'sum',
    grouping: 'date',
    scope: 'all',
    dormitoryIds: [],
    gender: 'all',
    ...extra,
  };
}
const initialReports: Report[] = [
  {
    id: 'attendance',
    name: 'Выход персонала',
    description: 'Выход по общежитиям и каждому дню месяца',
    personal: false,
    blocks: [
      makeBlock('total', 'Выходов за период', 'number'),
      makeBlock('average', 'Средний выход в день', 'number', { operation: 'average' }),
      makeBlock('latest', 'Выход на последнюю дату', 'number', { operation: 'last' }),
      makeBlock('daily', 'Динамика выхода', 'line'),
      makeBlock('comparison', 'Выход по общежитиям', 'bar', { grouping: 'dormitory' }),
      makeBlock('matrix', 'Выход по дням месяца', 'table'),
    ],
  },
  {
    id: 'places',
    name: 'Занятость мест',
    description: 'Проживание и свободные места в общежитиях',
    personal: false,
    blocks: [
      makeBlock('occupied-total', 'Всего проживает', 'number', {
        sourceId: 'places',
        metricId: 'occupied',
        operation: 'last',
      }),
      makeBlock('free-total', 'Свободных мест', 'number', {
        sourceId: 'places',
        metricId: 'free',
        operation: 'last',
      }),
      makeBlock('places-pie', 'Проживает по общежитиям', 'pie', {
        sourceId: 'places',
        metricId: 'occupied',
        operation: 'last',
        grouping: 'dormitory',
      }),
      makeBlock('places-table', 'Занятость по дням', 'table', {
        sourceId: 'places',
        metricId: 'occupied',
        operation: 'last',
      }),
    ],
  },
  {
    id: 'movement',
    name: 'Движение персонала',
    description: 'Заселения и выезды за выбранный период',
    personal: true,
    blocks: [
      makeBlock('inflow-total', 'Заселений за период', 'number', {
        sourceId: 'inflow',
        metricId: 'arrivals',
      }),
      makeBlock('outflow-total', 'Выездов за период', 'number', {
        sourceId: 'outflow',
        metricId: 'departures',
      }),
      makeBlock('inflow-chart', 'Динамика заселений', 'area', {
        sourceId: 'inflow',
        metricId: 'arrivals',
      }),
      makeBlock('outflow-chart', 'Выезды по общежитиям', 'bar', {
        sourceId: 'outflow',
        metricId: 'departures',
        grouping: 'dormitory',
      }),
    ],
  },
];

function Icon({ name }: { name: IconName }): JSX.Element {
  const paths: Record<IconName, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="m10 5-7 7 7 7M3 12h18" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    edit: (
      <>
        <path d="m15 4 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14Z" />
      </>
    ),
    trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />,
    check: <path d="m5 12 4 4L19 6" />,
    table: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M3 10h18M3 15h18M10 4v16" />
      </>
    ),
    line: <path d="M3 3v18h18M6 16l5-6 4 3 6-8" />,
    bar: <path d="M3 3v18h18M8 16v-5M13 16V7M18 16v-8" />,
    area: (
      <>
        <path d="M3 3v18h18M6 17v-4l5-6 4 5 6-3v8Z" />
      </>
    ),
    pie: (
      <>
        <path d="M12 3v9h9A9 9 0 0 0 12 3Z" />
        <path d="M8 4a9 9 0 1 0 12 12H8Z" />
      </>
    ),
    number: <path d="M9 3 7 21M17 3l-2 18M4 9h17M3 15h17" />,
    layers: <path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5" />,
    refresh: <path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-2l2 3M4 16l2 3a8 8 0 0 0 13-2" />,
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M7 3v4M17 3v4M3 11h18" />
      </>
    ),
  };
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function aggregate(values: number[], operation: Operation): number {
  if (!values.length) return 0;
  if (operation === 'last') return values[values.length - 1];
  if (operation === 'max') return Math.max(...values);
  const sum = values.reduce((a, b) => a + b, 0);
  return operation === 'average' ? sum / values.length : sum;
}

function calculate(
  block: Block,
  sources: Source[],
  dormitories: Dormitory[],
  month: string,
): Result {
  const [year, monthNumber] = month.split('-').map(Number);
  const days = new Date(year, monthNumber, 0).getDate();
  const availableDays = month < '2026-10' ? days : month === '2026-10' ? 10 : 0;
  const metric = sources
    .find((source) => source.id === block.sourceId)
    ?.metrics.find((item) => item.id === block.metricId);
  const base = metric?.base ?? 0;
  const genderFactor = block.gender === 'male' ? 0.68 : block.gender === 'female' ? 0.32 : 1;
  const rows = dormitories
    .filter((dorm) => block.scope === 'all' || block.dormitoryIds.includes(dorm.id))
    .map((dormitory) => {
      const values = Array.from({ length: availableDays }, (_, day) =>
        Math.max(
          0,
          Math.round(
            (base + Math.sin(day * 0.78 + dormitory.phase) * base * 0.11 + day * base * 0.009) *
              dormitory.factor *
              genderFactor,
          ),
        ),
      );
      return { dormitory, values, value: aggregate(values, block.operation) };
    });
  const daily = Array.from({ length: availableDays }, (_, day) =>
    rows.reduce((sum, row) => sum + row.values[day], 0),
  );
  return { rows, daily, total: aggregate(daily, block.operation), days, availableDays };
}

function Chart({ block, result }: { block: Block; result: Result }): JSX.Element {
  if (!result.rows.length || !result.availableDays)
    return (
      <div className={styles.noData}>
        <Icon name="calendar" />
        <strong>Нет данных за этот период</strong>
        <span>В макете доступны данные до 10 октября 2026 года.</span>
      </div>
    );
  if (block.display === 'number')
    return (
      <div className={styles.numberResult}>
        <strong>{format(result.total)}</strong>
        <span>
          {operations[block.operation]} · {result.availableDays} дн.
        </span>
      </div>
    );
  if (block.display === 'table')
    return (
      <div
        className={styles.tableScroll}
        tabIndex={0}
        aria-label="Таблица по общежитиям и датам, прокрутка по горизонтали"
      >
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th scope="col">Общежитие</th>
              {Array.from({ length: result.days }, (_, index) => (
                <th key={index} scope="col">
                  {String(index + 1).padStart(2, '0')}
                </th>
              ))}
              <th scope="col">
                {block.operation === 'sum'
                  ? 'Итого'
                  : block.operation === 'average'
                    ? 'Среднее'
                    : block.operation === 'last'
                      ? 'На дату'
                      : 'Макс.'}
              </th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.dormitory.id}>
                <th scope="row">
                  <strong>{row.dormitory.name}</strong>
                  <small>{row.dormitory.client}</small>
                </th>
                {Array.from({ length: result.days }, (_, day) => (
                  <td key={day} className={day >= result.availableDays ? styles.future : ''}>
                    {row.values[day] === undefined ? '—' : format(row.values[day])}
                  </td>
                ))}
                <td className={styles.totalCell}>{format(row.value)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Все общежития</th>
              {Array.from({ length: result.days }, (_, day) => (
                <td key={day}>
                  {result.daily[day] === undefined ? '—' : format(result.daily[day])}
                </td>
              ))}
              <td>{format(result.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  if (block.display === 'pie') {
    const total = result.rows.reduce((sum, row) => sum + row.value, 0);
    let offset = 0;
    return (
      <div className={styles.donutWrap}>
        <svg
          viewBox="0 0 220 220"
          className={styles.donut}
          role="img"
          aria-label={`${block.name}: ${format(total)}`}
        >
          <circle cx="110" cy="110" r="77" fill="none" stroke="#f4ebdc" strokeWidth="26" />
          {result.rows.map((row, index) => {
            const length = total ? (row.value / total) * 483.8 : 0;
            const current = offset;
            offset += length;
            return (
              <circle
                key={row.dormitory.id}
                cx="110"
                cy="110"
                r="77"
                fill="none"
                stroke={colors[index % colors.length]}
                strokeWidth="26"
                strokeDasharray={`${length} ${483.8 - length}`}
                strokeDashoffset={-current}
                transform="rotate(-90 110 110)"
              >
                <title>
                  {row.dormitory.name}: {format(row.value)}
                </title>
              </circle>
            );
          })}
          <text x="110" y="109" textAnchor="middle" className={styles.donutValue}>
            {format(total)}
          </text>
          <text x="110" y="132" textAnchor="middle" className={styles.axisLabel}>
            Всего
          </text>
        </svg>
        <div className={styles.donutLegend}>
          {result.rows.map((row, index) => (
            <div key={row.dormitory.id}>
              <span style={{ background: colors[index % colors.length] }} />
              <p>{row.dormitory.name}</p>
              <strong>{format(row.value)}</strong>
            </div>
          ))}
        </div>
      </div>
    );
  }
  const byDormitory = block.grouping === 'dormitory';
  const values = byDormitory ? result.rows.map((row) => row.value) : result.daily;
  const labels = byDormitory
    ? result.rows.map((row) => row.dormitory.name)
    : result.daily.map((_, index) => String(index + 1).padStart(2, '0'));
  const max = Math.max(...values, 1) * 1.2;
  const left = 55,
    right = 720,
    top = 18,
    bottom = 212;
  const step = (right - left) / Math.max(values.length, 1);
  const x = (index: number): number => left + step * (index + 0.5);
  const y = (value: number): number => bottom - (value / max) * (bottom - top);
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(' ');
  return (
    <div className={styles.chartWrap}>
      <svg
        className={styles.chart}
        viewBox="0 0 760 255"
        role="img"
        aria-label={`${block.name}, ${byDormitory ? 'по общежитиям' : 'по дням'}`}
      >
        {[0, 1, 2, 3].map((index) => (
          <g key={index}>
            <line
              x1={left}
              x2={right}
              y1={y((max * index) / 3)}
              y2={y((max * index) / 3)}
              className={styles.gridLine}
            />
            <text
              x={left - 12}
              y={y((max * index) / 3) + 4}
              textAnchor="end"
              className={styles.axisLabel}
            >
              {format(Math.round((max * index) / 3))}
            </text>
          </g>
        ))}
        {(block.display === 'area' || block.display === 'line') && (
          <>
            <polygon
              points={`${x(0)},${bottom} ${points} ${x(values.length - 1)},${bottom}`}
              fill="#2f7d62"
              opacity="0.07"
            />
            <polyline
              points={points}
              fill="none"
              stroke="#2f7d62"
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </>
        )}
        {values.map((value, index) => (
          <g key={index}>
            {block.display === 'bar' ? (
              <rect
                x={x(index) - Math.min(step * 0.28, 40)}
                y={y(value)}
                width={Math.min(step * 0.56, 80)}
                height={bottom - y(value)}
                rx="6"
                fill={byDormitory ? colors[index % colors.length] : '#8ebca8'}
              >
                <title>
                  {labels[index]}: {format(value)}
                </title>
              </rect>
            ) : (
              <circle
                cx={x(index)}
                cy={y(value)}
                r="4"
                fill="#2f7d62"
                stroke="white"
                strokeWidth="2"
              >
                <title>
                  {labels[index]}: {format(value)}
                </title>
              </circle>
            )}
            {(labels.length <= 12 || index % 3 === 0) && (
              <text x={x(index)} y="239" textAnchor="middle" className={styles.axisLabel}>
                {labels[index]}
              </text>
            )}
          </g>
        ))}
      </svg>
      <p className={styles.chartFootnote}>
        {byDormitory ? operations[block.operation] : 'Дата месяца · значение за каждый день'}
        {block.gender !== 'all' ? ` · ${block.gender === 'male' ? 'Мужчины' : 'Женщины'}` : ''}
      </p>
    </div>
  );
}

function SourceDialog({
  sources,
  onAdd,
  onClose,
}: {
  sources: Source[];
  onAdd: (kind: string, sourceId: string, name: string, metric: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [kind, setKind] = useState('row');
  const [sourceId, setSourceId] = useState(sources[0].id);
  const [name, setName] = useState('Сверхурочный выход');
  const [metric, setMetric] = useState('Количество поездок');
  return (
    <Modal
      title="Попробовать изменение структуры"
      testId="preview-source-dialog"
      onClose={onClose}
      panelClassName={styles.smallModal}
      containerClassName={styles.modalTheme}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onAdd(kind, sourceId, name.trim(), metric.trim());
        }}
      >
        <p className={styles.modalIntro}>
          Добавьте пример вкладки, строки или общежития. Он сразу появится в выборе данных этого
          макета.
        </p>
        <label className={styles.field}>
          Что добавить
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              setName(
                event.target.value === 'tab'
                  ? 'Транспорт'
                  : event.target.value === 'dormitory'
                    ? 'Восточное'
                    : 'Сверхурочный выход',
              );
            }}
          >
            <option value="row">Новую строку / показатель</option>
            <option value="tab">Новую пользовательскую вкладку</option>
            <option value="dormitory">Новое общежитие</option>
          </select>
        </label>
        {kind === 'row' && (
          <label className={styles.field}>
            Вкладка
            <select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
              {sources.map((source) => (
                <option value={source.id} key={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={styles.field}>
          {kind === 'row'
            ? 'Название строки'
            : kind === 'tab'
              ? 'Название вкладки'
              : 'Название общежития'}
          <input
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {kind === 'tab' && (
          <label className={styles.field}>
            Первый показатель
            <input
              required
              maxLength={80}
              value={metric}
              onChange={(event) => setMetric(event.target.value)}
            />
          </label>
        )}
        <div className={styles.modalFooter}>
          <button type="button" className={styles.secondary} onClick={onClose}>
            Отмена
          </button>
          <button
            className={styles.primary}
            disabled={!name.trim() || (kind === 'tab' && !metric.trim())}
          >
            <Icon name="plus" />
            Добавить в макет
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BlockEditor({
  initial,
  sources,
  dormitories,
  month,
  onSave,
  onCancel,
  onSources,
}: {
  initial: Block;
  sources: Source[];
  dormitories: Dormitory[];
  month: string;
  onSave: (block: Block) => void;
  onCancel: () => void;
  onSources: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(initial);
  const source = sources.find((item) => item.id === draft.sourceId)!;
  const metric = source.metrics.find((item) => item.id === draft.metricId)!;
  const result = calculate(draft, sources, dormitories, month);
  const change = (patch: Partial<Block>): void => setDraft((current) => ({ ...current, ...patch }));
  const valid = !!draft.name.trim() && (draft.scope === 'all' || draft.dormitoryIds.length > 0);
  return (
    <>
      <button className={styles.back} onClick={onCancel}>
        <Icon name="arrow" />
        Вернуться к отчёту
      </button>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>КОНСТРУКТОР БЛОКА</p>
          <h1>От данных — к результату</h1>
          <p className={styles.subtitle}>Выберите, что считать и как это показать.</p>
        </div>
        <div className={styles.actions}>
          <button className={styles.secondary} onClick={onCancel}>
            Отмена
          </button>
          <button
            className={styles.primary}
            disabled={!valid}
            onClick={() => onSave({ ...draft, name: draft.name.trim() })}
          >
            <Icon name="check" />
            Сохранить блок
          </button>
        </div>
      </div>
      <div className={styles.editorGrid}>
        <div className={styles.editorSettings}>
          <section className={styles.settingSection}>
            <h2>
              <span>1</span>Данные
            </h2>
            <label className={styles.field}>
              Название блока
              <input
                maxLength={100}
                value={draft.name}
                onChange={(event) => change({ name: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              Вкладка / таблица
              <select
                value={draft.sourceId}
                onChange={(event) => {
                  const next = sources.find((item) => item.id === event.target.value)!;
                  change({ sourceId: next.id, metricId: next.metrics[0].id });
                }}
              >
                {sources.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              Строка / показатель
              <select
                value={draft.metricId}
                onChange={(event) => change({ metricId: event.target.value })}
              >
                {source.metrics.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              Общежития
              <select
                value={draft.scope}
                onChange={(event) =>
                  change({
                    scope: event.target.value as Block['scope'],
                    dormitoryIds: dormitories.map((item) => item.id),
                  })
                }
              >
                <option value="all">Все общежития</option>
                <option value="selected">Выбрать общежития</option>
              </select>
            </label>
            {draft.scope === 'selected' ? (
              <div className={styles.dormitoryChecks}>
                {dormitories.map((item) => (
                  <label key={item.id}>
                    <input
                      type="checkbox"
                      checked={draft.dormitoryIds.includes(item.id)}
                      onChange={(event) =>
                        change({
                          dormitoryIds: event.target.checked
                            ? [...draft.dormitoryIds, item.id]
                            : draft.dormitoryIds.filter((id) => id !== item.id),
                        })
                      }
                    />
                    {item.name}
                  </label>
                ))}
              </div>
            ) : (
              <p className={styles.fieldHint}>
                <Icon name="refresh" />
                Новые общежития включаются автоматически
              </p>
            )}
          </section>
          <section className={styles.settingSection}>
            <h2>
              <span>2</span>Расчёт и условия
            </h2>
            <label className={styles.field}>
              Как считать
              <select
                value={draft.operation}
                onChange={(event) => change({ operation: event.target.value as Operation })}
              >
                {Object.entries(operations).map(([key, value]) => (
                  <option key={key} value={key}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              Разбивка
              <select
                value={draft.grouping}
                disabled={
                  draft.display === 'pie' || draft.display === 'table' || draft.display === 'number'
                }
                onChange={(event) => change({ grouping: event.target.value as Block['grouping'] })}
              >
                <option value="date">По дням месяца</option>
                <option value="dormitory">По общежитиям</option>
              </select>
            </label>
            <label className={styles.field}>
              Пол
              <select
                value={draft.gender}
                onChange={(event) => change({ gender: event.target.value as Block['gender'] })}
              >
                <option value="all">Все сотрудники</option>
                <option value="male">Мужчины</option>
                <option value="female">Женщины</option>
              </select>
            </label>
            <p className={styles.hint}>
              В макете можно попробовать основные расчёты. В полном конструкторе здесь будут условия
              по любому столбцу и формулы.
            </p>
          </section>
        </div>
        <div className={styles.editorPreview}>
          <section className={styles.formatSection}>
            <div className={styles.sectionHeading}>
              <h2>
                <span className={styles.stepNumber}>3</span>Вид блока
              </h2>
              <span className={styles.smallMuted}>Можно изменить в любой момент</span>
            </div>
            <div className={styles.formatGrid}>
              {(Object.keys(displayNames) as Display[]).map((display) => (
                <button
                  key={display}
                  className={draft.display === display ? styles.formatSelected : ''}
                  aria-pressed={draft.display === display}
                  onClick={() =>
                    change({ display, grouping: display === 'pie' ? 'dormitory' : draft.grouping })
                  }
                >
                  <Icon name={display} />
                  <span>{displayNames[display]}</span>
                  {draft.display === display && (
                    <span className={styles.formatCheck}>
                      <Icon name="check" />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
          <div className={styles.previewLabel}>
            <span />
            ПРЕДПРОСМОТР
            <span className={styles.smallMuted}>Обновляется при изменении настроек</span>
          </div>
          <section className={styles.blockCard}>
            <div className={styles.blockHeading}>
              <div>
                <h2>{draft.name || 'Название блока'}</h2>
                <p>
                  {source.name} / {metric.name}
                </p>
              </div>
              <span className={styles.typeBadge}>{displayNames[draft.display]}</span>
            </div>
            <Chart block={draft} result={result} />
          </section>
          <div className={styles.recipe}>
            <Icon name="layers" />
            <div>
              <strong>Как получится результат</strong>
              <p>
                {metric.name} →{' '}
                {draft.scope === 'all'
                  ? `все общежития (${dormitories.length})`
                  : `${draft.dormitoryIds.length} общежития`}{' '}
                → {operations[draft.operation].toLocaleLowerCase('ru-RU')} →{' '}
                {displayNames[draft.display].toLocaleLowerCase('ru-RU')}
              </p>
            </div>
          </div>
          <div className={styles.structureNote}>
            <div className={styles.noteIcon}>
              <Icon name="refresh" />
            </div>
            <div>
              <strong>Структура может меняться</strong>
              <p>
                Новые вкладки и строки появятся в выборе данных. Переименование сохранит связь с
                показателем.
              </p>
              <button className={styles.textButton} onClick={onSources}>
                Попробовать новую вкладку или строку
                <Icon name="chevron" />
              </button>
            </div>
          </div>
          <p className={styles.previewDisclaimer}>
            Демонстрационные значения. Настройки этого макета действуют до обновления страницы.
          </p>
        </div>
      </div>
    </>
  );
}

export function StatisticsDesignPreview(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const [reports, setReports] = useState<Report[]>(() => structuredClone(initialReports));
  const [sources, setSources] = useState<Source[]>(() => structuredClone(initialSources));
  const [dormitories, setDormitories] = useState<Dormitory[]>(initialDormitories);
  const [editor, setEditor] = useState<Block | null>(null);
  const [month, setMonth] = useState('2026-10');
  const [reportDormitory, setReportDormitory] = useState('all');
  const [search, setSearch] = useState('');
  const [listFilter, setListFilter] = useState('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState('blank');
  const [personal, setPersonal] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState('');
  const activeId = params.get('report');
  const activeReport = reports.find((report) => report.id === activeId);
  const editing = editor !== null;
  const selectedDormitories =
    reportDormitory === 'all'
      ? dormitories
      : dormitories.filter((item) => item.id === reportDormitory);
  const monthName = new Date(`${month}-01T12:00:00`).toLocaleDateString('ru-RU', {
    month: 'long',
    year: 'numeric',
  });
  useEffect(() => {
    const previous = document.title;
    document.title = `${activeReport?.name ?? 'Конструктор отчётов'} — макет Домовой`;
    return () => {
      document.title = previous;
    };
  }, [activeReport?.name]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activeId, editing]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function openReport(id: string): void {
    setParams({ report: id });
    setEditor(null);
    setReportDormitory('all');
  }
  function showList(): void {
    setParams({});
    setEditor(null);
    setMenuOpen(false);
  }
  function startCreate(): void {
    setNewName('');
    setNewTemplate('blank');
    setPersonal(false);
    setCreateOpen(true);
  }
  function createReport(event: FormEvent): void {
    event.preventDefault();
    if (!newName.trim()) return;
    const id = crypto.randomUUID();
    const template = initialReports.find((item) => item.id === newTemplate);
    setReports((current) => [
      ...current,
      {
        id,
        name: newName.trim(),
        description: template?.description ?? 'Ваш отчёт с нужными показателями',
        personal,
        blocks: template ? structuredClone(template.blocks) : [],
      },
    ]);
    setCreateOpen(false);
    openReport(id);
    setToast('Отчёт создан в макете. Теперь добавьте нужные блоки.');
  }
  function saveBlock(block: Block): void {
    setReports((current) =>
      current.map((report) =>
        report.id === activeId
          ? {
              ...report,
              blocks: report.blocks.some((item) => item.id === block.id)
                ? report.blocks.map((item) => (item.id === block.id ? block : item))
                : [...report.blocks, block],
            }
          : report,
      ),
    );
    setEditor(null);
    setToast('Блок сохранён в макете');
  }
  function addSource(kind: string, sourceId: string, name: string, metricName: string): void {
    const id = crypto.randomUUID();
    if (kind === 'dormitory')
      setDormitories((current) => [
        ...current,
        { id, name, client: 'Новый клиент', factor: 0.56, phase: current.length },
      ]);
    else if (kind === 'tab')
      setSources((current) => [
        ...current,
        { id, name, metrics: [{ id: `${id}-metric`, name: metricName, base: 16 }] },
      ]);
    else
      setSources((current) =>
        current.map((source) =>
          source.id === sourceId
            ? { ...source, metrics: [...source.metrics, { id, name, base: 12 }] }
            : source,
        ),
      );
    setSourceOpen(false);
    setToast(
      kind === 'dormitory'
        ? 'Общежитие добавлено. Блоки с выбором «Все общежития» уже учитывают его.'
        : 'Источник добавлен. Он уже доступен в настройках блока.',
    );
  }

  return (
    <div className={styles.page}>
      {menuOpen && (
        <button
          className={styles.veil}
          aria-label="Закрыть меню"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside
        className={`${styles.sidebar} ${menuOpen ? styles.sidebarOpen : ''}`}
        aria-label="Боковая панель"
      >
        <Link to="/" className={styles.brand}>
          <span>
            <WorkspaceIcon name="house" />
          </span>
          Домовой
        </Link>
        <p className={styles.brandNote}>Учёт проживающих в общежитиях</p>
        <p className={styles.navLabel}>РАБОЧЕЕ ПРОСТРАНСТВО</p>
        <nav className={styles.nav}>
          <Link to="/cabinet">
            <WorkspaceIcon name="overview" />
            Обзор
          </Link>
          <Link to="/cabinet/dormitories">
            <WorkspaceIcon name="house" />
            Общежития
          </Link>
          <button className={styles.navActive} aria-current="page" onClick={showList}>
            <WorkspaceIcon name="chart" />
            Статистика<span>{reports.length}</span>
          </button>
        </nav>
        <div className={styles.sidebarNote}>
          <Icon name="layers" />
          <strong>Ваши данные. Ваши отчёты.</strong>
          <p>Собирайте показатели в удобном для вас виде.</p>
        </div>
        <div className={styles.sidebarBottom}>
          <span className={styles.avatar}>СП</span>
          <div>
            <strong>Сергей</strong>
            <small>Предпросмотр интерфейса</small>
          </div>
        </div>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <button
            className={styles.mobileMenu}
            aria-label={menuOpen ? 'Закрыть меню' : 'Открыть меню'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((current) => !current)}
          >
            <WorkspaceIcon name="menu" />
          </button>
          <div className={styles.breadcrumb}>
            <span>Рабочее пространство</span>
            <Icon name="chevron" />
            <button onClick={showList}>Статистика</button>
            {activeReport && (
              <>
                <Icon name="chevron" />
                <span className={styles.currentCrumb}>{activeReport.name}</span>
              </>
            )}
          </div>
          <span className={styles.demoBadge}>
            <span />
            Тестовая страница
          </span>
        </header>
        <main className={styles.main}>
          {editor && activeReport ? (
            <BlockEditor
              key={editor.id}
              initial={editor}
              sources={sources}
              dormitories={dormitories}
              month={month}
              onSave={saveBlock}
              onCancel={() => setEditor(null)}
              onSources={() => setSourceOpen(true)}
            />
          ) : activeReport ? (
            <>
              <button className={styles.back} onClick={showList}>
                <Icon name="arrow" />
                Все отчёты
              </button>
              <div className={styles.pageHeading}>
                <div>
                  <div className={styles.titleKicker}>
                    <span className={styles.tag}>
                      {activeReport.personal ? 'Личный отчёт' : 'Общий отчёт'}
                    </span>
                    <span className={styles.smallMuted}>Демонстрационные данные</span>
                  </div>
                  <h1>{activeReport.name}</h1>
                  <p className={styles.subtitle}>{activeReport.description}</p>
                </div>
                <button
                  className={styles.primary}
                  onClick={() => setEditor(makeBlock(crypto.randomUUID(), 'Новый блок', 'line'))}
                >
                  <Icon name="plus" />
                  Добавить блок
                </button>
              </div>
              <div className={styles.reportToolbar}>
                <div className={styles.toolbarFields}>
                  <label>
                    <Icon name="calendar" />
                    <input
                      type="month"
                      aria-label="Месяц отчёта"
                      min="2025-01"
                      max="2027-12"
                      value={month}
                      onChange={(event) => {
                        if (event.target.value) setMonth(event.target.value);
                      }}
                    />
                  </label>
                  <label>
                    <WorkspaceIcon name="house" />
                    <select
                      aria-label="Общежития отчёта"
                      value={reportDormitory}
                      onChange={(event) => setReportDormitory(event.target.value)}
                    >
                      <option value="all">Все общежития · {dormitories.length}</option>
                      {dormitories.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button className={styles.textButton} onClick={() => setSourceOpen(true)}>
                  <Icon name="refresh" />
                  Источники данных
                </button>
              </div>
              {activeReport.blocks.length ? (
                <div className={styles.blockGrid}>
                  {activeReport.blocks.map((block) => {
                    const source = sources.find((item) => item.id === block.sourceId);
                    const metric = source?.metrics.find((item) => item.id === block.metricId);
                    const result = calculate(block, sources, selectedDormitories, month);
                    return (
                      <section
                        key={block.id}
                        className={`${styles.blockCard} ${block.display === 'number' ? styles.metricCard : block.display === 'table' ? styles.fullBlock : styles.halfBlock}`}
                      >
                        <div className={styles.blockHeading}>
                          <div>
                            <h2>{block.name}</h2>
                            {block.display !== 'number' && (
                              <p>
                                {metric?.name} ·{' '}
                                {block.scope === 'all' ? 'Все общежития' : 'Выбранные общежития'}
                              </p>
                            )}
                          </div>
                          <div className={styles.blockActions}>
                            <button
                              aria-label={`Настроить блок «${block.name}»`}
                              title="Настроить блок"
                              onClick={() => setEditor(structuredClone(block))}
                            >
                              <Icon name="edit" />
                            </button>
                            <button
                              aria-label={`Удалить блок «${block.name}»`}
                              title="Удалить из макета"
                              onClick={() => {
                                setReports((current) =>
                                  current.map((report) =>
                                    report.id === activeId
                                      ? {
                                          ...report,
                                          blocks: report.blocks.filter(
                                            (item) => item.id !== block.id,
                                          ),
                                        }
                                      : report,
                                  ),
                                );
                                setToast('Блок удалён из макета');
                              }}
                            >
                              <Icon name="trash" />
                            </button>
                          </div>
                        </div>
                        <Chart block={block} result={result} />
                        {block.display === 'number' && (
                          <div className={styles.metricFooter}>
                            <span className={styles.dot} />
                            {result.rows.length} общежития
                            <span className={styles.metricSource}>{metric?.name}</span>
                          </div>
                        )}
                        {block.display === 'table' && (
                          <div className={styles.tableNote}>
                            <Icon name="calendar" />
                            {monthName} · Будущие даты обозначены прочерком. Таблицу можно
                            прокрутить вправо.
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.emptyReport}>
                  <span>
                    <Icon name="layers" />
                  </span>
                  <h2>Начнём с первого блока</h2>
                  <p>Выберите данные и представьте их числом, таблицей или графиком.</p>
                  <button
                    className={styles.primary}
                    onClick={() => setEditor(makeBlock(crypto.randomUUID(), 'Новый блок', 'line'))}
                  >
                    <Icon name="plus" />
                    Добавить блок
                  </button>
                </div>
              )}
              <p className={styles.previewDisclaimer}>
                Интерактивный макет · данные вымышлены · изменения действуют до обновления страницы.
              </p>
            </>
          ) : (
            <>
              <div className={styles.pageHeading}>
                <div>
                  <p className={styles.eyebrow}>СТАТИСТИКА</p>
                  <h1>Отчёты</h1>
                  <p className={styles.subtitle}>Нужные показатели — в удобном для вас виде.</p>
                </div>
                <button className={styles.primary} onClick={startCreate}>
                  <Icon name="plus" />
                  Создать отчёт
                </button>
              </div>
              <div className={styles.intro}>
                <div>
                  <span className={styles.introKicker}>
                    <span />
                    КОНСТРУКТОР ОТЧЁТОВ
                  </span>
                  <h2>Один отчёт. Вся нужная картина.</h2>
                  <p>
                    Объединяйте данные общежитий, выбирайте расчёты
                    <br className={styles.desktopBreak} /> и собирайте таблицы и графики в одном
                    отчёте.
                  </p>
                  <button className={styles.introLink} onClick={() => openReport('attendance')}>
                    Посмотреть пример отчёта
                    <Icon name="chevron" />
                  </button>
                </div>
                <div className={styles.introArt} aria-hidden="true">
                  <div className={styles.artNumber}>
                    <span>Выход сегодня</span>
                    <strong>428</strong>
                    <small>по всем общежитиям</small>
                  </div>
                  <div className={styles.artChart}>
                    <span>Динамика выхода</span>
                    <svg viewBox="0 0 230 85">
                      <path
                        d="M0 75H230M0 40H230M0 5H230"
                        stroke="#e8e9df"
                        strokeDasharray="3 4"
                        fill="none"
                      />
                      <path
                        d="M0 68 24 61 46 65 69 44 92 48 115 30 138 34 161 16 184 22 207 8 230 12"
                        fill="none"
                        stroke="#2f7d62"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <div>
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                </div>
              </div>
              <div className={styles.libraryToolbar}>
                <div className={styles.tabs}>
                  <button
                    className={listFilter === 'all' ? styles.tabActive : ''}
                    onClick={() => setListFilter('all')}
                  >
                    Все отчёты<span>{reports.length}</span>
                  </button>
                  <button
                    className={listFilter === 'personal' ? styles.tabActive : ''}
                    onClick={() => setListFilter('personal')}
                  >
                    Личные
                  </button>
                  <button
                    className={listFilter === 'shared' ? styles.tabActive : ''}
                    onClick={() => setListFilter('shared')}
                  >
                    Общие
                  </button>
                </div>
                <label className={styles.search}>
                  <Icon name="search" />
                  <input
                    aria-label="Поиск отчёта"
                    placeholder="Найти отчёт"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
              </div>
              <div className={styles.reportCards}>
                {reports
                  .filter(
                    (report) =>
                      (!search.trim() ||
                        report.name
                          .toLocaleLowerCase('ru-RU')
                          .includes(search.trim().toLocaleLowerCase('ru-RU'))) &&
                      (listFilter === 'all' ||
                        (listFilter === 'personal' ? report.personal : !report.personal)),
                  )
                  .map((report, index) => (
                    <button
                      className={styles.reportCard}
                      key={report.id}
                      onClick={() => openReport(report.id)}
                    >
                      <div className={styles.cardTop}>
                        <span
                          className={`${styles.reportIcon} ${index % 3 === 1 ? styles.sky : index % 3 === 2 ? styles.peach : ''}`}
                        >
                          <Icon
                            name={
                              report.id === 'places'
                                ? 'pie'
                                : report.id === 'movement'
                                  ? 'bar'
                                  : 'line'
                            }
                          />
                        </span>
                        <span className={styles.tag}>{report.personal ? 'Личный' : 'Общий'}</span>
                      </div>
                      <h2>{report.name}</h2>
                      <p>{report.description}</p>
                      <div className={styles.miniChart} aria-hidden="true">
                        {report.id === 'places' ? (
                          <div className={styles.miniStack}>
                            <i />
                            <i />
                            <i />
                            <i />
                          </div>
                        ) : (
                          <svg viewBox="0 0 300 60" preserveAspectRatio="none">
                            <path d="M0 55H300M0 26H300" stroke="#eee9df" strokeDasharray="3 4" />
                            <path
                              d={
                                report.id === 'movement'
                                  ? 'M0 50 28 42 55 46 83 15 110 36 137 23 165 34 192 8 220 20 247 10 275 18 300 5'
                                  : 'M0 49 28 44 55 47 83 30 110 34 137 20 165 23 192 11 220 17 247 6 275 10 300 3'
                              }
                              stroke={report.id === 'movement' ? '#bd8d62' : '#5f9b80'}
                              strokeWidth="2.5"
                              fill="none"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </div>
                      <div className={styles.cardFooter}>
                        <span>
                          <Icon name="layers" />
                          {report.blocks.length} блоков
                        </span>
                        <span>
                          Открыть
                          <Icon name="chevron" />
                        </span>
                      </div>
                    </button>
                  ))}
                <button className={styles.newReportCard} onClick={startCreate}>
                  <span>
                    <Icon name="plus" />
                  </span>
                  <strong>Новый отчёт</strong>
                  <p>
                    Соберите свою комбинацию
                    <br />
                    показателей и графиков
                  </p>
                </button>
              </div>
              <div className={styles.howItWorks}>
                <div>
                  <span>01</span>
                  <strong>Выберите данные</strong>
                  <p>Любая вкладка, строка или столбец</p>
                </div>
                <Icon name="chevron" />
                <div>
                  <span>02</span>
                  <strong>Настройте расчёт</strong>
                  <p>Период, условия и группировка</p>
                </div>
                <Icon name="chevron" />
                <div>
                  <span>03</span>
                  <strong>Выберите вид</strong>
                  <p>Число, таблица или диаграмма</p>
                </div>
              </div>
              <p className={styles.previewDisclaimer}>
                Интерактивный макет · данные вымышлены · изменения действуют до обновления страницы.
              </p>
            </>
          )}
        </main>
      </div>
      {createOpen && (
        <Modal
          title="Создать отчёт"
          testId="preview-create-report"
          onClose={() => setCreateOpen(false)}
          panelClassName={styles.smallModal}
          containerClassName={styles.modalTheme}
        >
          <form onSubmit={createReport}>
            <p className={styles.modalIntro}>
              Дайте отчёту название. Затем добавьте нужные блоки или начните с готового примера.
            </p>
            <label className={styles.field}>
              Название отчёта
              <input
                placeholder="Например, выход персонала за месяц"
                required
                maxLength={100}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              С чего начать
              <select value={newTemplate} onChange={(event) => setNewTemplate(event.target.value)}>
                <option value="blank">Пустой отчёт</option>
                {initialReports.map((report) => (
                  <option value={report.id} key={report.id}>
                    По образцу: {report.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              Доступ в макете
              <select
                value={personal ? 'personal' : 'shared'}
                onChange={(event) => setPersonal(event.target.value === 'personal')}
              >
                <option value="shared">Общий отчёт</option>
                <option value="personal">Личный отчёт</option>
              </select>
            </label>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => setCreateOpen(false)}
              >
                Отмена
              </button>
              <button className={styles.primary} disabled={!newName.trim()}>
                Создать и открыть
                <Icon name="chevron" />
              </button>
            </div>
          </form>
        </Modal>
      )}
      {sourceOpen && (
        <SourceDialog sources={sources} onAdd={addSource} onClose={() => setSourceOpen(false)} />
      )}
      {toast && (
        <div className={styles.toast} role="status">
          <Icon name="check" />
          {toast}
        </div>
      )}
    </div>
  );
}

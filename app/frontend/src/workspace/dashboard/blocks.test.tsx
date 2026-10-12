import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api/client';
import type { CatalogDormitory, DashboardLayout, WidgetConfig } from '../../api/dashboardBlocks';
import { DEFAULT_LAYOUT } from '../../api/dashboardBlocks';
import { EMPTY_DASHBOARD } from './data';
import { DashboardBlocks } from './DashboardBlocks';
import { WidgetDialog } from './WidgetDialog';
import { WidgetChart } from './WidgetChart';

afterEach(() => vi.restoreAllMocks());
const RANGE = { from: '2026-10-01', to: '2026-10-02' };
const CATALOG: CatalogDormitory[] = [1, 2].map((id) => ({
  id,
  name: id === 1 ? 'Северное' : 'Южное',
  is_archived: false,
  sources: [
    {
      key: 'report',
      name: 'Большой отчёт',
      kind: 'report',
      columns: [],
      rows: [{ id: id * 10, name: 'Выход Итого' }],
      hostels: [],
    },
    {
      key: `custom_${id}`,
      name: 'Дополнительная таблица',
      kind: 'table',
      rows: [],
      hostels: [],
      columns: [
        {
          id: id * 100,
          name: 'Причина',
          kind: 'select',
          options: [{ id: 'option-' + id, label: 'Сбежал', archived: false }],
          table_key: `custom_${id}`,
          builtin_key: null,
          archived: false,
          position: 0,
        },
        {
          id: id * 100 + 1,
          name: 'Дата',
          kind: 'date',
          options: [],
          table_key: `custom_${id}`,
          builtin_key: null,
          archived: false,
          position: 1,
        },
      ],
    },
  ],
}));
const CONFIG: WidgetConfig = {
  name: 'Мой блок',
  display: 'number',
  source_kind: 'report',
  operation: 'sum',
  period: 'snapshot',
  grouping: 'dormitory',
  all_dormitories: true,
  excluded_dormitory_ids: [],
  sources: [{ kind: 'report', dormitory_id: 1, row_id: 10 }],
};

it('подбирает строки разных общежитий по названию, показывает расчёт и добавляет общий блок', async () => {
  const user = userEvent.setup(),
    saved = vi.fn();
  vi.spyOn(api, 'dashboardSources').mockResolvedValue(CATALOG);
  const result = { id: 0, value: 17, items: [], errors: [] };
  const preview = vi.spyOn(api, 'previewDashboardBlock').mockResolvedValue(result);
  const layout = {
    ...DEFAULT_LAYOUT,
    revision: 1,
    order: [...DEFAULT_LAYOUT.order, 'custom:1'],
    blocks: [{ id: 1, config: CONFIG }],
  };
  const save = vi.spyOn(api, 'saveDashboardBlock').mockResolvedValue(layout);
  render(
    <WidgetDialog initial={null} revision={0} range={RANGE} onClose={vi.fn()} onSaved={saved} />,
  );
  await user.type(screen.getByLabelText('Название блока'), 'Общий выход');
  await user.selectOptions(await screen.findByLabelText('Строка отчёта — Северное'), '10');
  await user.click(screen.getByRole('button', { name: 'Подобрать по первому общежитию' }));
  await user.click(screen.getByRole('button', { name: 'Проверить расчёт' }));
  expect(await screen.findByText('Предпросмотр: 17')).toBeInTheDocument();
  expect(preview.mock.calls[0][0].sources).toEqual([
    { kind: 'report', dormitory_id: 1, row_id: 10 },
    { kind: 'report', dormitory_id: 2, row_id: 20 },
  ]);
  await user.click(screen.getByRole('button', { name: 'Добавить блок' }));
  expect(save).toHaveBeenCalledWith(0, expect.objectContaining({ name: 'Общий выход' }), undefined);
  expect(saved).toHaveBeenCalledWith(layout);
});

it('сопоставляет пользовательские таблицы, даты и варианты списков по названиям при разных ID', async () => {
  const user = userEvent.setup();
  vi.spyOn(api, 'dashboardSources').mockResolvedValue(CATALOG);
  const save = vi
    .spyOn(api, 'saveDashboardBlock')
    .mockResolvedValue({ ...DEFAULT_LAYOUT, revision: 1 });
  render(
    <WidgetDialog initial={null} revision={0} range={RANGE} onClose={vi.fn()} onSaved={vi.fn()} />,
  );
  await user.type(screen.getByLabelText('Название блока'), 'Причины оттока');
  await user.selectOptions(screen.getByLabelText('Источник данных'), 'table');
  await user.selectOptions(screen.getByLabelText('Отображение'), 'list');
  await user.selectOptions(screen.getByLabelText('Группировка списка'), 'value');
  await user.selectOptions(await screen.findByLabelText('Столбец группировки — Северное'), '100');
  await user.selectOptions(screen.getByLabelText('Дата для расчёта — Северное'), '101');
  await user.click(screen.getByLabelText('Условие отбора — Северное'));
  await user.selectOptions(screen.getByLabelText('Значение'), 'option-1');
  await user.click(screen.getByRole('button', { name: 'Подобрать по первому общежитию' }));
  await user.click(screen.getByRole('button', { name: 'Добавить блок' }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0][1].sources[1]).toEqual(
    expect.objectContaining({
      table_key: 'custom_2',
      date_column_id: 201,
      group_column_id: 200,
      filter: { column_id: 200, operator: 'equals', value: 'option-2' },
    }),
  );
});

it('перемещает пользовательские и стандартные карточки, скрывает и восстанавливает без удаления', async () => {
  const user = userEvent.setup(),
    onChange = vi.fn();
  let current: DashboardLayout = {
    ...DEFAULT_LAYOUT,
    blocks: [{ id: 1, config: CONFIG }],
    order: [...DEFAULT_LAYOUT.order, 'custom:1'],
  };
  const save = vi.spyOn(api, 'saveDashboardLayout').mockImplementation(async (input) => {
    current = { ...current, ...input, revision: current.revision + 1 };
    return current;
  });
  const cards = DEFAULT_LAYOUT.order.map((key) => ({
    key,
    name: key,
    content: <section aria-label={key}>{key}</section>,
  }));
  const view = render(
    <DashboardBlocks
      data={{ ...EMPTY_DASHBOARD, layout: current }}
      range={RANGE}
      loading={false}
      cards={cards}
      onChange={onChange}
    />,
  );
  const keys = (): string[] =>
    [...view.container.querySelectorAll('[data-block-key]')].map((item) =>
      item.getAttribute('data-block-key')!,
    );
  expect(keys()).toEqual([...DEFAULT_LAYOUT.order, 'custom:1']);
  await user.click(screen.getByRole('button', { name: 'Настроить блоки' }));
  await user.click(screen.getByRole('button', { name: 'Переместить «Мой блок» выше' }));
  await waitFor(() =>
    expect(keys()).toEqual(['residents', 'turnover', 'attendance', 'custom:1', 'reports']),
  );
  const reports = view.container.querySelector('[data-block-key="reports"]') as HTMLElement;
  await user.click(within(reports).getByRole('button', { name: 'Скрыть' }));
  await waitFor(() => expect(keys()).not.toContain('reports'));
  await user.click(screen.getByRole('button', { name: 'Скрытые (1)' }));
  await user.click(screen.getByRole('button', { name: 'Показать' }));
  await waitFor(() => expect(keys()).toContain('reports'));
  expect(save).toHaveBeenCalledTimes(3);
  // Неудачное сохранение не меняет показанный порядок.
  save.mockRejectedValueOnce(new ApiError(409, 'Дашборд уже изменён'));
  await user.click(screen.getByRole('button', { name: 'Переместить «Мой блок» выше' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Дашборд уже изменён');
  expect(keys()).toEqual(current.order);
  expect(onChange).toHaveBeenCalledTimes(4);
});

it('перетаскивает стандартную карточку в позицию пользовательской', async () => {
  const user = userEvent.setup();
  const layout = {
    ...DEFAULT_LAYOUT,
    blocks: [{ id: 1, config: CONFIG }],
    order: [...DEFAULT_LAYOUT.order, 'custom:1'],
  };
  const save = vi.spyOn(api, 'saveDashboardLayout').mockResolvedValue({
    ...layout,
    revision: 1,
    order: ['turnover', 'attendance', 'reports', 'custom:1', 'residents'],
  });
  const view = render(
    <DashboardBlocks
      data={{ ...EMPTY_DASHBOARD, layout }}
      range={RANGE}
      loading={false}
      cards={DEFAULT_LAYOUT.order.map((key) => ({
        key,
        name: key,
        content: <section>{key}</section>,
      }))}
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Настроить блоки' }));
  fireEvent.dragStart(screen.getByRole('img', { name: 'Перетащить блок «residents»' }), {
    dataTransfer: { setData: vi.fn(), effectAllowed: '' },
  });
  fireEvent.drop(view.container.querySelector('[data-block-key="custom:1"]')!);
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      revision: 0,
      order: ['turnover', 'attendance', 'reports', 'custom:1', 'residents'],
      hidden: [],
    }),
  );
});

it('меняет существующий блок на график, показывает предпросмотр и сохраняет источники', async () => {
  const user = userEvent.setup(),
    saved = vi.fn();
  vi.spyOn(api, 'dashboardSources').mockResolvedValue(CATALOG);
  const chartConfig: WidgetConfig = {
    ...CONFIG,
    display: 'chart',
    period: 'range',
    all_dormitories: false,
  };
  const result = {
    id: 1,
    value: 5,
    items: [],
    errors: [],
    daily: [
      { date: RANGE.from, value: 3 },
      { date: RANGE.to, value: 5 },
    ],
  };
  const preview = vi.spyOn(api, 'previewDashboardBlock').mockResolvedValue(result);
  const layout = {
    ...DEFAULT_LAYOUT,
    revision: 8,
    order: [...DEFAULT_LAYOUT.order, 'custom:1'],
    blocks: [{ id: 1, config: chartConfig }],
  };
  const save = vi.spyOn(api, 'saveDashboardBlock').mockResolvedValue(layout);
  const view = render(
    <WidgetDialog
      initial={{ id: 1, config: { ...CONFIG, all_dormitories: false } }}
      revision={7}
      range={RANGE}
      onClose={vi.fn()}
      onSaved={saved}
    />,
  );
  await screen.findByLabelText('Строка отчёта — Северное');
  await user.selectOptions(screen.getByLabelText('Отображение'), 'chart');
  expect(screen.queryByLabelText('Период расчёта')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Проверить расчёт' }));
  expect(await screen.findByRole('img', { name: 'Динамика: Мой блок' })).toBeInTheDocument();
  expect(preview).toHaveBeenCalledWith(chartConfig, RANGE.from, RANGE.to);
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(save).toHaveBeenCalledWith(7, chartConfig, 1);
  expect(saved).toHaveBeenCalledWith(layout);
  view.unmount();
  render(
    <DashboardBlocks
      data={{ ...EMPTY_DASHBOARD, layout, widgets: [result] }}
      range={RANGE}
      loading={false}
      cards={[]}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByRole('img', { name: 'Динамика: Мой блок' })).toBeInTheDocument();
  expect(screen.getByText('По дням · 01.10.2026 — 02.10.2026')).toBeInTheDocument();
});

it('график разрывает линию на пропусках, сохраняет нули и показывает отрицательные значения', () => {
  const range = { from: '2026-10-01', to: '2026-10-05' };
  render(
    <WidgetChart
      name="Динамика суммы"
      range={range}
      result={{
        id: 1,
        value: 4,
        items: [],
        errors: [],
        daily: [
          { date: '2026-10-01', value: -2 },
          { date: '2026-10-02', value: null },
          { date: '2026-10-03', value: 0 },
          { date: '2026-10-04', value: 4 },
        ],
      }}
    />,
  );
  const svg = screen.getByRole('img', { name: 'Динамика: Динамика суммы' });
  expect(svg.querySelectorAll('path')).toHaveLength(2);
  const points = [...svg.querySelectorAll('circle')];
  expect(points).toHaveLength(3);
  expect(points.map((point) => point.textContent?.trim())).toEqual([
    '01.10.2026: -2',
    '03.10.2026: 0',
    '04.10.2026: 4',
  ]);
  expect(
    points.every(
      (point) => Number(point.getAttribute('cy')) >= 18 && Number(point.getAttribute('cy')) <= 228,
    ),
  ).toBe(true);
  expect(screen.getByRole('table')).toHaveTextContent('02.10.2026—');
});

it('сохраняет режим сравнения общежитий и показывает легенду в предпросмотре', async () => {
  const user = userEvent.setup();
  vi.spyOn(api, 'dashboardSources').mockResolvedValue(CATALOG);
  const initial = { ...CONFIG, display: 'chart' as const, all_dormitories: false };
  const result = {
    id: 1,
    value: 2,
    items: [],
    errors: [],
    series: [
      {
        dormitory_id: 1,
        label: 'Северное',
        is_archived: false,
        daily: [{ date: RANGE.from, value: 2 }],
      },
    ],
  };
  const preview = vi.spyOn(api, 'previewDashboardBlock').mockResolvedValue(result);
  const save = vi
    .spyOn(api, 'saveDashboardBlock')
    .mockResolvedValue({ ...DEFAULT_LAYOUT, revision: 2 });
  render(
    <WidgetDialog
      initial={{ id: 1, config: initial }}
      revision={1}
      range={RANGE}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  await screen.findByLabelText('Строка отчёта — Северное');
  await user.selectOptions(screen.getByLabelText('Линии на графике'), 'dormitories');
  await user.click(screen.getByRole('button', { name: 'Проверить расчёт' }));
  expect(await screen.findByRole('group', { name: 'Общежития на графике' })).toHaveTextContent(
    'Северное',
  );
  expect(preview).toHaveBeenCalledWith(
    { ...initial, chart_mode: 'dormitories' },
    RANGE.from,
    RANGE.to,
  );
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(save).toHaveBeenCalledWith(1, { ...initial, chart_mode: 'dormitories' }, 1);
});

it('сравнивает независимые линии разными цветами, переключает легенду и сохраняет цвета по ID', async () => {
  const user = userEvent.setup();
  const series = [
    {
      dormitory_id: 4,
      label: 'Северное',
      is_archived: false,
      daily: [
        { date: RANGE.from, value: 3 },
        { date: RANGE.to, value: 0 },
      ],
    },
    {
      dormitory_id: 8,
      label: 'Южное',
      is_archived: true,
      daily: [
        { date: RANGE.from, value: null },
        { date: RANGE.to, value: -2 },
      ],
    },
  ];
  const result = { id: 1, value: null, items: [], errors: ['Пропуск'], series };
  const view = render(<WidgetChart name="Сравнение" range={RANGE} result={result} />);
  const svg = screen.getByRole('img', { name: 'Динамика: Сравнение' });
  const firstColor = svg.querySelector('[data-series-id="4"]')?.getAttribute('style');
  expect(svg.querySelectorAll('circle')).toHaveLength(3);
  expect(firstColor).not.toEqual(svg.querySelector('[data-series-id="8"]')?.getAttribute('style'));
  expect(screen.getByRole('columnheader', { name: 'Южное (Архив)' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Северное' }));
  expect(svg.querySelector('[data-series-id="4"]')).toBeNull();
  expect(svg.querySelectorAll('circle')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Южное (Архив)' }));
  expect(screen.getByRole('status')).toHaveTextContent('Выберите общежития');
  await user.click(screen.getByRole('button', { name: 'Северное' }));
  expect(svg.querySelector('[data-series-id="4"]')?.getAttribute('style')).toEqual(firstColor);
  view.rerender(
    <WidgetChart
      name="Сравнение"
      range={RANGE}
      result={{ ...result, series: [series[1], { ...series[0], label: 'Новое название' }] }}
    />,
  );
  expect(svg.querySelector('[data-series-id="4"]')?.getAttribute('style')).toEqual(firstColor);
  expect(screen.getByRole('button', { name: 'Новое название' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

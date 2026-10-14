import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { CatalogDormitory } from '../../api/dashboardBlocks';
import { statisticsApi } from '../../api/statistics';
import type { StatisticsReport, StatisticsResult } from '../../api/statistics';
import { Statistics } from '../Statistics';
import { newBlock } from './helpers';
import { StatisticsChart } from './StatisticsChart';
import { StatisticsEditor } from './StatisticsEditor';

afterEach(() => vi.restoreAllMocks());
const catalog: CatalogDormitory[] = [
  {
    id: 1,
    name: 'Северное',
    is_archived: false,
    sources: [
      {
        key: 'report',
        name: 'Общий отчёт',
        kind: 'report',
        rows: [{ id: 10, name: 'Выход Итого' }],
        columns: [],
        hostels: [],
      },
      {
        key: 'arrival_plan',
        name: 'План заездов',
        kind: 'arrival_plan',
        rows: [],
        columns: [],
        hostels: [],
      },
    ],
  },
];
const range = { from: '2026-10-01', to: '2026-10-03' };
const report: StatisticsReport = {
  id: 7,
  name: 'Выход персонала',
  description: '',
  visibility: 'personal',
  revision: 0,
  blocks: [],
  created_by_id: 1,
  created_by_name: 'Автор',
  can_manage: true,
  created_at: '2026-10-10T00:00:00Z',
  updated_at: '2026-10-10T00:00:00Z',
};
const result: StatisticsResult = {
  id: 'b',
  value: 17,
  items: [{ dormitory_id: 1, label: 'Северное', is_archived: false, value: 17 }],
  daily: [{ date: '2026-10-01', value: 17 }],
  series: [
    {
      dormitory_id: 1,
      label: 'Северное',
      is_archived: false,
      daily: [{ date: '2026-10-01', value: 17 }],
    },
  ],
  errors: [],
};
function mocks(): void {
  vi.spyOn(statisticsApi, 'sources').mockResolvedValue(catalog);
  vi.spyOn(statisticsApi, 'reports').mockResolvedValue([]);
  vi.spyOn(statisticsApi, 'report').mockResolvedValue(report);
  vi.spyOn(statisticsApi, 'data').mockResolvedValue({
    revision: 0,
    from_date: range.from,
    to_date: range.to,
    through_date: range.to,
    results: [],
  });
  vi.spyOn(statisticsApi, 'preview').mockResolvedValue(result);
}
function page(path = '/cabinet/statistics/7'): JSX.Element {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/cabinet/statistics" element={<Statistics />} />
        <Route path="/cabinet/statistics/:reportId" element={<Statistics />} />
      </Routes>
    </MemoryRouter>
  );
}

it('выбирает план заездов как источник статистики и сохраняет расчёт на будущие даты', async () => {
  mocks();
  const user = userEvent.setup();
  const save = vi.fn();
  const future = { from: '2027-10-20', to: '2027-10-22' };
  render(
    <StatisticsEditor
      initial={newBlock(catalog)!}
      catalog={catalog}
      range={future}
      busy={false}
      onSave={save}
      onCancel={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  await user.selectOptions(screen.getByLabelText('Откуда брать данные'), 'arrival_plan');
  expect(screen.queryByText('Связи с другими общежитиями')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Строка отчёта')).not.toBeInTheDocument();
  expect(screen.getByText(/Количество ожидаемых людей по датам заезда/)).toBeInTheDocument();
  await waitFor(() =>
    expect(statisticsApi.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          source_kind: 'arrival_plan',
          period: 'range',
          sources: [{ kind: 'arrival_plan', dormitory_id: 1 }],
        }),
      }),
      future,
      expect.any(AbortSignal),
    ),
  );
  await user.click(screen.getByRole('button', { name: 'Сохранить блок' }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ query: expect.objectContaining({ source_kind: 'arrival_plan' }) }),
  );
});

it('объясняет расчёт будущих дат для отчёта с планом заездов', async () => {
  mocks();
  const planned = newBlock(catalog)!;
  planned.query.source_kind = 'arrival_plan';
  planned.query.sources = [{ kind: 'arrival_plan', dormitory_id: 1 }];
  vi.mocked(statisticsApi.report).mockResolvedValue({ ...report, blocks: [planned] });
  vi.mocked(statisticsApi.data).mockResolvedValue({
    revision: 0,
    from_date: range.from,
    to_date: range.to,
    through_date: null,
    results: [],
  });
  render(page());
  expect(
    await screen.findByText(
      'План заездов учитывается за весь выбранный период, включая будущие даты.',
    ),
  ).toBeInTheDocument();
  expect(screen.getByText('План заездов / Ожидается человек')).toBeInTheDocument();
  expect(screen.queryByText(/Будущие даты не учитываются/)).not.toBeInTheDocument();
});

it('показывает нули в будущих днях без заездов и объясняет их в таблице', () => {
  const planned = newBlock(catalog)!;
  planned.display = 'table';
  planned.query.source_kind = 'arrival_plan';
  planned.query.sources = [{ kind: 'arrival_plan', dormitory_id: 1 }];
  const future = { from: '2027-10-20', to: '2027-10-22' };
  const daily = [
    { date: future.from, value: 10 },
    { date: '2027-10-21', value: 0 },
    { date: future.to, value: 7 },
  ];
  render(
    <StatisticsChart
      block={planned}
      range={future}
      result={{ ...result, daily, series: [{ ...result.series![0], daily }] }}
    />,
  );
  expect(screen.getAllByRole('cell', { name: '0' })).toHaveLength(2);
  expect(screen.getByText(/0 — заезды на эту дату не запланированы/)).toBeInTheDocument();
  expect(screen.queryByText(/дата ещё не наступила/)).not.toBeInTheDocument();
});

it('создаёт отчёт через API, сохраняет блок с версией и открывает сохранённый отчёт повторно', async () => {
  mocks();
  const user = userEvent.setup();
  const create = vi.spyOn(statisticsApi, 'create').mockResolvedValue(report);
  let saved = report;
  const save = vi.spyOn(statisticsApi, 'save').mockImplementation(async (id, input) => {
    saved = { ...report, ...input, id, revision: 1 };
    vi.mocked(statisticsApi.report).mockResolvedValue(saved);
    vi.mocked(statisticsApi.data).mockResolvedValue({
      revision: 1,
      from_date: range.from,
      to_date: range.to,
      through_date: range.to,
      results: [{ ...result, id: saved.blocks[0].id }],
    });
    return saved;
  });
  const view = render(page('/cabinet/statistics'));
  await user.click((await screen.findAllByRole('button', { name: 'Создать отчёт' }))[0]);
  const dialog = screen.getByRole('dialog');
  await user.type(within(dialog).getByLabelText('Название отчёта'), 'Выход персонала');
  await user.selectOptions(within(dialog).getByLabelText('Доступ'), 'personal');
  await user.click(within(dialog).getByRole('button', { name: 'Создать отчёт' }));
  expect(create).toHaveBeenCalledWith({
    name: 'Выход персонала',
    description: '',
    visibility: 'personal',
    blocks: [],
  });
  await user.click(await screen.findByRole('button', { name: 'Добавить первый блок' }));
  await user.clear(screen.getByLabelText('Название блока'));
  await user.type(screen.getByLabelText('Название блока'), 'Выход по датам');
  await user.click(screen.getByRole('button', { name: 'Таблица' }));
  await user.click(screen.getByRole('button', { name: 'Сохранить блок' }));
  await screen.findByRole('heading', { name: 'Выход по датам' });
  expect(save).toHaveBeenCalledWith(
    7,
    expect.objectContaining({
      revision: 0,
      blocks: [
        expect.objectContaining({
          name: 'Выход по датам',
          display: 'table',
          query: expect.objectContaining({
            sources: [{ kind: 'report', dormitory_id: 1, row_id: 10 }],
          }),
        }),
      ],
    }),
  );
  view.unmount();
  render(page());
  await screen.findByRole('heading', { name: 'Выход по датам' });
  expect(await screen.findByRole('table', { name: /Выход по датам/ })).toBeInTheDocument();
});

it('подхватывает новые строки и вкладки при возвращении в окно без потери черновика', async () => {
  mocks();
  const user = userEvent.setup();
  render(page());
  await user.click(await screen.findByRole('button', { name: 'Добавить первый блок' }));
  await user.clear(screen.getByLabelText('Название блока'));
  await user.type(screen.getByLabelText('Название блока'), 'Мой черновик');
  const next = structuredClone(catalog);
  next[0].sources[0].rows.push({ id: 11, name: 'Сверхурочный выход' });
  next[0].sources.push({
    key: 'custom_1',
    name: 'Новая вкладка',
    kind: 'table',
    rows: [],
    columns: [],
    hostels: [],
  });
  vi.mocked(statisticsApi.sources).mockResolvedValue(next);
  fireEvent(window, new Event('focus'));
  await screen.findByRole('option', { name: 'Сверхурочный выход' });
  expect(screen.getByLabelText('Название блока')).toHaveValue('Мой черновик');
  await user.selectOptions(screen.getByLabelText('Откуда брать данные'), 'custom_1');
  expect(screen.getByRole('option', { name: 'Новая вкладка' })).toBeInTheDocument();
  expect(screen.getByLabelText('Название блока')).toHaveValue('Мой черновик');
  expect(statisticsApi.report).toHaveBeenCalledTimes(1);
});

it('отменяет устаревший предпросмотр, чтобы старые значения не заменили новый расчёт', async () => {
  const initial = newBlock(catalog)!;
  initial.display = 'number';
  let finishFirst: (result: StatisticsResult) => void = () => undefined;
  const preview = vi
    .spyOn(statisticsApi, 'preview')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    )
    .mockResolvedValue({ ...result, value: 99 });
  render(
    <StatisticsEditor
      initial={initial}
      catalog={catalog}
      range={range}
      busy={false}
      onSave={vi.fn()}
      onCancel={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
  const firstSignal = preview.mock.calls[0][2];
  fireEvent.change(screen.getByLabelText('Название блока'), { target: { value: 'Новый расчёт' } });
  expect(firstSignal?.aborted).toBe(true);
  await screen.findByText('99');
  await act(async () => finishFirst({ ...result, value: 12345 }));
  expect(screen.queryByText('12 345')).not.toBeInTheDocument();
  expect(screen.getByText('99')).toBeInTheDocument();
});

it('сохраняет черновик при конфликте версий и не подменяет пропуски нулём', async () => {
  mocks();
  const user = userEvent.setup();
  vi.spyOn(statisticsApi, 'save').mockRejectedValue(
    new ApiError(409, 'Отчёт уже изменён другим пользователем.'),
  );
  render(page());
  await user.click(await screen.findByRole('button', { name: 'Добавить первый блок' }));
  await user.click(screen.getByRole('button', { name: 'Сохранить блок' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Отчёт уже изменён');
  expect(screen.getByLabelText('Название блока')).toHaveValue('Новый блок');
});

it('показывает пропуски и будущие даты в таблице, а отрицательные значения — на графике', () => {
  const block = newBlock(catalog)!;
  block.display = 'table';
  const missing = {
    ...result,
    value: null,
    daily: [{ date: range.from, value: null }],
    series: [{ ...result.series![0], daily: [{ date: range.from, value: null }] }],
    items: [{ ...result.items[0], value: null }],
  };
  const view = render(<StatisticsChart block={block} result={missing} range={range} />);
  expect(screen.getAllByText('—').length).toBeGreaterThan(4);
  expect(screen.queryByText('0')).not.toBeInTheDocument();
  view.rerender(
    <StatisticsChart
      block={{ ...block, display: 'bar' }}
      result={{ ...result, daily: [{ date: range.from, value: -7 }] }}
      range={range}
    />,
  );
  const chart = screen.getByRole('img');
  const bar = chart.querySelector('rect');
  expect(bar?.textContent).toBe('01.10: -7');
  expect(Number(bar?.getAttribute('height'))).toBeGreaterThan(0);
  expect(bar?.getAttribute('y')).toBe(
    chart.querySelector('line[stroke="#cbd6cc"]')?.getAttribute('y1'),
  );
});

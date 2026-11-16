import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { WidgetConfig, WidgetResult } from '../../api/dashboardBlocks';
import { DEFAULT_LAYOUT } from '../../api/dashboardBlocks';
import { SummaryReport } from './SummaryReport';
import { WidgetDialog } from './WidgetDialog';

afterEach(() => vi.restoreAllMocks());
const config: WidgetConfig = {
  name: 'Сводный',
  display: 'summary',
  source_kind: 'report',
  period: 'range',
  operation: 'sum',
  grouping: 'dormitory',
  sources: [],
  all_dormitories: true,
  excluded_dormitory_ids: [],
  summary: {
    view: 'daily',
    label: 'client',
    dormitory_ids: [],
    metrics: [{ name: 'Выход', aggregate: 'sum', sources: [] }],
  },
};
function result(days: number): WidgetResult {
  const dates = Array.from({ length: days }, (_, index) =>
    new Date(Date.UTC(2026, 9, index + 1)).toISOString().slice(0, 10),
  );
  return {
    id: 1,
    value: null,
    items: [],
    errors: [],
    summary: {
      dates,
      rows: [
        {
          dormitory_id: 1,
          label: 'Клиент (Северное)',
          metric: 'Выход',
          aggregate: 'sum',
          value: null,
          daily: dates.map((date) => ({ date, value: null })),
        },
      ],
    },
  };
}
it('включает прокрутку только после 31 дня и сохраняет пропуски', () => {
  const { rerender } = render(<SummaryReport config={config} result={result(31)} />);
  expect(screen.getByTestId('summary-report')).toHaveAttribute('data-scroll', 'false');
  expect(screen.getAllByText('—').length).toBeGreaterThan(30);
  rerender(<SummaryReport config={config} result={result(32)} />);
  expect(screen.getByTestId('summary-report')).toHaveAttribute('data-scroll', 'true');
  expect(screen.getByRole('region')).toHaveAttribute('tabindex', '0');
});
it('показывает клиента одной ячейкой и названия выбранных строк во втором столбце', () => {
  const data = result(31);
  const row = data.summary!.rows[0];
  data.summary!.rows.push({ ...row, metric: 'Проживает', row_name: 'Живут сегодня' });
  render(<SummaryReport config={config} result={data} />);
  const table = within(screen.getByRole('table'));
  const rows = table.getAllByRole('row');
  expect(within(rows[1]).getByText(row.label).closest('th')).toHaveAttribute('rowspan', '2');
  expect(within(rows[1]).getByRole('rowheader', { name: 'Выход' })).toBeInTheDocument();
  expect(within(rows[2]).getByRole('rowheader', { name: 'Живут сегодня' })).toBeInTheDocument();
  expect(table.getAllByText(row.label)).toHaveLength(1);
});
it('конструктор объединяет названия и сохраняет способ расчёта и выбранные общежития', async () => {
  vi.spyOn(api, 'dashboardSources').mockResolvedValue(
    [1, 2].map((id) => ({
      id,
      name: `Общежитие ${id}`,
      is_archived: false,
      sources: [
        {
          key: 'report',
          name: 'Отчёт',
          kind: 'report',
          columns: [],
          hostels: [],
          rows: [{ id: id * 10, name: id === 1 ? 'Выход' : '  ВЫХОД  ' }],
        },
      ],
    })),
  );
  const save = vi.spyOn(api, 'saveDashboardBlock').mockResolvedValue(DEFAULT_LAYOUT);
  const user = userEvent.setup();
  render(
    <WidgetDialog
      initial={null}
      revision={0}
      range={{ from: '2026-10-01', to: '2026-10-31' }}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  await user.type(screen.getByLabelText('Название блока'), 'Большой сводный');
  await user.selectOptions(screen.getByLabelText('Отображение'), 'summary');
  expect(await screen.findAllByRole('checkbox', { name: 'Выход' })).toHaveLength(1);
  await user.click(screen.getByRole('checkbox', { name: 'Выход' }));
  await user.selectOptions(screen.getByLabelText('Расчёт — Выход'), 'average');
  await user.selectOptions(screen.getByLabelText('Подписи общежитий'), 'client');
  await user.click(screen.getByRole('button', { name: 'Добавить блок' }));
  expect(save).toHaveBeenCalledWith(
    0,
    expect.objectContaining({
      display: 'summary',
      sources: [],
      summary: expect.objectContaining({
        label: 'client',
        metrics: [
          {
            name: 'Выход',
            aggregate: 'average',
            sources: [
              { kind: 'report', dormitory_id: 1, row_id: 10 },
              { kind: 'report', dormitory_id: 2, row_id: 20 },
            ],
          },
        ],
      }),
    }),
    undefined,
  );
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { DEFAULT_LAYOUT } from '../../api/dashboardBlocks';
import { DashboardBlocks } from './DashboardBlocks';
import { EMPTY_DASHBOARD } from './data';

afterEach(() => vi.restoreAllMocks());

it('переименовывает встроенный блок и запрашивает его собственный период', async () => {
  const save = vi.spyOn(api, 'saveDashboardLayout').mockImplementation(async (input) => ({
    ...DEFAULT_LAYOUT,
    ...input,
    revision: 1,
  }));
  const load = vi
    .spyOn(api, 'dashboardBreakdown')
    .mockImplementation(async (_metric, _from, to) => ({
      to_date: to,
      items: [{ id: '1', label: 'Северное', value: 42 }],
    }));
  const user = userEvent.setup();
  render(
    <DashboardBlocks
      data={{ ...EMPTY_DASHBOARD, layout: DEFAULT_LAYOUT }}
      range={{ from: '2025-10-01', to: '2025-10-31' }}
      loading={false}
      cards={[{ key: 'residents', metric: 'residents', name: 'Вахтовики по общежитиям' }]}
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Настроить блоки' }));
  await user.click(screen.getByRole('button', { name: 'Настроить «Вахтовики по общежитиям»' }));
  await user.clear(screen.getByLabelText('Название блока'));
  await user.type(screen.getByLabelText('Название блока'), 'Жильцы');
  await user.selectOptions(screen.getByLabelText('Выбор дат'), 'range');
  await user.selectOptions(screen.getByLabelText('Показатель за период'), 'average');
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  const block = within(await screen.findByRole('region', { name: 'Жильцы' }));
  expect(save.mock.calls[0][0].builtin_settings?.residents).toEqual({
    name: 'Жильцы',
    date_mode: 'range',
    aggregate: 'average',
  });
  fireEvent.change(block.getByLabelText('От'), { target: { value: '2025-09-01' } });
  fireEvent.change(block.getByLabelText('До'), { target: { value: '2025-09-03' } });
  await user.click(block.getByRole('button', { name: 'Показать' }));
  await waitFor(() =>
    expect(load).toHaveBeenLastCalledWith(
      'residents',
      '2025-09-01',
      '2025-09-03',
      'average',
      expect.any(AbortSignal),
    ),
  );
  expect(await block.findByText('Среднее · 01.09.2025 — 03.09.2025')).toBeInTheDocument();
});

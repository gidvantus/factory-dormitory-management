import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { personnelApi } from '../../api/personnel';
import * as session from '../../auth/SessionProvider';
import { Personnel } from '../Personnel';
import { addDays } from './helpers';

afterEach(() => vi.restoreAllMocks());
it('загружает только выбранную неделю и общежитие, не запрашивает реестр сотрудников', async () => {
  const user = userEvent.setup();
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  const workspace = vi.spyOn(personnelApi, 'workspace');
  const arrivals = vi.spyOn(personnelApi, 'arrivals').mockImplementation(async (range) => ({
    from: range?.from ?? '2026-10-27',
    to: range?.to ?? '2026-11-02',
    today: '2026-10-27',
    dormitories: [{ id: 1, name: 'Северное', client_name: 'Клиент', is_archived: false }],
    arrival_plans: [],
  }));
  render(
    <MemoryRouter initialEntries={['/cabinet/personnel?view=planning&dormitory=1']}>
      <Personnel />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'Следующие 7 дней' });
  expect(arrivals).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Следующие 7 дней' }));
  await waitFor(() =>
    expect(arrivals).toHaveBeenLastCalledWith(
      { from: '2026-11-03', to: addDays('2026-11-03', 6) },
      1,
      expect.any(AbortSignal),
    ),
  );
  await user.click(await screen.findByRole('button', { name: 'Сегодня' }));
  await waitFor(() =>
    expect(arrivals).toHaveBeenLastCalledWith(
      { from: '2026-10-27', to: '2026-11-02' },
      1,
      expect.any(AbortSignal),
    ),
  );
  expect(workspace).not.toHaveBeenCalled();
});

it('открывает исходный заезд по ссылке из проживания, включая архивное общежитие', async () => {
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  vi.spyOn(personnelApi, 'arrivals').mockResolvedValue({
    from: '2026-10-01',
    to: '2026-10-07',
    today: '2026-10-27',
    dormitories: [],
    arrival_plans: [],
  });
  const source = vi.spyOn(personnelApi, 'arrival').mockResolvedValue({
    id: 'source',
    dormitory_id: 3,
    dormitory_name: 'Архивное',
    is_archived: true,
    date: '2026-10-01',
    count: 1,
    names: ['Архивный сотрудник'],
    people: [{ id: 'person', full_name: 'Архивный сотрудник', custom_values: {} }],
    revision: 1,
    workflow: {
      person: {
        status: 'arrived',
        arrived_on: '2026-10-01',
        origin: null,
        destination: null,
        resident: null,
        settlement: null,
        employee_id: null,
        history: [],
      },
    },
  });
  render(
    <MemoryRouter
      initialEntries={[
        '/cabinet/personnel?view=planning&dormitory=3&date=2026-10-01&arrival=source',
      ]}
    >
      <Personnel />
    </MemoryRouter>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Информация о заезде' });
  expect(source).toHaveBeenCalledWith('source', expect.any(AbortSignal));
  expect(within(dialog).getByText('Архивное')).toBeInTheDocument();
  expect(within(dialog).getByText(/Общежитие в архиве/)).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'В проживающие' })).toBeDisabled();
  expect(within(dialog).queryByRole('button', { name: 'Изменить заезд' })).not.toBeInTheDocument();
});

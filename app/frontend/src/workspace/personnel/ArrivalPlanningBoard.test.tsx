import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { personnelApi } from '../../api/personnel';
import type { ArrivalPlan, PersonnelData } from '../../api/personnel';
import { ArrivalPlanningBoard } from './ArrivalPlanningBoard';

afterEach(() => vi.restoreAllMocks());
const plan: ArrivalPlan = {
  id: 'plan',
  dormitory_id: 1,
  date: '2026-10-20',
  count: 10,
  names: ['Иванов Иван'],
  revision: 0,
};
const data: PersonnelData = {
  today: '2026-10-20',
  dormitories: [
    { id: 1, name: 'Северное', client_name: 'Клиент', is_archived: false },
    { id: 2, name: 'Южное', client_name: 'Клиент', is_archived: false },
    { id: 3, name: 'Старое', client_name: 'Клиент', is_archived: true },
  ],
  employees: [],
  plans: [],
  arrival_plans: [plan, { ...plan, id: 'archived', dormitory_id: 3, count: 100 }],
  decisions: [],
  preferences: { revision: 0, blocks: [], lists: [] },
};
const mutate = async (action: () => Promise<unknown>): Promise<void> => {
  await action();
};

it('показывает действующие общежития и считает людей независимо от ФИО', () => {
  render(<ArrivalPlanningBoard data={data} dormitory={null} mutate={mutate} />);
  expect(screen.getByText('Ожидается за период: 10 чел.')).toBeInTheDocument();
  expect(screen.getByRole('rowheader', { name: /Северное/ })).toBeInTheDocument();
  expect(screen.getByRole('rowheader', { name: /Южное/ })).toBeInTheDocument();
  expect(screen.queryByText('Старое')).not.toBeInTheDocument();
  expect(screen.getByText('Иванов Иван')).toBeInTheDocument();
  expect(screen.queryByText('Выезды')).not.toBeInTheDocument();
  expect(screen.queryByText('Ожидают подтверждения')).not.toBeInTheDocument();
});

it('сохраняет вручную количество и необязательные ФИО без карточек сотрудников', async () => {
  const user = userEvent.setup();
  const create = vi.spyOn(personnelApi, 'createArrival').mockResolvedValue(plan);
  render(<ArrivalPlanningBoard data={data} dormitory={null} mutate={mutate} />);
  await user.click(screen.getByRole('button', { name: 'Добавить заезд: Южное, 2026-10-21' }));
  const dialog = screen.getByRole('dialog', { name: 'Добавить заезд' });
  await user.clear(within(dialog).getByLabelText('Количество человек'));
  await user.type(within(dialog).getByLabelText('Количество человек'), '10');
  await user.type(within(dialog).getByLabelText('ФИО (необязательно)'), 'Иванов Иван\nПетров Пётр');
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить заезд' }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      dormitory_id: 2,
      date: '2026-10-21',
      count: 10,
      names: ['Иванов Иван', 'Петров Пётр'],
    }),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('редактирует запись с ревизией и подтверждает удаление', async () => {
  const user = userEvent.setup();
  const update = vi.spyOn(personnelApi, 'updateArrival').mockResolvedValue(plan);
  const remove = vi.spyOn(personnelApi, 'deleteArrival').mockResolvedValue(undefined);
  render(<ArrivalPlanningBoard data={data} dormitory={1} mutate={mutate} />);
  expect(screen.queryByRole('rowheader', { name: /Южное/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Изменить заезд: Северное, 2026-10-20' }));
  await user.clear(screen.getByLabelText('Количество человек'));
  await user.type(screen.getByLabelText('Количество человек'), '12');
  await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith('plan', {
      dormitory_id: 1,
      date: '2026-10-20',
      count: 12,
      names: ['Иванов Иван'],
      revision: 0,
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Изменить заезд: Северное, 2026-10-20' }));
  await user.click(screen.getByRole('button', { name: 'Удалить заезд' }));
  expect(remove).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Да, удалить' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('plan', 0));
});

it('разрешает количество без ФИО и показывает ошибку при избытке ФИО', async () => {
  const user = userEvent.setup();
  const create = vi.spyOn(personnelApi, 'createArrival').mockResolvedValue(plan);
  render(<ArrivalPlanningBoard data={data} dormitory={null} mutate={mutate} />);
  await user.click(screen.getByRole('button', { name: 'Добавить заезд: Южное, 2026-10-20' }));
  await user.type(screen.getByLabelText('ФИО (необязательно)'), 'Иванов\nПетров');
  await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Количество ФИО не должно превышать');
  expect(create).not.toHaveBeenCalled();
  await user.clear(screen.getByLabelText('ФИО (необязательно)'));
  await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      dormitory_id: 2,
      date: '2026-10-20',
      count: 1,
      names: [],
    }),
  );
});

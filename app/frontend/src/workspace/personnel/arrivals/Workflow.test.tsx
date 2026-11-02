import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../../api/client';
import { personnelApi } from '../../../api/personnel';
import type { ArrivalPlan, ArrivalVisit } from '../../../api/personnel';
import { ArrivalPlanningBoard } from './ArrivalPlanningBoard';
import { defaultConfiguration } from './adapter';

afterEach(() => vi.restoreAllMocks());
const plan: ArrivalPlan = {
  id: 'plan',
  dormitory_id: 1,
  date: '2026-10-27',
  count: 2,
  names: ['Александр Волков', 'Михаил Соколов'],
  people: [
    {
      id: 'alex',
      full_name: 'Александр Волков',
      custom_values: { shifts: '15', workdate: '2026-10-28' },
    },
    { id: 'mikhail', full_name: 'Михаил Соколов', custom_values: { shifts: '30' } },
  ],
  custom_values: { comment: 'Встреча в 09:00' },
  revision: 4,
};
const ref = { plan_id: 'target', person_id: 'moved-alex', date: '2026-11-10', dormitory_id: 1 };
const state = (status: ArrivalVisit['status']): ArrivalVisit => ({
  status,
  arrived_on: '2026-10-27',
  origin: null,
  destination: null,
  history: [],
  settlement: null,
  resident: null,
  employee_id: null,
});
const mutate = async (action: () => Promise<unknown>): Promise<void> => {
  await action();
};
function show(arrival = plan, onPeriodChange?: (date: string) => void): void {
  render(
    <MemoryRouter>
      <ArrivalPlanningBoard
        data={{
          today: '2026-10-27',
          dormitories: [{ id: 1, name: 'Северное', client_name: 'Клиент', is_archived: false }],
          arrival_plans: [arrival],
          arrival_settings: defaultConfiguration(),
        }}
        dormitory={1}
        mutate={mutate}
        onPeriodChange={onPeriodChange}
      />
    </MemoryRouter>,
  );
}
it('сохраняет отметку одного человека с ревизией, при ошибке оставляет ожидаемым', async () => {
  const user = userEvent.setup();
  const marked = { ...plan, revision: 5, workflow: { alex: state('arrived') } };
  const mark = vi
    .spyOn(personnelApi, 'markArrival')
    .mockRejectedValueOnce(new ApiError(409, 'План уже изменён.'))
    .mockResolvedValueOnce({ plans: [marked], deleted_plan_ids: [] });
  show();
  const alex = screen.getByTestId('arrival-person-alex');
  await user.click(within(alex).getByRole('button', { name: 'Прибыл' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('План уже изменён.');
  expect(alex).toHaveAttribute('data-status', 'expected');
  await user.click(within(alex).getByRole('button', { name: 'Прибыл' }));
  await waitFor(() => expect(alex).toHaveAttribute('data-status', 'arrived'));
  expect(mark).toHaveBeenLastCalledWith('plan', 'alex', 'arrived', 4);
  expect(screen.getByTestId('arrival-person-mikhail')).toHaveAttribute('data-status', 'expected');
  expect(screen.getByText('Ожидается за период: 1 чел.')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it.each(['2026-10-29', '2026-11-10'])(
  'после переноса на %s сохраняет выбранный день и текущую неделю',
  async (moveDate) => {
    const user = userEvent.setup();
    const changed = {
      ...plan,
      count: 1,
      people: [plan.people![1]],
      names: ['Михаил Соколов'],
      revision: 5,
      workflow: {},
    };
    const target = {
      ...plan,
      id: 'target',
      date: moveDate,
      count: 1,
      people: [{ ...plan.people![0], id: 'moved-alex' }],
      revision: 0,
      workflow: {
        'moved-alex': {
          ...state('expected'),
          origin: { ...ref, plan_id: 'plan', person_id: 'alex', date: plan.date },
        },
      },
    };
    const move = vi
      .spyOn(personnelApi, 'moveArrival')
      .mockResolvedValue({ plans: [changed, target], deleted_plan_ids: [] });
    const period = vi.fn();
    show(plan, period);
    await user.click(
      within(screen.getByTestId('arrival-person-alex')).getByRole('button', { name: 'Перенести' }),
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Новая дата заезда'), {
      target: { value: moveDate },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Перенести заезд' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(move).toHaveBeenCalledWith('plan', 'alex', moveDate, 4);
    expect(screen.getByLabelText('Начало периода плана')).toHaveValue(plan.date);
    expect(screen.getByRole('button', { name: `Выбрать дату: ${plan.date}` })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('arrival-person-mikhail')).toBeInTheDocument();
    expect(screen.queryByTestId('arrival-person-alex')).not.toBeInTheDocument();
    expect(screen.queryByTestId('arrival-person-moved-alex')).not.toBeInTheDocument();
    expect(period).toHaveBeenCalledTimes(1);
    expect(period).toHaveBeenLastCalledWith(plan.date);
    fireEvent.change(screen.getByLabelText('Начало периода плана'), {
      target: { value: moveDate },
    });
    const person = screen.getByTestId('arrival-person-moved-alex');
    expect(person).toHaveAttribute('data-status', 'expected');
    expect(within(person).getByText('15')).toBeInTheDocument();
    for (const label of ['Прибыл', 'Не приехал', 'Перенести']) {
      expect(within(person).getByRole('button', { name: label })).toBeEnabled();
    }
    expect(period).toHaveBeenLastCalledWith(moveDate);
    expect(screen.queryByTestId('arrival-person-alex')).not.toBeInTheDocument();
    const note = within(person).getByText(/Перенесён с/);
    expect(note.tagName).toBe('SMALL');
    expect(note.closest('button,a')).toBeNull();
    expect(
      within(person).queryByRole('button', { name: /Отменить перенос|Открыть|Перенесён с/ }),
    ).not.toBeInTheDocument();
  },
);

it.each(['arrived', 'no_show'] as const)(
  'для статуса %s оставляет только «Изменить статус» и возвращает три выбора',
  async (status) => {
    const user = userEvent.setup();
    const chosen = { ...plan, workflow: { alex: state(status) } };
    const other = status === 'arrived' ? 'no_show' : 'arrived';
    const mark = vi
      .spyOn(personnelApi, 'markArrival')
      .mockResolvedValueOnce({
        plans: [{ ...plan, revision: 5, workflow: { alex: state('expected') } }],
        deleted_plan_ids: [],
      })
      .mockResolvedValueOnce({
        plans: [{ ...plan, revision: 6, workflow: { alex: state(other) } }],
        deleted_plan_ids: [],
      });
    show(chosen);
    const alex = screen.getByTestId('arrival-person-alex');
    expect(
      within(alex)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Александр Волков', 'Изменить статус']);
    expect(screen.queryByRole('button', { name: 'Заселить' })).not.toBeInTheDocument();
    await user.click(within(alex).getByRole('button', { name: 'Изменить статус' }));
    await waitFor(() => expect(alex).toHaveAttribute('data-status', 'expected'));
    for (const label of ['Прибыл', 'Не приехал', 'Перенести']) {
      expect(within(alex).getByRole('button', { name: label })).toBeEnabled();
    }
    expect(mark).toHaveBeenNthCalledWith(1, 'plan', 'alex', 'expected', 4);
    await user.click(
      within(alex).getByRole('button', { name: other === 'arrived' ? 'Прибыл' : 'Не приехал' }),
    );
    await waitFor(() => expect(alex).toHaveAttribute('data-status', other));
    expect(mark).toHaveBeenNthCalledWith(2, 'plan', 'alex', other, 5);
    expect(within(alex).getByRole('button', { name: 'Изменить статус' })).toBeEnabled();
    expect(within(alex).queryByRole('button', { name: 'Перенести' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  },
);

it('при ошибке смены решения сохраняет выбранный статус и даёт повторить', async () => {
  const user = userEvent.setup();
  vi.spyOn(personnelApi, 'markArrival')
    .mockRejectedValueOnce(new ApiError(409, 'План уже изменён.'))
    .mockResolvedValueOnce({
      plans: [{ ...plan, revision: 5, workflow: { alex: state('expected') } }],
      deleted_plan_ids: [],
    });
  show({ ...plan, workflow: { alex: state('arrived') } });
  const alex = screen.getByTestId('arrival-person-alex');
  await user.click(within(alex).getByRole('button', { name: 'Изменить статус' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('План уже изменён.');
  expect(alex).toHaveAttribute('data-status', 'arrived');
  await user.click(within(alex).getByRole('button', { name: 'Изменить статус' }));
  await waitFor(() => expect(alex).toHaveAttribute('data-status', 'expected'));
});

it('показывает прежнюю отметку заселения как прибытие без переходов в проживающие', () => {
  show({
    ...plan,
    workflow: { alex: { ...state('settled'), resident: { id: 42, dormitory_id: 1 } } },
  });
  const alex = screen.getByTestId('arrival-person-alex');
  expect(alex).toHaveAttribute('data-status', 'arrived');
  expect(within(alex).getByText('Прибыл')).toBeInTheDocument();
  expect(within(alex).queryByRole('link')).not.toBeInTheDocument();
  expect(within(alex).getByRole('button', { name: 'Изменить статус' })).toBeEnabled();
});

it('позволяет добавить человека в освободившийся день без перенесённых строк в форме', async () => {
  const user = userEvent.setup();
  const update = vi
    .spyOn(personnelApi, 'updateArrival')
    .mockResolvedValue({ ...plan, revision: 6 });
  show({ ...plan, count: 0, people: [], names: [], workflow: {} });
  expect(screen.queryByTestId('arrival-person-alex')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Добавить заезд: Северное, 2026-10-27' }));
  const dialog = screen.getByRole('dialog');
  const input = within(dialog).getByRole('textbox', { name: 'ФИО, человек 1' });
  expect(input).toHaveValue('');
  await user.type(input, 'Новый человек');
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить заезд' }));
  await waitFor(() => expect(update).toHaveBeenCalled());
  expect(update).toHaveBeenCalledWith(
    'plan',
    expect.objectContaining({
      count: 1,
      revision: 4,
      people: [expect.objectContaining({ full_name: 'Новый человек' })],
    }),
  );
});

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

it('переносит на дату вне недели и открывает ожидаемый приезд в новой дате', async () => {
  const user = userEvent.setup();
  const changed = {
    ...plan,
    revision: 5,
    workflow: { alex: { ...state('moved'), destination: ref } },
  };
  const target = {
    ...plan,
    id: 'target',
    date: ref.date,
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
    target: { value: ref.date },
  });
  await user.click(within(dialog).getByRole('button', { name: 'Перенести заезд' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(move).toHaveBeenCalledWith('plan', 'alex', ref.date, 4);
  await user.click(
    within(screen.getByTestId('arrival-person-alex')).getByRole('button', { name: /Открыть/ }),
  );
  const person = screen.getByTestId('arrival-person-moved-alex');
  expect(person).toHaveAttribute('data-status', 'expected');
  expect(within(person).getByText('15')).toBeInTheDocument();
  expect(period).toHaveBeenLastCalledWith(ref.date);
});

it('оформляет проживание после выбора существующей карточки и хостела, переносит даты и смены', async () => {
  const user = userEvent.setup();
  const arrived = { ...plan, workflow: { alex: state('arrived') } };
  vi.spyOn(personnelApi, 'arrivalHostels').mockResolvedValue({
    hostels: [{ id: 9, name: 'Корпус А' }],
  });
  vi.spyOn(personnelApi, 'check').mockResolvedValue({
    check_token: 'token',
    candidates: [
      {
        id: 'employee',
        full_name: 'Александр Волков',
        personnel_number: '0041',
        phone: null,
        identity_status: 'confirmed',
        dormitories: ['Северное'],
        score: 100,
        evidence: ['Совпадает ФИО'],
        differences: [],
      },
    ],
  });
  const settle = vi.spyOn(personnelApi, 'settleArrival').mockResolvedValue({
    plans: [
      {
        ...arrived,
        revision: 5,
        workflow: {
          alex: {
            ...state('settled'),
            employee_id: 'employee',
            resident: { id: 42, dormitory_id: 1 },
          },
        },
      },
    ],
    deleted_plan_ids: [],
  });
  show(arrived);
  await user.click(
    within(screen.getByTestId('arrival-person-alex')).getByRole('button', {
      name: 'В проживающие',
    }),
  );
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByLabelText('Количество смен')).toHaveValue(15);
  expect(within(dialog).getByLabelText('Начало вахты')).toHaveValue('2026-10-28');
  await user.selectOptions(await within(dialog).findByLabelText('Место проживания'), '9');
  await user.click(await within(dialog).findByRole('radio'));
  await user.click(within(dialog).getByRole('button', { name: 'Оформить в проживающие' }));
  await waitFor(() => expect(settle).toHaveBeenCalled());
  expect(settle).toHaveBeenCalledWith(
    'plan',
    'alex',
    expect.objectContaining({
      revision: 4,
      hostel_id: 9,
      shift_count: 15,
      shift_start: '2026-10-28',
      settlement_date: '2026-10-27',
      identity: expect.objectContaining({
        mode: 'existing',
        employee_id: 'employee',
        check_token: 'token',
      }),
    }),
  );
  expect(await screen.findByRole('link', { name: 'Открыть проживание' })).toHaveAttribute(
    'href',
    '/cabinet/dormitories/1/residents',
  );
});

import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { personnelApi } from '../../api/personnel';
import type { ArrivalPlan, PersonnelData } from '../../api/personnel';
import { ArrivalPlanningBoard } from './ArrivalPlanningBoard';
import { defaultConfiguration } from './arrivals/adapter';
import { ApiError } from '../../api/client';

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
  preferences: { revision: 0, blocks: [], lists: [] },
};
const mutate = async (action: () => Promise<unknown>): Promise<void> => {
  await action();
};

it('показывает действующие общежития и считает людей независимо от ФИО', () => {
  render(<ArrivalPlanningBoard data={data} dormitory={null} mutate={mutate} />);
  expect(screen.getByText('Ожидается за период: 10 чел.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /Северное/ })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /Южное/ })).toBeInTheDocument();
  expect(screen.queryByText('Старое')).not.toBeInTheDocument();
  expect(screen.getByText('Иванов Иван')).toBeInTheDocument();
  expect(
    within(screen.getByTestId('arrival-card-plan')).queryByText('Дата выхода на работу'),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('Выезды')).not.toBeInTheDocument();
  expect(screen.queryByText('Ожидают подтверждения')).not.toBeInTheDocument();
});

it('сохраняет вручную количество и необязательные ФИО без карточек сотрудников', async () => {
  const user = userEvent.setup();
  const create = vi.spyOn(personnelApi, 'createArrival').mockResolvedValue(plan);
  render(<ArrivalPlanningBoard data={data} dormitory={null} mutate={mutate} />);
  await user.click(screen.getByRole('button', { name: 'Выбрать дату: 2026-10-21' }));
  await user.click(screen.getByRole('button', { name: 'Добавить заезд: Южное, 2026-10-21' }));
  const dialog = screen.getByRole('dialog', { name: 'Добавить заезд' });
  await user.clear(within(dialog).getByLabelText('Количество человек'));
  await user.type(within(dialog).getByLabelText('Количество человек'), '10');
  await user.type(within(dialog).getByLabelText('ФИО, человек 1'), 'Иванов Иван');
  await user.type(within(dialog).getByLabelText('ФИО, человек 2'), 'Петров Пётр');
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить заезд' }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        dormitory_id: 2,
        date: '2026-10-21',
        count: 10,
        names: ['Иванов Иван', 'Петров Пётр'],
      }),
    ),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('редактирует запись с ревизией и подтверждает удаление', async () => {
  const user = userEvent.setup();
  const update = vi.spyOn(personnelApi, 'updateArrival').mockResolvedValue(plan);
  const remove = vi.spyOn(personnelApi, 'deleteArrival').mockResolvedValue(undefined);
  render(<ArrivalPlanningBoard data={data} dormitory={1} mutate={mutate} />);
  expect(screen.queryByRole('heading', { name: /Южное/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Изменить заезд: Северное, 2026-10-20' }));
  await user.clear(screen.getByLabelText('Количество человек'));
  await user.type(screen.getByLabelText('Количество человек'), '12');
  await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      'plan',
      expect.objectContaining({
        dormitory_id: 1,
        date: '2026-10-20',
        count: 12,
        names: ['Иванов Иван'],
        revision: 0,
      }),
    ),
  );
  await user.click(screen.getByRole('button', { name: 'Изменить заезд: Северное, 2026-10-20' }));
  await user.click(screen.getByRole('button', { name: 'Удалить заезд' }));
  expect(remove).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Да, удалить' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('plan', 0));
});

it('разрешает количество без ФИО и не теряет строки при временном уменьшении количества', async () => {
  const user = userEvent.setup();
  const create = vi.spyOn(personnelApi, 'createArrival').mockResolvedValue(plan);
  render(<ArrivalPlanningBoard data={data} dormitory={null} mutate={mutate} />);
  await user.click(screen.getByRole('button', { name: 'Добавить заезд: Южное, 2026-10-20' }));
  await user.clear(screen.getByLabelText('Количество человек'));
  await user.type(screen.getByLabelText('Количество человек'), '2');
  await user.type(screen.getByLabelText('ФИО, человек 2'), 'Петров');
  await user.clear(screen.getByLabelText('Количество человек'));
  await user.type(screen.getByLabelText('Количество человек'), '1');
  await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Подтвердите удаление заполненных строк');
  expect(create).not.toHaveBeenCalled();
  await user.clear(screen.getByLabelText('Количество человек'));
  await user.type(screen.getByLabelText('Количество человек'), '2');
  expect(screen.getByLabelText('ФИО, человек 2')).toHaveValue('Петров');
  await user.clear(screen.getByLabelText('ФИО, человек 2'));
  await user.clear(screen.getByLabelText('Количество человек'));
  await user.type(screen.getByLabelText('Количество человек'), '1');
  await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        dormitory_id: 2,
        date: '2026-10-20',
        count: 1,
        names: [],
      }),
    ),
  );
});

it('переключает подробности дня, добавляет заезд на выбранную дату и возвращается к сегодня', async () => {
  const user = userEvent.setup();
  render(<ArrivalPlanningBoard data={data} dormitory={null} mutate={mutate} />);
  const detail = screen.getByRole('complementary', { name: 'Заезды на выбранную дату' });
  await user.click(screen.getByRole('button', { name: 'Выбрать дату: 2026-10-22' }));
  expect(detail).toHaveTextContent('22 окт. 2026');
  expect(within(detail).queryByText('Иванов Иван')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Добавить заезд' }));
  expect(screen.getByLabelText('Дата заезда')).toHaveValue('2026-10-22');
  await user.click(screen.getByRole('button', { name: 'Закрыть окно' }));
  await user.click(screen.getByRole('button', { name: 'Следующие 7 дней' }));
  expect(detail).toHaveTextContent('27 окт. 2026');
  expect(screen.getByRole('button', { name: 'Выбрать дату: 2026-10-27' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await user.click(screen.getByRole('button', { name: 'Сегодня' }));
  expect(detail).toHaveTextContent('20 окт. 2026');
  expect(detail).toHaveTextContent('Иванов Иван');
});

it('следует за датой заезда при сохранении за пределами текущей недели', async () => {
  const user = userEvent.setup();
  vi.spyOn(personnelApi, 'createArrival').mockResolvedValue(plan);
  render(<ArrivalPlanningBoard data={data} dormitory={null} mutate={mutate} />);
  await user.click(screen.getByRole('button', { name: 'Добавить заезд' }));
  await user.clear(screen.getByLabelText('Дата заезда'));
  await user.type(screen.getByLabelText('Дата заезда'), '2026-11-02');
  await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByLabelText('Начало периода плана')).toHaveValue('2026-11-02');
  expect(screen.getByRole('button', { name: 'Выбрать дату: 2026-11-02' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

it('открывает все заполненные поля и людей, скрытых в краткой карточке, и обновляет просмотр после правки', async () => {
  const user = userEvent.setup();
  const configuration = defaultConfiguration();
  configuration.display.visible = ['names'];
  const removed = configuration.fields.find((field) => field.id === 'comment')!;
  configuration.fields = configuration.fields.filter((field) => field.id !== 'comment');
  configuration.display.order = configuration.display.order.filter((id) => id !== 'comment');
  configuration.archived_fields = [{ ...removed, inForm: false }];
  const rich: ArrivalPlan = {
    ...plan,
    count: 4,
    names: ['Первый', 'Второй', 'Третий', 'Четвёртый'],
    custom_values: { comment: 'Скрытый комментарий' },
    people: Array.from({ length: 4 }, (_, index) => ({
      id: crypto.randomUUID(),
      full_name: ['Первый', 'Второй', 'Третий', 'Четвёртый'][index],
      custom_values: { shifts: String(15 + index * 5) },
    })),
  };
  vi.spyOn(personnelApi, 'updateArrival').mockImplementation(async (_id, values) => ({
    ...values,
    id: plan.id,
    revision: 1,
  }));
  render(
    <ArrivalPlanningBoard
      data={{ ...data, arrival_plans: [rich], arrival_settings: configuration }}
      dormitory={1}
      mutate={mutate}
    />,
  );
  const card = screen.getByTestId('arrival-card-plan');
  expect(within(card).queryByText('Скрытый комментарий')).not.toBeInTheDocument();
  expect(within(card).queryByText('Четвёртый')).not.toBeInTheDocument();
  await user.click(within(card).getByText('Первый'));
  let detail = screen.getByRole('dialog', { name: 'Информация о заезде' });
  expect(within(detail).getByText('Скрытый комментарий')).toBeInTheDocument();
  expect(within(detail).getByText('Четвёртый')).toBeInTheDocument();
  expect(within(detail).getAllByText('Кол-во смен')).toHaveLength(4);
  await user.click(within(detail).getByRole('button', { name: 'Изменить заезд' }));
  await user.clear(screen.getByLabelText('Кол-во смен, человек 1'));
  await user.type(screen.getByLabelText('Кол-во смен, человек 1'), '30');
  await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
  detail = await screen.findByRole('dialog', { name: 'Информация о заезде' });
  expect(within(detail).getByTestId(`arrival-person-${rich.people![0].id}`)).toHaveTextContent(
    '30',
  );
  await user.click(within(detail).getByRole('button', { name: 'Закрыть' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('сохраняет настройку нового личного чекбокса и разные значения людей без потери черновика', async () => {
  const user = userEvent.setup();
  const settingsSave = vi
    .spyOn(personnelApi, 'saveArrivalSettings')
    .mockImplementation(async (values) => ({
      ...values,
      revision: values.revision + 1,
      archived_fields: [],
      used_fields: [],
    }));
  const create = vi
    .spyOn(personnelApi, 'createArrival')
    .mockImplementation(async (values) => ({ ...values, id: 'created', revision: 0 }));
  render(<ArrivalPlanningBoard data={data} dormitory={null} mutate={mutate} />);
  await user.click(screen.getByRole('button', { name: 'Добавить заезд: Южное, 2026-10-20' }));
  await user.clear(screen.getByLabelText('Количество человек'));
  await user.type(screen.getByLabelText('Количество человек'), '2');
  await user.type(screen.getByLabelText('ФИО, человек 1'), 'Первый');
  await user.click(screen.getByRole('button', { name: 'Настроить поля' }));
  await user.click(screen.getByRole('button', { name: 'Добавить поле' }));
  const editor = screen.getByRole('dialog', { name: 'Настройки плана заездов' });
  await user.clear(within(editor).getByLabelText('Название поля'));
  await user.type(within(editor).getByLabelText('Название поля'), 'Допуск');
  await user.selectOptions(
    within(editor).getByRole('combobox', { name: /Где заполнять/ }),
    'person',
  );
  await user.selectOptions(within(editor).getByLabelText('Тип поля'), 'checkbox');
  await user.click(within(editor).getByRole('button', { name: 'Сохранить настройки' }));
  expect(await screen.findByLabelText('ФИО, человек 1')).toHaveValue('Первый');
  await user.click(screen.getByLabelText('Допуск, человек 1'));
  await user.type(screen.getByLabelText('ФИО, человек 2'), 'Второй');
  await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  const field = settingsSave.mock.calls[0][0].fields.find((item) => item.label === 'Допуск')!;
  const saved = create.mock.calls[0][0];
  expect(saved.settings_revision).toBe(1);
  expect(saved.people?.map((person) => person.full_name)).toEqual(['Первый', 'Второй']);
  expect(saved.people?.map((person) => person.custom_values[field.id])).toEqual([true, false]);
});

it('проверяет обязательные личные поля также на следующей странице людей', async () => {
  const user = userEvent.setup();
  const configuration = defaultConfiguration();
  configuration.fields[0].required = true;
  const many: ArrivalPlan = {
    ...plan,
    count: 26,
    people: Array.from({ length: 26 }, (_, index) => ({
      id: crypto.randomUUID(),
      full_name: `Человек ${index + 1}`,
      custom_values: { shifts: index === 25 ? '' : '15' },
    })),
  };
  const update = vi.spyOn(personnelApi, 'updateArrival').mockResolvedValue(many);
  render(
    <ArrivalPlanningBoard
      data={{ ...data, arrival_plans: [many], arrival_settings: configuration }}
      dormitory={1}
      mutate={mutate}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Изменить заезд: Северное, 2026-10-20' }));
  await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
  expect(update).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('человека № 26');
  await user.type(screen.getByLabelText('Кол-во смен, человек 26'), '30');
  await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0][1].people).toHaveLength(26);
});

it('сохраняет окно и настройки при ошибке сервера и защищает тип заполненного поля', async () => {
  const user = userEvent.setup();
  const configuration = defaultConfiguration();
  configuration.used_fields = ['shifts'];
  vi.spyOn(personnelApi, 'saveArrivalSettings').mockRejectedValue(
    new ApiError(409, 'Настройки уже изменены'),
  );
  render(
    <ArrivalPlanningBoard
      data={{ ...data, arrival_settings: configuration }}
      dormitory={1}
      mutate={mutate}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Настроить вид' }));
  const editor = screen.getByRole('dialog', { name: 'Настройки плана заездов' });
  expect(within(editor).getByLabelText('Тип поля')).toBeDisabled();
  expect(within(editor).getByRole('combobox', { name: /Где заполнять/ })).toBeDisabled();
  await user.click(within(editor).getByRole('button', { name: 'Сохранить настройки' }));
  expect(await within(editor).findByRole('alert')).toHaveTextContent('Настройки уже изменены');
  expect(within(editor).getByLabelText('Название поля')).toHaveValue('Кол-во смен');
});

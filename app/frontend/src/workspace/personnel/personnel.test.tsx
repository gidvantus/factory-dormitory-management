import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import * as session from '../../auth/SessionProvider';
import { personnelApi } from '../../api/personnel';
import type { Employee, PersonnelData, Source } from '../../api/personnel';
import { IdentityDialog } from './IdentityDialog';
import { Personnel } from '../Personnel';
import { BlockDialog } from './Dialogs';
import { filterPeople } from './helpers';
import { defaultColumns } from '../../test/tableColumns';
import { renderWithExchangePermissions as render } from '../../test/renderWithExchangePermissions';
import { mockPersonnelServer } from '../../test/personnelServer';
import { PAGE_SIZE } from './serverList';
import { FRAME_REFRESH_MS } from '../usePageRefresh';

const source = (
  dorm: number,
  table: Source['table_key'] = 'residents',
  end = '2026-10-15',
): Source => ({
  table_key: table,
  row_id: dorm,
  dormitory_id: dorm,
  source_name: 'Проживающие',
  values: { shift_start: '2026-10-01', shift_end: end },
});
const person = (id: string, current: Source[] = []): Employee => ({
  id,
  member_ids: [id],
  full_name: 'Иванов Иван',
  personnel_number: null,
  phone: null,
  identity_status: 'pending',
  current,
  sources: [...current],
  history_dormitory_ids: current.map((row) => row.dormitory_id),
  variants: {},
});
const data = (employees: Employee[]): PersonnelData => ({
  today: '2026-10-10',
  dormitories: [],
  employees,
  plans: [],
  arrival_plans: [],
  preferences: { revision: 0, blocks: null, lists: [] },
});
const criteria = { filter: 'current' as const, dormitory: null, scope: [], days: 5, query: '' };
afterEach(() => vi.restoreAllMocks());

it('показывает даты и примечания выселений и открывает карточку по ID', async () => {
  const user = userEvent.setup();
  const employee = { ...person('evicted'), full_name: 'Сидоров Сергей' };
  const payload = data([employee]);
  payload.dormitories = [{ id: 1, name: 'Северное', client_name: 'Клиент', is_archived: false }];
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  mockPersonnelServer(payload);
  const finished = vi.spyOn(personnelApi, 'finishedShifts').mockResolvedValue({
    rows: [
      {
        id: 15,
        employee_id: employee.id,
        full_name: employee.full_name,
        dormitory_id: 1,
        departure_date: '2026-10-20',
        notes: 'Пропуск сдан',
      },
    ],
    page: 1,
    total: 1,
  });
  const profile = vi.spyOn(personnelApi, 'profile').mockResolvedValue({
    employee,
    dormitories: payload.dormitories,
    detail: { employee_id: employee.id, events: [], notes: [], merges: [] },
  });
  render(
    <MemoryRouter initialEntries={['/cabinet/personnel?view=list']}>
      <Personnel />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: 'Закончили вахту' }));
  const table = await screen.findByRole('table', { name: 'Закончили вахту' });
  expect(within(table).getByRole('columnheader', { name: 'Дата выселения' })).toBeInTheDocument();
  expect(
    within(table)
      .getByText(/20 окт/)
      .closest('time'),
  ).toHaveAttribute('datetime', '2026-10-20');
  expect(within(table).getByText('Пропуск сдан')).toBeInTheDocument();
  expect(finished).toHaveBeenLastCalledWith(
    { period: { from: '2026-10-01', to: '2026-10-31' }, dormitory: null, query: '', page: 1 },
    expect.any(AbortSignal),
  );
  await user.selectOptions(screen.getByLabelText('Общежитие на странице'), '1');
  expect(finished).toHaveBeenLastCalledWith(
    expect.objectContaining({ dormitory: 1 }),
    expect.any(AbortSignal),
  );
  await user.click(
    within(await screen.findByRole('table', { name: 'Закончили вахту' })).getByRole('button', {
      name: 'Сидоров Сергей',
    }),
  );
  expect(await screen.findByRole('heading', { name: 'Сидоров Сергей' })).toBeInTheDocument();
  expect(profile).toHaveBeenCalledWith({ employeeId: employee.id }, expect.any(AbortSignal));
});

it('оставляет три фильтра, поиск и карточку без массовых действий со списком', async () => {
  const user = userEvent.setup();
  const employees = [
    { ...person('ending', [source(1)]), full_name: 'Иванов Иван' },
    { ...person('overdue', [source(1, 'residents', '2026-10-09')]), full_name: 'Петров Пётр' },
    { ...person('later', [source(1, 'residents', '2026-10-16')]), full_name: 'Сидоров Сергей' },
    { ...person('away'), full_name: 'Кузнецов Алексей' },
  ];
  const payload = data(employees);
  payload.dormitories = [{ id: 1, name: 'Северное', client_name: 'Клиент', is_archived: false }];
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  mockPersonnelServer(payload);
  vi.spyOn(personnelApi, 'detail').mockResolvedValue({
    employee_id: 'ending',
    events: [],
    notes: [],
    merges: [],
  });
  render(
    <MemoryRouter>
      <Personnel />
    </MemoryRouter>,
  );
  await screen.findByRole('tab', { name: /Сотрудники/ });
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
    'Рабочая поверхность',
    'Сотрудники4',
    'План заездов',
  ]);
  expect(screen.queryByTestId('personnel-matches')).not.toBeInTheDocument();
  const workspacePeriod = within(screen.getByRole('form', { name: 'Период персонала' }));
  expect(workspacePeriod.getByLabelText('От')).toHaveValue('2026-10-01');
  expect(workspacePeriod.getByLabelText('До')).toHaveValue('2026-10-31');
  const endingSummary = screen.getByRole('button', { name: /Окончания вахт за период/ });
  await waitFor(() => expect(endingSummary).toHaveTextContent('3'));
  fireEvent.change(workspacePeriod.getByLabelText('От'), { target: { value: '2026-10-16' } });
  fireEvent.change(workspacePeriod.getByLabelText('До'), { target: { value: '2026-10-15' } });
  await user.click(workspacePeriod.getByRole('button', { name: 'Применить' }));
  expect(workspacePeriod.getByRole('alert')).toHaveTextContent('не позже');
  expect(endingSummary).toHaveTextContent('3');
  fireEvent.change(workspacePeriod.getByLabelText('От'), { target: { value: '2026-10-15' } });
  await user.click(workspacePeriod.getByRole('button', { name: 'Применить' }));
  await waitFor(() => expect(endingSummary).toHaveTextContent('1'));
  await user.click(await screen.findByRole('tab', { name: /Сотрудники/ }));
  expect(screen.queryByRole('button', { name: 'Все сотрудники' })).not.toBeInTheDocument();
  const employeePeriod = within(screen.getByRole('form', { name: 'Период персонала' }));
  expect(employeePeriod.getByLabelText('От')).toHaveValue('2026-10-15');
  expect(employeePeriod.getByLabelText('До')).toHaveValue('2026-10-15');
  for (const name of [
    'Дата вахты прошла',
    'Неполные данные',
    'Были в оттоке',
    'Мои сотрудники',
    'Вернулись после оттока',
    'Без телефона',
    'Требуют проверки',
    'Проверить записи →',
    'Копировать телефоны',
    'Экспорт для Excel',
    'Список выездов',
  ])
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Добавить в мои сотрудники/)).not.toBeInTheDocument();
  const table = screen.getByRole('table');
  await user.click(within(table).getByRole('checkbox', { name: 'Выбрать всех на странице: 3' }));
  expect(screen.getByText('Выбрано: 3')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Снять выбор' }));
  expect(within(table).queryAllByRole('checkbox', { checked: true })).toHaveLength(0);
  expect(within(table).getAllByRole('row')).toHaveLength(4);
  await user.click(screen.getByRole('button', { name: 'Проживают' }));
  expect(within(table).getAllByRole('row')).toHaveLength(4);
  await user.click(screen.getByRole('button', { name: 'Заканчивается вахта' }));
  expect(within(table).getAllByRole('row')).toHaveLength(2);
  await user.click(employeePeriod.getByRole('button', { name: 'Текущий месяц' }));
  expect(employeePeriod.getByLabelText('От')).toHaveValue('2026-10-01');
  expect(employeePeriod.getByLabelText('До')).toHaveValue('2026-10-31');
  expect(within(table).getAllByRole('row')).toHaveLength(4);
  await user.click(screen.getByRole('button', { name: 'Проживают' }));
  await user.type(screen.getByRole('textbox', { name: 'Поиск сотрудника' }), 'Иванов');
  // Поиск применяется после паузы в наборе: запрос уходит не на каждую букву (#247).
  await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
  await user.click(within(table).getByRole('button', { name: /^Иванов Иван/ }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('complementary', { name: 'Выбранный сотрудник' })).toHaveTextContent(
    'Иванов Иван',
  );
  await user.click(screen.getByRole('button', { name: 'Открыть полную карточку' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Карточка сотрудника');
  expect(screen.queryByText(/Решение по окончанию вахты|Связанные записи/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Изменить связь' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /исходную таблицу/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Ожидаем решение')).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /^История/ })).toBeInTheDocument();
  expect(screen.queryByLabelText(/Добавить в мои сотрудники/)).not.toBeInTheDocument();
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Закрыть окно' }),
  );
  await user.click(screen.getByRole('button', { name: '+ Добавить фильтр' }));
  expect(screen.queryByRole('option', { name: 'Решение по вахте' })).not.toBeInTheDocument();
});

it('не предлагает блоки, связанные с удалёнными фильтрами', () => {
  render(<BlockDialog block={null} data={data([])} onClose={vi.fn()} onSave={vi.fn()} />);
  expect(screen.queryByRole('option', { name: 'Неполные данные' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'История оттока' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
    'Проживающий персонал',
    'Заканчивается вахта',
    'Контакты сотрудников',
    'План заездов',
    'Сохранённый список',
  ]);
});

it('фильтрует по двум статусам, собирает выбранных из разных выборок и сохраняет условия списка', async () => {
  const user = userEvent.setup();
  const allowed = { ...source(1), values: { ...source(1).values, custom_values: { '101': 'ok' } } };
  const waiting = {
    ...source(1),
    row_id: 2,
    values: { ...source(1).values, custom_values: { '101': 'wait' } },
  };
  const payload = data([
    { ...person('allowed', [allowed]), full_name: 'Иванов Иван' },
    { ...person('waiting', [waiting]), full_name: 'Петров Пётр' },
    { ...person('away'), full_name: 'Сидоров Сергей' },
  ]);
  payload.preferences.lists = [
    { ...criteria, filter: 'all', id: 'legacy-all', name: 'Общий список' },
  ];
  payload.dormitories = [{ id: 1, name: 'Северное', client_name: 'Клиент', is_archived: false }];
  payload.source_columns = [
    {
      id: 101,
      dormitory_id: 1,
      table_key: 'residents',
      source_name: 'Проживающие',
      name: 'Статус',
      kind: 'select',
      builtin_key: null,
      options: [
        { id: 'ok', label: 'Допущен', archived: false },
        { id: 'wait', label: 'Ожидает', archived: false },
      ],
    },
  ];
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  vi.spyOn(personnelApi, 'workspace').mockImplementation(async () => ({ ...payload }));
  mockPersonnelServer(payload);
  const save = vi.spyOn(personnelApi, 'preferences').mockImplementation(async (preferences) => {
    payload.preferences = { ...preferences, revision: preferences.revision + 1 };
    return payload.preferences;
  });
  render(
    <MemoryRouter>
      <Personnel />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('tab', { name: /Сотрудники/ }));
  await user.click(screen.getByRole('button', { name: 'Общий список' }));
  const table = screen.getByRole('table');
  await user.click(
    within(table).getByRole('checkbox', { name: 'Выбрать сотрудника Сидоров Сергей' }),
  );
  await user.click(screen.getByRole('button', { name: '+ Добавить фильтр' }));
  await user.selectOptions(screen.getByLabelText('Значение фильтра 1'), 'Проживает');
  // Условия столбцов применяются после паузы в наборе (#247).
  await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3));
  expect(screen.getByText('Выбрано: 1')).toBeInTheDocument();
  await user.click(within(table).getByRole('checkbox', { name: 'Выбрать сотрудника Иванов Иван' }));
  await user.click(screen.getByRole('button', { name: '+ Добавить фильтр' }));
  await user.selectOptions(
    screen.getByLabelText('Столбец фильтра 2'),
    within(screen.getByLabelText('Столбец фильтра 2')).getByRole('option', {
      name: 'Проживающие · Статус',
    }),
  );
  await user.selectOptions(screen.getByLabelText('Значение фильтра 2'), 'Допущен');
  await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
  expect(
    within(table).getByRole('columnheader', { name: 'Проживающие · Статус' }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Список выбранных (2)' }));
  const selected = screen.getByTestId('personnel-selected-list');
  expect(within(selected).getByRole('button', { name: 'Выгрузить' })).toBeEnabled();
  expect(within(selected).getByText('Сидоров Сергей')).toBeInTheDocument();
  expect(within(selected).queryByText('Петров Пётр')).not.toBeInTheDocument();
  await user.clear(within(selected).getByLabelText('Название списка'));
  await user.type(within(selected).getByLabelText('Название списка'), 'Мой список');
  expect(within(selected).getByRole('table')).toHaveAccessibleName('Мой список · 2');
  await user.click(within(selected).getByRole('button', { name: 'Закрыть окно' }));
  expect(screen.getByText('Выбрано: 2')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '+ Сохранить текущий список' }));
  const saving = screen.getByTestId('personnel-save-list');
  await user.clear(within(saving).getByLabelText('Название списка'));
  await user.type(within(saving).getByLabelText('Название списка'), 'Допущенные');
  await user.click(within(saving).getByLabelText('Закрепить блоком на рабочей поверхности'));
  await user.click(within(saving).getByRole('button', { name: 'Сохранить список' }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByTestId('personnel-save-list')).not.toBeInTheDocument());
  expect(save.mock.calls[0][0].lists.at(-1)?.column_filters).toHaveLength(2);
  expect(save.mock.calls[0][0].lists.at(-1)?.period).toEqual({
    from: '2026-10-01',
    to: '2026-10-31',
  });
  await user.click(screen.getByRole('button', { name: 'Сбросить условия' }));
  await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
  await user.click(screen.getByRole('button', { name: /^Допущенные/ }));
  await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
  expect(screen.getByLabelText('Значение фильтра 2')).toHaveValue('Допущен');
});

it('открывает простой план из источника отчёта и сохраняет заезд без сотрудников', async () => {
  const user = userEvent.setup();
  const payload = data([]);
  payload.dormitories = [
    { id: 1, name: 'Северное', client_name: 'Клиент', is_archived: false },
    { id: 2, name: 'Старое', client_name: 'Клиент', is_archived: true },
  ];
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  vi.spyOn(personnelApi, 'workspace').mockImplementation(async () => ({ ...payload }));
  mockPersonnelServer(payload);
  vi.spyOn(personnelApi, 'createArrival').mockImplementation(async (values) => {
    const plan = { ...values, id: 'new', revision: 0 };
    payload.arrival_plans = [plan];
    return plan;
  });
  vi.spyOn(personnelApi, 'arrivals').mockImplementation(async () => ({
    ...payload,
    from: payload.today,
    to: '2026-10-16',
  }));
  render(
    <MemoryRouter initialEntries={['/cabinet/personnel?view=planning&dormitory=1']}>
      <Personnel />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('tab', { name: 'План заездов' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(screen.queryByRole('form', { name: 'Период персонала' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /Старое/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Нажмите на имя, чтобы открыть карточку')).not.toBeInTheDocument();
  await user.click(
    await screen.findByRole('button', { name: 'Добавить заезд: Северное, 2026-10-10' }),
  );
  await user.clear(screen.getByLabelText('Количество человек'));
  await user.type(screen.getByLabelText('Количество человек'), '10');
  await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
  expect(await screen.findByText('Ожидается за период: 10 чел.')).toBeInTheDocument();
  expect(personnelApi.workspace).not.toHaveBeenCalled();
});

it('загружает список страницами с сервера и не просит полный набор карточек', async () => {
  const user = userEvent.setup();
  const employees = people(25);
  const payload = data(employees);
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  mockPersonnelServer(payload);
  render(
    <MemoryRouter>
      <Personnel />
    </MemoryRouter>,
  );
  await screen.findByRole('tab', { name: /Сотрудники/ });
  await user.click(screen.getByRole('tab', { name: /Сотрудники/ }));
  const table = await screen.findByRole('table');
  expect(personnelApi.workspace).toHaveBeenCalledWith(expect.any(AbortSignal), {
    employees: 'none',
    dormitory: null,
    days: 30,
    period: { from: '2026-10-01', to: '2026-10-31' },
  });
  expect(await screen.findByText('1–20 из 25')).toBeInTheDocument();
  expect(within(table).getAllByRole('row')).toHaveLength(21);
  await user.click(screen.getByRole('button', { name: 'Далее' }));
  expect(await screen.findByText('21–25 из 25')).toBeInTheDocument();
  expect(within(table).getAllByRole('row')).toHaveLength(6);
  expect(within(table).getByText('Сотрудник 25')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Назад' }));
  expect(await screen.findByText('1–20 из 25')).toBeInTheDocument();
  await user.type(screen.getByRole('textbox', { name: 'Поиск сотрудника' }), 'Сотрудник 2');
  await waitFor(() => expect(screen.getByText('1–6 из 6')).toBeInTheDocument());
  // Страница списка запрашивается после паузы в наборе; счётчики — отдельные запросы.
  expect(personnelApi.employees).toHaveBeenCalledWith(
    expect.objectContaining({ query: 'Сотрудник 2', page: 1, per_page: 20 }),
    expect.any(AbortSignal),
  );
});

it('на одно открытие раздела запрашивает рамку ровно один раз (#261)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T12:00:00'));
  try {
    vi.spyOn(session, 'useSession').mockReturnValue({
      status: 'authenticated',
      user: null,
      setUser: vi.fn(),
      refresh: vi.fn(),
      logout: vi.fn(),
    });
    // `today` сервера совпадает с местным месяцем: даты диапазона не меняются.
    mockPersonnelServer({ ...data(people(3)), today: '2026-11-25' });
    render(
      <MemoryRouter>
        <Personnel />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Сотрудники/ });
    // Ответ сервера меняет `today`, а вместе с ним месяц: диапазон пересчитан, но
    // даты те же — второй запрос с теми же параметрами не нужен.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(vi.mocked(personnelApi.workspace)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(personnelApi.workspace).mock.calls[0][1]).toMatchObject({
      employees: 'none',
    });
  } finally {
    vi.useRealTimers();
  }
});

it('не теряет рамку при повторном запуске эффекта в StrictMode (#261)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T12:00:00'));
  try {
    vi.spyOn(session, 'useSession').mockReturnValue({
      status: 'authenticated',
      user: null,
      setUser: vi.fn(),
      refresh: vi.fn(),
      logout: vi.fn(),
    });
    mockPersonnelServer({ ...data(people(3)), today: '2026-11-25' });
    render(
      <StrictMode>
        <MemoryRouter>
          <Personnel />
        </MemoryRouter>
      </StrictMode>,
    );
    // В dev StrictMode отменяет первый ответ. Ключ, запомненный до отправки,
    // запрещал второй запуск эффекта и оставлял экран загрузки до минутного тика.
    expect(await screen.findByRole('tab', { name: /Сотрудники/ })).toBeInTheDocument();
    for (const [, options] of vi.mocked(personnelApi.workspace).mock.calls)
      expect(options).toMatchObject({ employees: 'none' });
  } finally {
    vi.useRealTimers();
  }
});

it('проходит сценарий поверхности, ни разу не запросив полный набор карточек (#251)', async () => {
  const user = userEvent.setup();
  // Двое заканчивают вахту в окне: блок «Заканчивается вахта» обязан
  // отрисоваться из `block_previews`, ведь массива `employees` в рамке нет.
  const employees = people(25).map((employee, index) =>
    index < 2
      ? {
          ...employee,
          current: [source(1, 'residents', '2026-10-15')],
          sources: [source(1, 'residents', '2026-10-15')],
          history_dormitory_ids: [1],
        }
      : employee,
  );
  const payload = data(employees);
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  mockPersonnelServer(payload);
  vi.spyOn(personnelApi, 'detail').mockResolvedValue({
    employee_id: 'id-0',
    events: [],
    notes: [],
    merges: [],
  });
  render(
    <MemoryRouter>
      <Personnel />
    </MemoryRouter>,
  );
  // Поверхность: блоки и сводка без карточек.
  await user.click(await screen.findByRole('tab', { name: /Рабочая поверхность/ }));
  // Сводка пришла полем `counts`, а карточки блоков — `block_previews`.
  expect(await screen.findByRole('tab', { name: /Сотрудники\s*25/ })).toBeInTheDocument();
  const ending = await screen.findByRole('article', { name: 'Заканчивается вахта' });
  expect(within(ending).getByText('Сотрудник 01')).toBeInTheDocument();
  expect(within(ending).getByText('Сотрудник 02')).toBeInTheDocument();
  expect(within(ending).queryByText('Нет сотрудников в выборке')).not.toBeInTheDocument();
  await screen.findByRole('tab', { name: /Сотрудники/ });
  // Список: страница, поиск, пагинация.
  await user.click(screen.getByRole('tab', { name: /Сотрудники/ }));
  await screen.findByRole('table');
  await user.type(screen.getByRole('textbox', { name: 'Поиск сотрудника' }), 'Сотрудник 25');
  await waitFor(() => expect(screen.getByText('1–1 из 1')).toBeInTheDocument());
  await user.clear(screen.getByRole('textbox', { name: 'Поиск сотрудника' }));
  await waitFor(() => expect(screen.getByText('1–20 из 25')).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Далее' }));
  expect(await screen.findByText('21–25 из 25')).toBeInTheDocument();
  // Профиль показанной карточки.
  await user.click(screen.getByRole('button', { name: /^Сотрудник 21/ }));
  await user.click(await screen.findByRole('button', { name: 'Открыть полную карточку' }));
  expect(await screen.findByRole('tablist', { name: 'Карточка сотрудника' })).toBeInTheDocument();
  expect(personnelApi.detail).toHaveBeenCalledWith('id-20', expect.any(AbortSignal));
  // `employees=none` — единственный режим поверхности: полного списка в запросах нет.
  expect(vi.mocked(personnelApi.workspace).mock.calls.length).toBeGreaterThan(0);
  for (const [, options] of vi.mocked(personnelApi.workspace).mock.calls)
    expect(options).toMatchObject({ employees: 'none' });
  expect(pageRequests().length).toBeGreaterThan(0);
});

const people = (count: number): Employee[] =>
  Array.from({ length: count }, (_, index) => ({
    ...person(`id-${index}`, [source(1, 'residents', '2026-09-30')]),
    full_name: `Сотрудник ${String(index + 1).padStart(2, '0')}`,
  }));

/** Запросы страницы: только они, без счётчиков из одной записи. */
const pageRequests = (): { page: number; per_page: number; query: string }[] =>
  vi
    .mocked(personnelApi.employees)
    .mock.calls.map(([query]) => query)
    .filter((query) => query.per_page === PAGE_SIZE);

/** Запросы счётчиков: страница из одной записи, только ради `total`. */
const counterFilters = (): (string | undefined)[] =>
  vi
    .mocked(personnelApi.employees)
    .mock.calls.map(([query]) => query)
    .filter((query) => query.per_page === 1)
    .map((query) => query.filter);

it('не запрашивает счётчик активного фильтра: его число приходит со страницей (#247)', async () => {
  const user = userEvent.setup();
  const payload = data([
    { ...person('a', [source(1)]), full_name: 'Иванов Иван' },
    { ...person('b', [source(1)]), full_name: 'Петров Пётр' },
    { ...person('c'), full_name: 'Сидоров Сергей' },
  ]);
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  mockPersonnelServer(payload);
  render(
    <MemoryRouter>
      <Personnel />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('tab', { name: /Сотрудники/ }));
  await screen.findByRole('table');
  await user.click(screen.getByRole('button', { name: 'Проживают' }));
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: /^Проживают · 2$/ })).toBeInTheDocument(),
  );
  const before = counterFilters().length;
  await user.type(screen.getByRole('textbox', { name: 'Поиск сотрудника' }), 'Петров');
  await waitFor(() => expect(screen.getByText('1–1 из 1')).toBeInTheDocument());
  // Второй статус спрашивается счётчиком, активный — нет: его total пришёл страницей.
  expect(counterFilters().slice(before)).toEqual(['ending']);
  expect(screen.getByRole('heading', { name: /^Проживают · 1$/ })).toBeInTheDocument();
});

it('ищет одной страницей после паузы в наборе, а не по запросу на букву (#247)', async () => {
  const user = userEvent.setup();
  const payload = data(people(3));
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  mockPersonnelServer(payload);
  render(
    <MemoryRouter>
      <Personnel />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('tab', { name: /Сотрудники/ }));
  await screen.findByRole('table');
  const before = pageRequests().length;
  await user.type(screen.getByRole('textbox', { name: 'Поиск сотрудника' }), 'Сотрудник 02');
  await waitFor(() => expect(screen.getByText('1–1 из 1')).toBeInTheDocument());
  // Одиннадцать букв — один запрос с целым словом: поиск применяется после паузы.
  expect(
    pageRequests()
      .slice(before)
      .map((query) => query.query),
  ).toEqual(['Сотрудник 02']);
});

it('берёт сводку поверхности из рамки и не запрашивает счётчики отдельно (#247)', async () => {
  const user = userEvent.setup();
  const payload = data(people(4));
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  mockPersonnelServer(payload);
  render(
    <MemoryRouter>
      <Personnel />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('tab', { name: /Сотрудники/ }));
  await screen.findByRole('table');
  await waitFor(() => expect(pageRequests()).toHaveLength(1));
  // Ни одного запроса из одной записи: числа в шапке пришли полем `counts`.
  expect(vi.mocked(personnelApi.employees).mock.calls.map(([query]) => query.per_page)).toEqual([
    PAGE_SIZE,
  ]);
  expect(screen.getByRole('heading', { name: /Персонал/ })).toHaveTextContent('4');
  expect(screen.getByRole('tab', { name: /Сотрудники\s*4/ })).toBeInTheDocument();
});

it('после сохранения перезапрашивает рамку один раз и не объявляет успех ошибкой (#247)', async () => {
  const user = userEvent.setup();
  const payload = data(people(2));
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  mockPersonnelServer(payload);
  vi.spyOn(personnelApi, 'preferences').mockImplementation(async (preferences) => {
    payload.preferences = { ...preferences, revision: preferences.revision + 1 };
    return payload.preferences;
  });
  render(
    <MemoryRouter>
      <Personnel />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('tab', { name: /Сотрудники/ }));
  await screen.findByRole('table');
  const frames = vi.mocked(personnelApi.workspace).mock.calls.length;
  await user.click(screen.getByRole('button', { name: '+ Сохранить текущий список' }));
  await user.click(
    within(screen.getByTestId('personnel-save-list')).getByRole('button', {
      name: 'Сохранить список',
    }),
  );
  await waitFor(() => expect(vi.mocked(personnelApi.workspace).mock.calls.length).toBe(frames + 1));
  expect(screen.queryByText(/Не удалось обновить данные/)).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /Персонал/ })).toHaveTextContent('2');
  expect(
    screen.getByRole('button', { name: 'Убрать сохранённый список «Проживают»' }),
  ).toBeInTheDocument();
});

it('по таймеру перезапрашивает только рамку, карточки списка ждут действия (#251)', async () => {
  // Фейковые только интервалы: таймер поверхности тикает по часам, а ожидания
  // теста (`waitFor`) продолжают работать на настоящих таймаутах.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'], shouldAdvanceTime: true });
  try {
    const user = userEvent.setup();
    const payload = data(people(25));
    vi.spyOn(session, 'useSession').mockReturnValue({
      status: 'authenticated',
      user: null,
      setUser: vi.fn(),
      refresh: vi.fn(),
      logout: vi.fn(),
    });
    mockPersonnelServer(payload);
    render(
      <MemoryRouter>
        <Personnel />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('tab', { name: /Сотрудники/ }));
    await screen.findByRole('table');
    await waitFor(() => expect(pageRequests()).toHaveLength(1));
    // Счётчики при пустом поиске выключены: их числа приходят со сводкой рамки
    // (`sameAsSummary`). Вводим поиск и ждём паузу в наборе, чтобы под тиком были
    // живые запросы `per_page: 1`, а не пустой список (Ф1).
    await user.type(screen.getByRole('textbox', { name: 'Поиск сотрудника' }), 'Сотрудник 2');
    await waitFor(() => expect(screen.getByText('1–6 из 6')).toBeInTheDocument());
    await waitFor(() => expect(counterFilters().length).toBeGreaterThan(0));
    const frames = vi.mocked(personnelApi.workspace).mock.calls.length;
    const pages = pageRequests().length;
    // Счётчики — те же запросы `employees` из одной записи; тик не должен их добавлять (Ф1).
    const counters = counterFilters().length;
    expect(counters).toBeGreaterThan(0);
    await act(async () => {
      vi.advanceTimersByTime(FRAME_REFRESH_MS);
    });
    await waitFor(() =>
      expect(vi.mocked(personnelApi.workspace).mock.calls.length).toBe(frames + 1),
    );
    // Тик несёт рамку `employees=none` и не тянет ни страницу карточек, ни счётчики.
    expect(vi.mocked(personnelApi.workspace).mock.calls.at(-1)?.[1]).toEqual({
      employees: 'none',
      dormitory: null,
      days: 30,
      period: { from: '2026-10-01', to: '2026-10-31' },
    });
    expect(pageRequests()).toHaveLength(pages);
    expect(counterFilters()).toHaveLength(counters);
    expect(screen.getByText('1–6 из 6')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('после исчезновения последней страницы показывает пустой список, а не пустой лист (#247)', async () => {
  const user = userEvent.setup();
  const payload = data(people(25));
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  mockPersonnelServer(payload);
  render(
    <MemoryRouter>
      <Personnel />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('tab', { name: /Сотрудники/ }));
  const table = await screen.findByRole('table');
  await user.click(screen.getByRole('button', { name: 'Далее' }));
  expect(await screen.findByText('21–25 из 25')).toBeInTheDocument();
  expect(within(table).getAllByRole('row')).toHaveLength(6);
  const before = pageRequests().length;
  // Пока вторая страница была открыта, людей убрали: обновление при возвращении на вкладку.
  payload.employees.length = 0;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await waitFor(() => expect(screen.getByTestId('personnel-list-empty')).toBeInTheDocument());
  // Один запрос за второй страницей и один — за последней существующей, без цикла.
  expect(
    pageRequests()
      .slice(before)
      .map((query) => query.page),
  ).toEqual([2, 1]);
  expect(screen.getByText('0–0 из 0')).toBeInTheDocument();
  expect(within(table).getAllByRole('row')).toHaveLength(1);
});

describe('Персонал без задач', () => {
  it('показывает заметки отдельно и сохраняет их в карточке', async () => {
    const user = userEvent.setup();
    const payload = data([person('one', [source(1)])]);
    vi.spyOn(session, 'useSession').mockReturnValue({
      status: 'authenticated',
      user: null,
      setUser: vi.fn(),
      refresh: vi.fn(),
      logout: vi.fn(),
    });
    mockPersonnelServer(payload);
    vi.spyOn(personnelApi, 'detail').mockResolvedValue({
      employee_id: 'one',
      events: [],
      merges: [],
      notes: [
        {
          id: 'note',
          text: 'Договорились о следующей вахте',
          author: 'Администратор',
          created_at: '2026-10-10',
        },
      ],
    });
    const addNote = vi.spyOn(personnelApi, 'addNote').mockResolvedValue({ ok: true });
    render(
      <MemoryRouter>
        <Personnel />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Сотрудники/ });
    expect(screen.queryByRole('tab', { name: /Задачи/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Задачи по сотрудникам')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Сотрудники/ }));
    await user.click(screen.getByRole('button', { name: /^Иванов Иван/ }));
    await user.click(screen.getByRole('button', { name: 'Открыть полную карточку' }));
    await user.click(screen.getByRole('tab', { name: 'Заметки' }));
    expect(await screen.findByText('Договорились о следующей вахте')).toBeInTheDocument();
    expect(screen.queryByText('Новая задача')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Текст заметки'), 'Уточнили дату заезда');
    await user.click(screen.getByRole('button', { name: 'Сохранить заметку' }));
    await waitFor(() => expect(addNote).toHaveBeenCalledWith('one', 'Уточнили дату заезда'));
  });

  it('не предлагает блок задач в настройках рабочей поверхности', () => {
    render(<BlockDialog block={null} data={data([])} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.queryByRole('option', { name: /Задачи/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Проживающий персонал' })).toBeInTheDocument();
  });
});

it('из действий карточки добавляет сотрудника в план по дате и общежитию', async () => {
  const user = userEvent.setup();
  const payload = data([person('one', [source(1)])]);
  payload.dormitories = [
    { id: 1, name: 'Северное', client_name: 'Индилайн', is_archived: false },
    { id: 2, name: 'Старое', client_name: 'Другой клиент', is_archived: true },
  ];
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  vi.spyOn(personnelApi, 'workspace').mockResolvedValue(payload);
  vi.spyOn(personnelApi, 'detail').mockResolvedValue({
    employee_id: 'one',
    events: [],
    notes: [],
    merges: [],
  });
  const add = vi
    .spyOn(personnelApi, 'addEmployeeToArrival')
    .mockResolvedValueOnce({
      required_fields: [
        {
          id: 'transport',
          label: 'Транспорт',
          type: 'select',
          scope: 'arrival',
          required: true,
          inForm: true,
          options: ['Автобус'],
        },
      ],
    })
    .mockResolvedValueOnce({
      created: true,
      plan: {
        id: 'test-arrival',
        date: '2026-11-25',
        dormitory_id: 1,
        count: 1,
        names: ['Иванов Иван'],
        revision: 0,
      },
    });
  render(
    <MemoryRouter initialEntries={['/cabinet/personnel?view=list&employee=one']}>
      <Personnel />
    </MemoryRouter>,
  );
  const card = within(await screen.findByTestId('personnel-profile'));
  expect(
    card
      .getAllByRole('tab')
      .slice(-2)
      .map((tab) => tab.textContent),
  ).toEqual(['Заметки', 'Действия']);
  await user.click(card.getByRole('tab', { name: 'Действия' }));
  await user.click(card.getByRole('button', { name: 'Внести в план заездов' }));
  const shifts = card.getByRole('spinbutton', { name: 'Кол-во смен' });
  expect(shifts).toHaveValue(null);
  await user.type(shifts, '24');
  fireEvent.change(card.getByLabelText('Дата заезда'), { target: { value: '2026-11-25' } });
  const dormitory = card.getByLabelText('Общежитие');
  expect(within(dormitory).queryByRole('option', { name: /Старое/ })).not.toBeInTheDocument();
  await user.selectOptions(
    dormitory,
    within(dormitory).getByRole('option', { name: 'Северное (Индилайн)' }),
  );
  await user.click(card.getByRole('button', { name: 'Внести в план заездов' }));
  expect(add).toHaveBeenNthCalledWith(1, 'one', {
    date: '2026-11-25',
    dormitory_id: 1,
    values: { shifts: '24' },
  });
  const transport = await card.findByLabelText(/Транспорт/);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await user.click(card.getByRole('button', { name: 'Закрыть окно' }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(transport).toBeInTheDocument();
  confirm.mockClear();
  await user.selectOptions(transport, 'Автобус');
  await user.click(card.getByRole('button', { name: 'Внести в план заездов' }));
  expect(add).toHaveBeenNthCalledWith(2, 'one', {
    date: '2026-11-25',
    dormitory_id: 1,
    values: { shifts: '24', transport: 'Автобус' },
  });
  expect(await card.findByRole('link', { name: 'Открыть план заездов' })).toHaveAttribute(
    'href',
    '/cabinet/personnel?view=planning&date=2026-11-25&dormitory=1&arrival=test-arrival',
  );
  await user.click(card.getByRole('button', { name: 'Закрыть окно' }));
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.queryByTestId('personnel-profile')).not.toBeInTheDocument();
});

describe('Отбор сотрудников', () => {
  it('проверяет текущее проживание и срок в пределах тех же общежитий', () => {
    const employee = person('one', [source(1)]);
    employee.sources.push(source(2, 'outflow'));
    const payload = data([employee]);
    expect(filterPeople(payload, { ...criteria, scope: [2] })).toEqual([]);
    expect(filterPeople(payload, { ...criteria, scope: [1], dormitory: 2 })).toEqual([]);
    expect(filterPeople(payload, { ...criteria, filter: 'ending', scope: [1] })).toHaveLength(1);
    employee.current[0].values.shift_end = '2026-10-16';
    expect(filterPeople(payload, { ...criteria, filter: 'ending', scope: [1] })).toEqual([]);
  });
  it('находит карточку по прежнему общежитию после удаления исходной строки', () => {
    const employee = {
      ...person('one'),
      history_dormitory_ids: [2],
    };
    const payload = data([employee]);
    expect(filterPeople(payload, { ...criteria, filter: 'all', dormitory: 2 })).toHaveLength(1);
    expect(filterPeople(payload, { ...criteria, filter: 'all', dormitory: 1 })).toEqual([]);
  });
  it('находит прежние данные после объединения', () => {
    const employee = {
      ...person('primary', [source(1)]),
      member_ids: ['primary', 'previous'],
      variants: { full_name: ['Семёнов И. И.'], phone: ['+7 (912) 123-45-67'] },
    };
    const payload = data([employee]);
    expect(filterPeople(payload, { ...criteria, query: 'семенов' })).toHaveLength(1);
    expect(filterPeople(payload, { ...criteria, query: '9121234567' })).toHaveLength(1);
  });
});

describe('Выбор личности перед добавлением', () => {
  it('показывает совпадение и сохраняет существующую карточку только после выбора', async () => {
    const columns = defaultColumns('residents');
    vi.spyOn(personnelApi, 'binding').mockResolvedValue({
      fields: Object.fromEntries(
        columns
          .filter((column) => column.builtin_key === 'full_name' || column.builtin_key === 'phone')
          .map((column) => [column.builtin_key, column.id]),
      ),
      columns,
    });
    const candidate = {
      id: '00000000-0000-4000-8000-000000000001',
      full_name: 'Иванов Иван',
      personnel_number: '10',
      phone: '+7 (900) 123-45-67',
      identity_status: 'confirmed' as const,
      dormitories: ['Северное'],
      score: 50,
      evidence: ['Совпадает ФИО', 'Совпадает телефон'],
      differences: [],
    };
    vi.spyOn(personnelApi, 'check').mockResolvedValue({
      check_token: 'a'.repeat(64),
      candidates: [candidate],
    });
    const save = vi
      .spyOn(personnelApi, 'createRecord')
      .mockResolvedValue({ row_id: 1, employee_id: candidate.id });
    const user = userEvent.setup();
    render(
      <IdentityDialog
        dormitoryId="1"
        tableKey="residents"
        initial={{ full_name: 'Иванов Иван', phone: '+7 (900) 123-45-67' }}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );
    const radio = await screen.findByRole('radio', { name: /Иванов Иван/ });
    expect(radio).not.toBeChecked();
    expect(save).not.toHaveBeenCalled();
    await user.click(radio);
    await user.click(screen.getByRole('button', { name: 'Использовать карточку' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][2]).toMatchObject({
      mode: 'existing',
      employee_id: candidate.id,
      personnel_number: null,
      full_name: 'Иванов Иван',
      phone: '+7 (900) 123-45-67',
      check_token: 'a'.repeat(64),
    });
  });
});

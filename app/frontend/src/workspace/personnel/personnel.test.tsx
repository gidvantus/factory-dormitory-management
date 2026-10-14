import { render, screen, waitFor, within } from '@testing-library/react';
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
  decisions: [],
  preferences: { revision: 0, blocks: null, lists: [] },
});
const criteria = { filter: 'current' as const, dormitory: null, scope: [], days: 5, query: '' };
afterEach(() => vi.restoreAllMocks());

it('оставляет три фильтра, убирает избранное и сохраняет поиск, карточку и экспорт', async () => {
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
  vi.spyOn(personnelApi, 'workspace').mockResolvedValue(payload);
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
  await user.click(await screen.findByRole('tab', { name: /Сотрудники/ }));
  for (const name of [
    'Дата вахты прошла',
    'Неполные данные',
    'Были в оттоке',
    'Мои сотрудники',
    'Вернулись после оттока',
    'Без телефона',
    'Требуют проверки',
    'Проверить записи →',
  ])
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Добавить в мои сотрудники/)).not.toBeInTheDocument();
  const table = screen.getByRole('table');
  expect(within(table).getAllByRole('row')).toHaveLength(5);
  await user.click(screen.getByRole('button', { name: 'Проживают' }));
  expect(within(table).getAllByRole('row')).toHaveLength(4);
  await user.click(screen.getByRole('button', { name: 'Заканчивается вахта' }));
  expect(within(table).getAllByRole('row')).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: 'Экспорт для Excel' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /Закрыть/ }));
  await user.click(screen.getByRole('button', { name: 'Все сотрудники' }));
  await user.type(screen.getByRole('textbox', { name: 'Поиск сотрудника' }), 'Иванов');
  expect(within(table).getAllByRole('row')).toHaveLength(2);
  await user.click(within(table).getByRole('button', { name: /^Иванов Иван/ }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Карточка сотрудника');
  expect(screen.getByRole('tab', { name: /^История/ })).toBeInTheDocument();
  expect(screen.queryByLabelText(/Добавить в мои сотрудники/)).not.toBeInTheDocument();
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
  vi.spyOn(personnelApi, 'createArrival').mockImplementation(async (values) => {
    const plan = { ...values, id: 'new', revision: 0 };
    payload.arrival_plans = [plan];
    return plan;
  });
  render(
    <MemoryRouter initialEntries={['/cabinet/personnel?view=planning&dormitory=1']}>
      <Personnel />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('tab', { name: 'План заездов' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(screen.queryByLabelText('Период окончания вахты')).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /Старое/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Нажмите на имя, чтобы открыть карточку')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Добавить заезд: Северное, 2026-10-10' }));
  await user.clear(screen.getByLabelText('Количество человек'));
  await user.type(screen.getByLabelText('Количество человек'), '10');
  await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
  expect(await screen.findByText('Ожидается за период: 10 чел.')).toBeInTheDocument();
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
    vi.spyOn(personnelApi, 'workspace').mockResolvedValue(payload);
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

import type { Dormitory, DormitorySettings, Resident, SettingsColumn } from '../../api/client';
import { currentMonth, todayDate } from '../../workspace/dashboard/dates';
import { standardParents, standardTabs } from '../../workspace/dormitories/tabStructure';

export const dormitory: Dormitory = {
  id: 7,
  name: 'Северное',
  client_name: 'Стройкомплект',
  is_archived: false,
  created_at: '2026-10-01T10:00:00Z',
};

export const hostels = [
  { id: 1, name: 'Корпус А' },
  { id: 2, name: 'Корпус Б' },
];

export const residents: Resident[] = [
  ['Семёнов Андрей', 'М', 0, '02', 'Есть'],
  ['Полякова Мария', 'Ж', 1, '04', 'Делается'],
  ['Кузнецов Илья', 'М', 0, '08', 'Нет'],
  ['Орлова Анна', 'Ж', 1, '12', 'Есть'],
].map(([name, gender, host, day, book], index) => {
  const hostel = hostels[Number(host)];
  const month = currentMonth();
  return {
    id: index + 1,
    full_name: String(name),
    gender: gender as Resident['gender'],
    personnel_number: `0${114 + index}`,
    hostel_id: hostel.id,
    hostel_name: hostel.name,
    shift_start: `${month.from.slice(0, 7)}-${day}`,
    shift_end: month.to,
    shift_count: 15,
    medical_book: book as Resident['medical_book'],
    phone: null,
    notes: null,
  };
});

const names: Record<string, string> = {
  row_number: '№',
  gender: 'Пол',
  personnel_number: 'Таб. №',
  full_name: 'ФИО',
  hostel_id: 'Место проживания',
  shift_start: 'Начало вахты',
  shift_end: 'Конец вахты',
  shift_count: 'Смены',
  phone: 'Телефон',
  medical_book: 'ЛМК',
  notes: 'Примечание',
  action_transfer: 'Перевести',
  action_outflow: 'В отток',
  action_delete: 'Удалить',
  settlement_date: 'Дата заселения',
  departure_date: 'Дата выселения',
  citizenship: 'Гражданство',
  reason: 'Причина',
  additional_info: 'Дополнительно',
  advance_amount: 'Сумма аванса',
  action_check_in: 'Заселить',
  action_evict: 'Выселить',
  action_advance: 'Записать на аванс',
  action_settlement: 'Записать на расчёт',
};

const fields = {
  residents:
    'row_number gender personnel_number full_name hostel_id shift_start shift_count shift_end phone medical_book notes action_advance action_settlement action_transfer action_outflow action_delete',
  inflow:
    'settlement_date personnel_number full_name citizenship notes shift_count action_check_in action_outflow action_delete',
  outflow:
    'departure_date personnel_number full_name shift_start reason notes additional_info action_evict action_delete',
  advance: 'personnel_number full_name advance_amount action_delete',
  settlement: 'personnel_number full_name settlement_date action_delete',
  archive: 'action_delete',
};
const tables = Object.fromEntries(
  (Object.keys(fields) as (keyof typeof fields)[]).map((key) => [
    key,
    fields[key].split(' ').map((field, index): SettingsColumn => ({
      id: index + 1,
      name: names[field],
      table_key: key,
      builtin_key: field,
      kind: field.startsWith('action_') || field === 'row_number' ? 'action' : 'text',
      options: [],
      position: index,
      archived: false,
      used_by: [],
    })),
  ]),
);

const parents = standardParents(dormitory);
const settings: DormitorySettings = {
  revision: 'preview',
  tables,
  tabs: [],
  sections: standardTabs.map(({ path, label }) => ({
    key: path,
    name: label,
    parent_key: parents[path] ?? null,
    status: 'active',
    has_data: path === 'residents',
    delete_block_reason: null,
  })),
  rules: [],
};

export function installDemoFetch(): void {
  const readiness = {
    report_date: todayDate(),
    is_ready: false,
    confirmed_at: null,
    confirmed_by: null,
  };
  // Здесь все запросы замыкаются на демо-данных, даже если стенд открыт рядом с приложением.
  window.fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      'https://preview.invalid',
    );
    const { pathname: path, searchParams } = url;
    const method = init?.method ?? 'GET';
    const reply = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const base = `/api/dormitories/${dormitory.id}`;
    if (path === `${base}/report-readiness`) {
      if (method === 'PUT') readiness.is_ready = Boolean(JSON.parse(String(init?.body)).is_ready);
      return reply(readiness);
    }
    if (method !== 'GET')
      return reply({ detail: 'Операция недоступна на тестовой странице.' }, 409);
    if (path === '/api/me')
      return reply({ full_name: 'Демо сотрудник', role: 'owner', email: 'demo@example.invalid' });
    if (path === '/api/trial') return reply({ locked: false, is_active: false, days_left: 0 });
    if (path === '/api/tariffs/current') return reply({ tariff: null });
    if (path === '/api/solutions') return reply({ items: [] });
    if (path === '/api/dormitories') return reply([dormitory]);
    if (path === base) return reply(dormitory);
    if (path === `${base}/settings`) return reply(settings);
    if (path === `${base}/residents`) return reply({ residents, hostels });
    if (path === `${base}/hostels`) {
      const month = (searchParams.get('from') ?? currentMonth().from).slice(0, 7);
      const [year, number] = month.split('-').map(Number);
      const days = Array.from(
        { length: new Date(Date.UTC(year, number, 0)).getUTCDate() },
        (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`,
      );
      return reply({
        months: [
          {
            month: `${month}-01`,
            days,
            hostels: hostels.map((hostel) => ({ ...hostel, values: {} })),
          },
        ],
      });
    }
    if (path === `${base}/report`)
      return reply({
        from_date: searchParams.get('from'),
        to_date: searchParams.get('to'),
        rows: [{ id: 1, name: 'Проживает', position: 0, formula: null, values: {}, errors: {} }],
      });
    const table = path.match(/\/tables\/([^/]+)\/columns$/)?.[1];
    if (table) return reply(tables[table] ?? []);
    if (
      /\/(tabs|inflow|outflow|advance|settlement|rows|report-templates|dormitory-tab-catalog|structure-templates)$/.test(
        path,
      )
    )
      return reply([]);
    return reply({ detail: 'Для этой операции нет демонстрационных данных.' }, 404);
  };
}

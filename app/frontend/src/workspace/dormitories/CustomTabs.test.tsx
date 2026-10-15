import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { CustomTab, CustomTabRow, CustomTabTemplate, TableColumn } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';
import { CreateCustomTabDialog } from './CreateCustomTabDialog';
import { CustomTabTable } from './CustomTabTable';
import { defaultTabOptions } from './customTabOptions';
import { currentMonth } from '../dashboard/dates';

const blank: CustomTab = {
  id: 9,
  dormitory_id: 7,
  name: 'Документы',
  table_key: 'custom_9',
  table_created: false,
  is_active: true,
  has_data: false,
  delete_block_reason: null,
};
const ready = { ...blank, table_created: true };
const columns: TableColumn[] = [
  {
    id: 101,
    table_key: 'custom_9',
    builtin_key: null,
    name: 'Статус',
    kind: 'select',
    position: 0,
    options: [{ id: 'ready', label: 'Готов', archived: false }],
    archived: false,
  },
  {
    id: 102,
    table_key: 'custom_9',
    builtin_key: 'action_delete',
    name: 'Удалить',
    kind: 'action',
    position: 1,
    options: [],
    archived: false,
  },
];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function customPageResponse(url: string, tabs: CustomTab[]) {
  if (url === '/api/me')
    return { status: 200, body: { email: 'test@example.com', full_name: 'Тест', is_active: true } };
  if (url === '/api/dormitories/7')
    return { status: 200, body: { id: 7, name: 'Северное', client_name: 'Клиент' } };
  if (url === '/api/dormitories/7/tabs') return { status: 200, body: tabs };
  return null;
}

it('передаёт выбранный формат, период и кнопки при создании вкладки', async () => {
  const onCreated = vi.fn();
  const fetch = mockFetch((_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.options).toEqual({
      ...defaultTabOptions,
      table_format: 'calendar',
      period_mode: 'month',
      clear_list: true,
      row_actions: false,
    });
    return { status: 201, body: { ...ready, options: body.options } };
  });
  render(<CreateCustomTabDialog dormitoryId="7" onClose={vi.fn()} onCreated={onCreated} />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Название вкладки'), 'График');
  await user.selectOptions(screen.getByLabelText('Формат таблицы'), 'calendar');
  expect(screen.getByLabelText('Выбор периода')).toHaveValue('month');
  expect(screen.queryByRole('option', { name: 'Без периода' })).not.toBeInTheDocument();
  await user.click(screen.getByLabelText('Очистить список'));
  await user.click(screen.getByLabelText('Действия со строкой — удаление'));
  await user.click(screen.getByRole('button', { name: 'Создать вкладку' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('переключает месяцы, скрывает ненужные возможности и подтверждает полную очистку', async () => {
  const tab = {
    ...ready,
    options: {
      ...defaultTabOptions,
      period_mode: 'month' as const,
      date_column_id: 103,
      add_row: false,
      row_actions: false,
      show_dates: false,
      clear_list: true,
    },
  };
  const calls: string[] = [];
  let cleared = false;
  mockFetch((url, init) => {
    calls.push(url);
    const page = customPageResponse(url, [tab]);
    if (page) return page;
    if (url.includes('/personnel/bindings/')) return { status: 200, body: { fields: {} } };
    if (url.endsWith('/columns'))
      return {
        status: 200,
        body: [
          ...columns,
          {
            id: 103,
            table_key: 'custom_9',
            name: 'Выезд',
            kind: 'date',
            position: 2,
            archived: false,
            options: [],
            builtin_key: null,
          },
        ],
      };
    if (url.endsWith('/clear') && init?.method === 'POST') {
      cleared = true;
      return { status: 200, body: { deleted: 8 } };
    }
    if (url.includes('/rows?')) return { status: 200, body: [{ id: 20, custom_values: {} }] };
    return { status: 404, body: { detail: 'Не найдено' } };
  });
  renderApp('/cabinet/dormitories/7/custom/9');
  const user = userEvent.setup();
  await screen.findByLabelText('Статус, строка 20');
  expect(screen.queryByRole('button', { name: '+ Добавить строку' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Удалить' })).not.toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: 'Выезд' })).not.toBeInTheDocument();
  expect(
    calls.some((url) => url.endsWith(`?from=${currentMonth().from}&to=${currentMonth().to}`)),
  ).toBe(true);
  const heading = screen.getByTestId('dormitory-details-heading');
  expect(within(heading).getByRole('form', { name: 'Период общежития' })).toBeInTheDocument();
  expect(
    within(screen.getByTestId('custom-tab-table')).queryByRole('form'),
  ).not.toBeInTheDocument();
  fireEvent.change(within(heading).getByLabelText('Месяц'), { target: { value: '2026-02' } });
  await waitFor(() =>
    expect(calls.some((url) => url.endsWith('?from=2026-02-01&to=2026-02-28'))).toBe(true),
  );
  await user.click(screen.getByRole('button', { name: 'Очистить список' }));
  const dialog = screen.getByTestId('clear-custom-tab-modal');
  expect(dialog).toHaveTextContent('за всё время');
  expect(cleared).toBe(false);
  await user.click(within(dialog).getByRole('button', { name: 'Очистить список' }));
  await waitFor(() => expect(cleared).toBe(true));
  expect(await screen.findByText('В таблице пока нет записей.')).toBeInTheDocument();
});

it('сохраняет дневные значения и показывает их после возвращения к месяцу', async () => {
  const tab = {
    ...ready,
    options: {
      ...defaultTabOptions,
      table_format: 'calendar' as const,
      period_mode: 'month' as const,
    },
  };
  const values: Record<string, string> = {};
  mockFetch((url, init) => {
    const page = customPageResponse(url, [tab]);
    if (page) return page;
    if (url.includes('/personnel/bindings/')) return { status: 200, body: { fields: {} } };
    if (url.endsWith('/columns')) return { status: 200, body: columns };
    if (url.includes('/days/')) {
      const day = url.split('/days/')[1];
      const body = JSON.parse(String(init?.body));
      values[day] = body.value;
      return { status: 200, body };
    }
    if (url.includes('/rows?'))
      return { status: 200, body: [{ id: 20, custom_values: {}, calendar_values: { ...values } }] };
    return { status: 404, body: { detail: 'Не найдено' } };
  });
  renderApp('/cabinet/dormitories/7/custom/9');
  const user = userEvent.setup();
  await screen.findByLabelText('Статус, строка 20');
  fireEvent.change(screen.getByLabelText('Месяц'), { target: { value: '2026-02' } });
  const input = await screen.findByLabelText('12.02.2026, строка 20');
  await user.type(input, '42');
  await user.tab();
  await waitFor(() => expect(values['2026-02-12']).toBe('42'));
  await user.click(screen.getByRole('button', { name: 'Следующий месяц' }));
  expect(await screen.findByLabelText('12.03.2026, строка 20')).toHaveValue('');
  await user.click(screen.getByRole('button', { name: 'Предыдущий месяц' }));
  expect(await screen.findByLabelText('12.02.2026, строка 20')).toHaveValue('42');
});

it('показывает диапазон в шапке и убирает его при переходе во вкладку без периода', async () => {
  const tab: CustomTab = {
    ...ready,
    options: { ...defaultTabOptions, period_mode: 'range', date_column_id: 103 },
  };
  const other: CustomTab = {
    ...ready,
    id: 10,
    name: 'Без периода',
    table_key: 'custom_10',
    options: { ...defaultTabOptions },
  };
  const calls: string[] = [];
  mockFetch((url) => {
    calls.push(url);
    const page = customPageResponse(url, [tab, other]);
    if (page) return page;
    if (url.includes('/personnel/bindings/')) return { status: 200, body: { fields: {} } };
    if (url.endsWith('/columns')) return { status: 200, body: columns };
    if (url.includes('/rows')) return { status: 200, body: [] };
    return { status: 404, body: { detail: 'Не найдено' } };
  });
  renderApp('/cabinet/dormitories/7/custom/9');
  const heading = await screen.findByTestId('dormitory-details-heading');
  await within(heading).findByRole('form', { name: 'Период общежития' });
  const user = userEvent.setup();
  fireEvent.change(within(heading).getByTestId('dormitory-period-from'), {
    target: { value: '2026-02-01' },
  });
  fireEvent.change(within(heading).getByTestId('dormitory-period-to'), {
    target: { value: '2026-02-03' },
  });
  await user.click(within(heading).getByRole('button', { name: 'Применить' }));
  await waitFor(() =>
    expect(calls.some((url) => url.endsWith('/tabs/9/rows?from=2026-02-01&to=2026-02-03'))).toBe(
      true,
    ),
  );
  expect(
    within(screen.getByTestId('custom-tab-table')).queryByRole('form'),
  ).not.toBeInTheDocument();
  await user.click(screen.getByTestId('dormitory-custom-tab-10'));
  await waitFor(() =>
    expect(screen.queryByRole('form', { name: 'Период общежития' })).not.toBeInTheDocument(),
  );
  await user.click(screen.getByTestId('dormitory-custom-tab-9'));
  expect(await screen.findByTestId('dormitory-period-from')).toHaveValue('2026-02-01');
});

it('добавляет локальную вкладку, блокирует строки до создания таблицы и сохраняет ячейки', async () => {
  let tabs: CustomTab[] = [];
  let rows: CustomTabRow[] = [];
  const requests = mockFetch((url, init) => {
    if (url.includes('/personnel/bindings/'))
      return { status: 200, body: { fields: {}, columns: [] } };
    if (url === '/api/me')
      return {
        status: 200,
        body: { email: 'test@example.com', full_name: 'Тест', is_active: true },
      };
    if (url === '/api/dormitories/7')
      return { status: 200, body: { id: 7, name: 'Северное', client_name: 'Клиент' } };
    if (url.includes('/hostels?')) return { status: 200, body: { months: [] } };
    if (url === '/api/dormitories/7/tabs') {
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          name: 'Документы',
          source_tab_id: null,
          options: defaultTabOptions,
        });
        tabs = [blank];
        return { status: 201, body: blank };
      }
      return { status: 200, body: tabs };
    }
    if (url.endsWith('/settings')) {
      if (init?.method === 'PUT') {
        const payload = JSON.parse(String(init.body));
        expect(payload.tables[0].columns[0]).toEqual({
          name: 'Статус',
          kind: 'select',
          options: [{ id: null, label: 'Готов', archived: false }],
          archived: false,
        });
        tabs = [ready];
      }
      return {
        status: 200,
        body: {
          revision: 'a'.repeat(64),
          sections: [
            {
              key: 'places',
              name: 'Размещение персонала',
              parent_key: null,
              status: 'active',
              has_data: false,
              delete_block_reason: null,
            },
          ],
          tabs,
          tables: {
            custom_9: tabs[0]?.table_created
              ? columns.map((column) => ({ ...column, used_by: [] }))
              : [],
          },
          rules: [],
        },
      };
    }
    if (url.endsWith('/tables/custom_9/columns')) return { status: 200, body: columns };
    if (url.endsWith('/tabs/9/rows')) {
      if (init?.method === 'POST') {
        rows = [{ id: 20, custom_values: {} }];
        return { status: 201, body: rows[0] };
      }
      return { status: 200, body: rows };
    }
    if (url.endsWith('/rows/20/cells/101')) {
      const payload = JSON.parse(String(init?.body)) as { value: string };
      rows[0].custom_values['101'] = payload.value;
      return { status: 200, body: payload };
    }
    return { status: 404, body: { detail: 'Не найдено' } };
  });
  const app = renderApp('/cabinet/dormitories/7/places');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Настроить' }));
  const addTab = await screen.findByRole('button', { name: '+ Добавить вкладку' });
  await waitFor(() => expect(addTab).toBeEnabled());
  await user.click(addTab);
  await user.type(screen.getByLabelText('Название вкладки'), 'Документы');
  await user.click(screen.getByRole('button', { name: 'Создать вкладку' }));
  await user.click(await screen.findByRole('button', { name: 'Открыть таблицу ↗' }));
  expect(await screen.findByTestId('custom-tab-empty')).toBeInTheDocument();
  expect(screen.getByTestId('dormitory-custom-tab-9')).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('button', { name: '+ Добавить строку' })).toBeDisabled();
  expect(requests.mock.calls.some(([url]) => String(url).endsWith('/tabs/9/rows'))).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Создать таблицу' }));
  await user.click(await screen.findByRole('button', { name: '+ Добавить столбец' }));
  await user.type(screen.getByLabelText('Название столбца 1'), 'Статус');
  await user.selectOptions(screen.getByLabelText('Формат столбца 1'), 'select');
  await user.type(screen.getByLabelText('Вариант 1 столбца 1'), 'Готов');
  await user.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
  await screen.findByText('Изменения сохранены');
  await user.click(screen.getByRole('button', { name: 'Закрыть' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '+ Добавить строку' })).toBeEnabled(),
  );
  expect(screen.queryByRole('button', { name: 'Связь с персоналом' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '+ Добавить строку' }));
  await user.selectOptions(await screen.findByLabelText('Статус, строка 20'), 'ready');
  await waitFor(() => expect(rows[0].custom_values['101']).toBe('ready'));
  app.unmount();
  renderApp('/cabinet/dormitories/7/custom/9');
  expect(await screen.findByLabelText('Статус, строка 20')).toHaveValue('ready');
});

it('выбирает шаблон из другого общежития и позволяет назвать независимую копию', async () => {
  const templates: CustomTabTemplate[] = [
    { ...ready, dormitory_name: 'Северное', client_name: 'Клиент' },
    {
      ...ready,
      id: 12,
      dormitory_id: 8,
      name: 'Проверки',
      table_key: 'custom_12',
      dormitory_name: 'Южное',
      client_name: 'Другой клиент',
    },
  ];
  const onCreated = vi.fn();
  const fetch = mockFetch((url, init) => {
    if (url === '/api/custom-tab-templates') return { status: 200, body: templates };
    expect(url).toBe('/api/dormitories/7/tabs');
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Мои проверки', source_tab_id: 12 });
    return { status: 201, body: { ...ready, name: 'Мои проверки' } };
  });
  render(<CreateCustomTabDialog dormitoryId="7" onClose={vi.fn()} onCreated={onCreated} />);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Основа вкладки'), 'template');
  await waitFor(() => expect(screen.getByLabelText('Шаблон вкладки')).toBeEnabled());
  expect(screen.queryByRole('option', { name: /Северное/ })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Шаблон вкладки'), '12');
  expect(screen.getByLabelText('Название вкладки')).toHaveValue('Проверки');
  expect(screen.getByText(/Изменения исходной вкладки не повлияют/)).toBeInTheDocument();
  await user.clear(screen.getByLabelText('Название вкладки'));
  await user.type(screen.getByLabelText('Название вкладки'), 'Мои проверки');
  await user.click(screen.getByRole('button', { name: 'Создать вкладку' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ ...ready, name: 'Мои проверки' }));
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('сохраняет название при ошибке создания и позволяет повторить', async () => {
  let failed = true;
  const onCreated = vi.fn();
  mockFetch(() =>
    failed
      ? { status: 409, body: { detail: 'Вкладка с таким названием уже есть' } }
      : { status: 201, body: blank },
  );
  render(<CreateCustomTabDialog dormitoryId="7" onClose={vi.fn()} onCreated={onCreated} />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Название вкладки'), 'Документы');
  await user.click(screen.getByRole('button', { name: 'Создать вкладку' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Вкладка с таким названием уже есть');
  expect(screen.getByLabelText('Название вкладки')).toHaveValue('Документы');
  failed = false;
  await user.click(screen.getByRole('button', { name: 'Создать вкладку' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(blank));
});

it('не удаляет строку до подтверждения и сохраняет её при ошибке сервера', async () => {
  let rows: CustomTabRow[] = [{ id: 20, custom_values: { '101': 'ready' } }];
  let failed = true;
  const fetch = mockFetch((url, init) => {
    if (url.endsWith('/columns')) return { status: 200, body: columns };
    if (url.includes('/personnel/bindings/'))
      return { status: 200, body: { fields: {}, columns: [] } };
    if (init?.method === 'DELETE') {
      if (failed) return { status: 503, body: { detail: 'Повторите позже' } };
      rows = [];
      return { status: 204 };
    }
    return { status: 200, body: rows };
  });
  render(<CustomTabTable dormitoryId="7" tab={ready} range={currentMonth()} onChanged={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Удалить' }));
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Удалить' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Повторите позже');
  expect(screen.getByTestId('custom-row-20')).toBeInTheDocument();
  failed = false;
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Удалить' }));
  await waitFor(() => expect(screen.queryByTestId('custom-row-20')).not.toBeInTheDocument());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('блокирует добавление строк при ошибке загрузки и восстанавливает после повтора', async () => {
  let failed = true;
  mockFetch((url) => {
    if (url.endsWith('/columns')) return { status: 200, body: columns };
    if (url.includes('/personnel/bindings/'))
      return { status: 200, body: { fields: {}, columns: [] } };
    return failed ? { status: 503, body: { detail: 'Нет соединения' } } : { status: 200, body: [] };
  });
  render(<CustomTabTable dormitoryId="7" tab={ready} range={currentMonth()} onChanged={vi.fn()} />);
  const user = userEvent.setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('Нет соединения');
  expect(screen.getByRole('button', { name: '+ Добавить строку' })).toBeDisabled();
  failed = false;
  await user.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '+ Добавить строку' })).toBeEnabled(),
  );
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { CustomTab, CustomTabRow, CustomTabTemplate, TableColumn } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';
import { CreateCustomTabDialog } from './CreateCustomTabDialog';
import { CustomTabTable } from './CustomTabTable';

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
        expect(JSON.parse(String(init.body))).toEqual({ name: 'Документы', source_tab_id: null });
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
  render(<CustomTabTable dormitoryId="7" tab={ready} onChanged={vi.fn()} />);
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
  render(<CustomTabTable dormitoryId="7" tab={ready} onChanged={vi.fn()} />);
  const user = userEvent.setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('Нет соединения');
  expect(screen.getByRole('button', { name: '+ Добавить строку' })).toBeDisabled();
  failed = false;
  await user.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '+ Добавить строку' })).toBeEnabled(),
  );
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { mockFetch } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';
import { ReportLinkEditor } from './ReportLinkEditor';

afterEach(() => vi.unstubAllGlobals());

it('выбирает пол и пользовательский вариант в составе текущего хостела', async () => {
  mockFetch((url) => {
    if (url.endsWith('/tables/residents/columns')) {
      return {
        status: 200,
        body: [
          {
            id: 42,
            name: 'Пол',
            builtin_key: 'gender',
            kind: 'select',
            archived: false,
            options: [
              { id: 'М', label: 'М', archived: false },
              { id: 'Ж', label: 'Ж', archived: false },
              { id: 'example-option', label: 'Не указан', archived: false },
            ],
          },
        ],
      };
    }
    return { status: 200, body: [] };
  });
  const change = vi.fn();
  const user = userEvent.setup();
  render(
    <ReportLinkEditor dormitoryId="7" hostel disabled={false} initial={null} onChange={change} />,
  );
  await user.selectOptions(screen.getByLabelText('Таблица-источник'), 'residents');
  expect(await screen.findByLabelText('Что считать за день')).toHaveValue('snapshot');
  await user.selectOptions(screen.getByLabelText('Столбец'), '42');
  await user.selectOptions(screen.getByLabelText('Значение для подсчёта'), 'example-option');
  expect(change).toHaveBeenLastCalledWith({
    table_key: 'residents',
    column_id: 42,
    operator: 'equals',
    value: 'example-option',
    date_column_id: null,
    count_mode: 'snapshot',
    scope: 'hostel',
  });
  await user.selectOptions(screen.getByLabelText('Что считать за день'), 'daily');
  expect(screen.getByLabelText(/Распределять по дате/)).toBeInTheDocument();
  expect(change).toHaveBeenLastCalledWith(
    expect.objectContaining({
      count_mode: 'daily',
      scope: 'hostel',
      value: 'example-option',
    }),
  );
});

it('открывает редактор хостелов в настройках и обновляет рабочую таблицу после сохранения', async () => {
  const initial = [
    { key: 'paid_m', name: 'Оплачено мест М', formula: null, link: null, archived: false },
    {
      key: 'free_m',
      name: 'Свободных мест М',
      formula: '=[Оплачено мест М]-2',
      link: null,
      archived: false,
    },
  ];
  let rows = initial;
  const writes = vi.fn();
  mockFetch((url, init) => {
    if (url === '/api/me')
      return {
        status: 200,
        body: { email: 'test@example.com', full_name: 'Тест', is_active: true },
      };
    if (url === '/api/dormitories/7')
      return { status: 200, body: { id: 7, name: 'Северное', client_name: 'Клиент' } };
    if (url.endsWith('/tabs')) return { status: 200, body: [] };
    if (url.includes('/hostels/settings?'))
      return {
        status: 200,
        body: {
          defaults: initial,
          hostels: [{ id: 10, name: 'Корпус', rows, version: 0 }],
          templates: [],
        },
      };
    if (url.endsWith('/hostels/10/settings') && init?.method === 'PUT') {
      const payload = JSON.parse(String(init.body));
      rows = payload.rows;
      writes(payload);
      return { status: 204 };
    }
    if (url.includes('/hostels?')) {
      const day = new URL(url, 'http://localhost').searchParams.get('from')!;
      return {
        status: 200,
        body: {
          months: [
            {
              month: day,
              days: [day],
              hostels: [
                {
                  id: 10,
                  name: 'Корпус',
                  rows,
                  values: { paid_m: { [day]: 8 }, free_m: { [day]: 6 } },
                },
              ],
            },
          ],
        },
      };
    }
    if (url.endsWith('/settings'))
      return {
        status: 200,
        body: {
          version: 0,
          sections: [
            {
              key: 'places',
              name: 'Размещение персонала',
              status: 'active',
              parent_key: null,
              has_data: true,
            },
          ],
          tabs: [],
          tables: {},
          rules: [],
          exchange_options: {},
          standard_clear_list: {},
        },
      };
    return { status: 404 };
  });
  renderApp('/cabinet/dormitories/7/places');
  const user = userEvent.setup();
  expect(await screen.findByRole('rowheader', { name: /Свободных мест М/ })).toHaveTextContent('ƒ');
  await user.click(screen.getByRole('button', { name: 'Настроить' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Настройки общежития' }));
  await user.click(await dialog.findByRole('button', { name: 'Хостел Корпус Настроить строки' }));
  await user.clear(dialog.getByLabelText('Название строки'));
  await user.type(dialog.getByLabelText('Название строки'), 'Оплачено');
  await user.click(dialog.getByRole('button', { name: /Свободных мест М/ }));
  expect(dialog.getByRole('textbox', { name: 'Формула' })).toHaveValue('=[Оплачено]-2');
  await user.click(dialog.getByRole('button', { name: 'Сохранить хостел' }));
  await waitFor(() =>
    expect(writes).toHaveBeenCalledWith(expect.objectContaining({ version: 0, rows })),
  );
  await user.click(dialog.getByRole('button', { name: 'Закрыть' }));
  expect(await screen.findByRole('rowheader', { name: 'Оплачено' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '+ Добавить хостел' }));
  const create = within(await screen.findByRole('dialog', { name: 'Настройки общежития' }));
  expect(await create.findByLabelText('Название хостела')).toHaveValue('');
});

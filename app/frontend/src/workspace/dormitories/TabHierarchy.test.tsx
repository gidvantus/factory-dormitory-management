import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { CustomTab, StandardSection } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';
import { CreateCustomTabDialog } from './CreateCustomTabDialog';
import { StandardSectionsManager } from './StandardSectionsManager';
import { ReportLinkEditor } from './ReportLinkEditor';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const root: CustomTab = {
  id: 10,
  dormitory_id: 7,
  name: 'Документы',
  parent_id: null,
  is_group: true,
  table_key: 'custom_10',
  table_created: false,
  is_active: true,
  has_data: false,
  delete_block_reason: null,
};
const child: CustomTab = {
  ...root,
  id: 11,
  name: 'Паспорта',
  table_key: 'custom_11',
  parent_id: 10,
  is_group: false,
};
const second: CustomTab = { ...child, id: 12, name: 'Допуски', table_key: 'custom_12' };

it('создаёт несколько именованных подвкладок одним действием', async () => {
  const onCreated = vi.fn();
  mockFetch((url, init) => {
    if (url.endsWith('/tabs') && init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({
        name: 'Документы',
        source_tab_id: null,
        subtabs: ['Паспорта', 'Допуски'],
      });
      return { status: 201, body: root };
    }
    return { status: 404 };
  });
  render(<CreateCustomTabDialog dormitoryId="7" onClose={vi.fn()} onCreated={onCreated} />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Название вкладки'), 'Документы');
  await user.click(screen.getByLabelText('Создать вкладку с подвкладками'));
  await user.type(screen.getByLabelText('Название подвкладки 1'), 'Паспорта');
  await user.click(screen.getByRole('button', { name: '+ Добавить подвкладку' }));
  await user.type(screen.getByLabelText('Название подвкладки 2'), 'Допуски');
  await user.click(screen.getByRole('button', { name: 'Создать вкладку' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(root));
});

it('показывает дочерние вкладки внутри их раздела и блокирует таблицу скрытого родителя', async () => {
  mockFetch((url) => {
    if (url === '/api/me')
      return {
        status: 200,
        body: { email: 'test@example.com', full_name: 'Тест', is_active: true },
      };
    if (url === '/api/dormitories/7')
      return { status: 200, body: { id: 7, name: 'Северное', client_name: 'Клиент' } };
    if (url.endsWith('/tabs'))
      return { status: 200, body: [{ ...root, is_active: false }, child, second] };
    return { status: 404 };
  });
  renderApp('/cabinet/dormitories/7/custom/10/11');
  expect(await screen.findByTestId('custom-tab-empty')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Создать таблицу' })).toBeDisabled();
  expect(screen.getByRole('navigation', { name: 'Разделы общежития' })).not.toHaveTextContent(
    'Паспорта',
  );
  expect(
    within(screen.getByRole('navigation', { name: 'Подвкладки: Документы' })).getByRole('link', {
      name: 'Паспорта',
    }),
  ).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByRole('button', { name: '+ Добавить подвкладку' })).not.toBeInTheDocument();
});

it('скрывает стандартную подвкладку отдельно, сохраняя доступ к соседней и просмотр данных', async () => {
  mockFetch((url) => {
    if (url === '/api/me')
      return {
        status: 200,
        body: { email: 'test@example.com', full_name: 'Тест', is_active: true },
      };
    if (url === '/api/dormitories/7')
      return {
        status: 200,
        body: {
          id: 7,
          name: 'Северное',
          client_name: 'Клиент',
          section_states: { inflow: 'hidden' },
        },
      };
    if (url.endsWith('/tabs')) return { status: 200, body: [] };
    if (url.includes('/inflow?')) return { status: 200, body: [] };
    if (url.endsWith('/tables/inflow/columns')) return { status: 200, body: [] };
    return { status: 404 };
  });
  renderApp('/cabinet/dormitories/7/movement/inflow');
  expect(
    await screen.findByText(/Вкладка скрыта. Данные доступны только для просмотра/),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '+ Добавить строку' })).toBeDisabled();
  expect(screen.queryByTestId('dormitory-subtab-inflow')).not.toBeInTheDocument();
  expect(screen.getByTestId('dormitory-subtab-outflow')).toBeInTheDocument();
  expect(screen.getByTestId('dormitory-period-from')).toBeEnabled();
});

it('возвращает удалённую стандартную вкладку через управление и запрещает удаление данных', async () => {
  const items: StandardSection[] = [
    {
      key: 'inflow',
      name: 'Приток',
      parent_key: 'movement',
      status: 'active',
      has_data: true,
      delete_block_reason: 'Есть данные за всё время.',
    },
    {
      key: 'movement',
      name: 'Движение персонала',
      parent_key: null,
      status: 'active',
      has_data: true,
      delete_block_reason: 'Есть данные за всё время.',
    },
    {
      key: 'residents',
      name: 'Проживающие',
      parent_key: null,
      status: 'deleted',
      has_data: false,
      delete_block_reason: null,
    },
  ];
  const changed = vi.fn();
  mockFetch((url, init) => {
    if (url.endsWith('/sections')) return { status: 200, body: items };
    if (url.endsWith('/sections/residents') && init?.method === 'PATCH') {
      expect(JSON.parse(String(init.body))).toEqual({ status: 'active' });
      return { status: 200, body: items.map((item) => ({ ...item, status: 'active' })) };
    }
    return { status: 404 };
  });
  render(
    <StandardSectionsManager
      dormitoryId="7"
      onChanged={changed}
      onOpen={vi.fn()}
      busy={false}
      setBusy={vi.fn()}
    />,
  );
  const inflow = await screen.findByTestId('manage-section-inflow');
  expect(within(inflow).getByRole('button', { name: 'Удалить' })).toBeDisabled();
  const residents = screen.getByTestId('manage-section-residents');
  await userEvent
    .setup()
    .click(within(residents).getByRole('button', { name: 'Добавить обратно' }));
  await waitFor(() =>
    expect(within(residents).getByRole('button', { name: 'Открыть' })).toBeInTheDocument(),
  );
});

it('выбирает связь отчёта с таблицей пользовательской подвкладки', async () => {
  const onChange = vi.fn();
  mockFetch((url) => {
    if (url.endsWith('/tabs'))
      return {
        status: 200,
        body: [root, { ...child, table_created: true }, { ...second, table_created: true }],
      };
    if (url.endsWith('/sections')) return { status: 200, body: [] };
    if (url.endsWith('/tables/custom_11/columns'))
      return {
        status: 200,
        body: [
          {
            id: 101,
            table_key: 'custom_11',
            name: 'Дата проверки',
            kind: 'date',
            builtin_key: null,
            options: [],
            archived: false,
            position: 0,
          },
        ],
      };
    return { status: 404 };
  });
  render(<ReportLinkEditor dormitoryId="7" initial={null} onChange={onChange} disabled={false} />);
  const user = userEvent.setup();
  await screen.findByRole('option', { name: 'Документы' });
  await user.selectOptions(screen.getByLabelText('Раздел'), 'custom_10');
  await user.selectOptions(screen.getByLabelText('Подвкладка'), 'custom_11');
  await screen.findByRole('option', { name: 'Дата проверки' });
  await user.selectOptions(screen.getByLabelText('Столбец'), '101');
  expect(screen.getByLabelText('Столбец')).toHaveValue('101');
});

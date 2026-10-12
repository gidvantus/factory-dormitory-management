import { createRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { mockFetch } from '../../test/mockFetch';
import { defaultTabCatalog } from '../../test/tableColumns';
import { CreateDormitoryDialog } from './CreateDormitoryDialog';
import { CreateCustomTabDialog } from './CreateCustomTabDialog';
import { renderApp } from '../../test/renderApp';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('показывает одно название, выбирает образец и создаёт только отмеченную подвкладку', async () => {
  const onCreated = vi.fn();
  const variants = [7, 8].map((id) => ({
    id: `custom:${id}`,
    name: 'Документы',
    kind: 'custom',
    tab_id: id,
    dormitory_id: id,
    dormitory_name: `Общежитие ${id}`,
    client_name: 'Клиент',
    parent_name: 'Проживающие',
    path: ['Проживающие', 'Документы'],
  }));
  mockFetch((url, init) => {
    if (url.endsWith('/dormitory-tab-catalog'))
      return {
        status: 200,
        body: [...defaultTabCatalog, { id: 'документы', name: 'Документы', variants }],
      };
    if (url.endsWith('/report-templates')) return { status: 200, body: [] };
    if (url.endsWith('/dormitories') && init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({
        name: 'Новое',
        client_name: 'Клиент',
        tabs: [{ source_id: 'custom:8' }],
      });
      return { status: 201, body: { id: 9 } };
    }
    return { status: 404 };
  });
  render(
    <CreateDormitoryDialog
      onClose={vi.fn()}
      onCreated={onCreated}
      triggerRef={createRef<HTMLButtonElement>()}
    />,
  );
  const user = userEvent.setup();
  await screen.findByRole('checkbox', { name: 'Документы' });
  expect(screen.getAllByRole('checkbox', { name: 'Документы' })).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Снять все' }));
  await user.click(screen.getByRole('checkbox', { name: 'Документы' }));
  await user.selectOptions(screen.getByLabelText('Образец для «Документы»'), 'custom:8');
  expect(screen.getByText('Самостоятельная вкладка')).toBeInTheDocument();
  await user.type(screen.getByLabelText('Название общежития'), 'Новое');
  await user.type(screen.getByLabelText('Название клиента'), 'Клиент');
  await user.click(screen.getByTestId('create-dormitory-submit'));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 9 }));
});

it('не создаёт общежитие без каталога и сохраняет введённое название при повторной загрузке', async () => {
  let attempts = 0;
  mockFetch((url) => {
    if (url.endsWith('/dormitory-tab-catalog'))
      return ++attempts === 1 ? { status: 503 } : { status: 200, body: defaultTabCatalog };
    if (url.endsWith('/report-templates')) return { status: 200, body: [] };
    return { status: 404 };
  });
  render(
    <CreateDormitoryDialog
      onClose={vi.fn()}
      onCreated={vi.fn()}
      triggerRef={createRef<HTMLButtonElement>()}
    />,
  );
  const user = userEvent.setup();
  await screen.findByText(/Не удалось загрузить список вкладок/);
  await user.type(screen.getByLabelText('Название общежития'), 'Сохраняется');
  expect(screen.getByTestId('create-dormitory-submit')).toBeDisabled();
  await user.click(screen.getByRole('button', { name: /Повторить/ }));
  await waitFor(() => expect(screen.getByTestId('create-dormitory-submit')).toBeEnabled());
  expect(screen.getByLabelText('Название общежития')).toHaveValue('Сохраняется');
});

it('создаёт подвкладку внутри стандартной вкладки с собственными подвкладками', async () => {
  const onCreated = vi.fn();
  mockFetch((url, init) => {
    if (url.endsWith('/tabs') && init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({
        name: 'Документы',
        source_tab_id: null,
        parent_section: 'residents',
        subtabs: ['Проверки'],
      });
      return { status: 201, body: { id: 10 } };
    }
    return { status: 200, body: [] };
  });
  render(
    <CreateCustomTabDialog
      dormitoryId="7"
      parentSection="residents"
      onClose={vi.fn()}
      onCreated={onCreated}
    />,
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Название подвкладки'), 'Документы');
  await user.click(screen.getByLabelText('Создать вкладку с подвкладками'));
  await user.type(screen.getByLabelText('Название подвкладки 1'), 'Проверки');
  await user.click(screen.getByRole('button', { name: 'Создать вкладку' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 10 }));
});

it('открывает выбранный отдельно Приток как самостоятельный раздел', async () => {
  mockFetch((url) => {
    if (url === '/api/me')
      return { status: 200, body: { email: 'test@example.com', full_name: 'Тест' } };
    if (url === '/api/dormitories/7')
      return {
        status: 200,
        body: {
          id: 7,
          name: 'Новое',
          client_name: 'Клиент',
          section_parents: { inflow: null },
          section_states: Object.fromEntries(
            defaultTabCatalog.map((item) => [
              item.variants[0].section_key,
              item.variants[0].section_key === 'inflow' ? 'active' : 'deleted',
            ]),
          ),
        },
      };
    if (url.endsWith('/tabs') || url.includes('/inflow?') || url.endsWith('/columns'))
      return { status: 200, body: [] };
    return { status: 404 };
  });
  renderApp('/cabinet/dormitories/7/inflow');
  expect(await screen.findByRole('heading', { name: 'Приток' })).toBeInTheDocument();
  expect(screen.getByTestId('dormitory-tab-inflow')).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByTestId('dormitory-tab-movement')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Настроить' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '+ Добавить подвкладку' })).not.toBeInTheDocument();
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';
import { TableExchange } from './TableExchange';
import { CreateCustomTabDialog } from './CreateCustomTabDialog';
import { DormitorySettingsDialog } from './DormitorySettingsDialog';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const props = {
  dormitoryId: '7',
  tableKey: 'custom_9',
  name: 'Отпуск',
  options: {},
  readOnly: false,
  beforeAction: async () => {},
  onImported: () => {},
};

it('скачивает шаблон текущей таблицы после завершения сохранений', async () => {
  const before = vi.fn().mockResolvedValue(undefined);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const createUrl = vi.fn().mockReturnValue('blob:template');
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }),
  );
  const fetch = mockFetch(() => ({ status: 200, body: 'xlsx' }));
  render(
    <TableExchange
      {...props}
      beforeAction={before}
      range={{ from: '2026-11-01', to: '2026-11-30' }}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Импорт из Excel' }));
  await user.click(screen.getByRole('button', { name: 'Скачать шаблон' }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(before).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe(
    '/api/dormitories/7/data-transfer/custom_9/template?from=2026-11-01&to=2026-11-30',
  );
});

it('отправляет файл multipart без JSON-заголовка и обновляет данные после сохранения', async () => {
  const changed = vi.fn();
  const fetch = mockFetch((_url, init) => {
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get('file')).toBeInstanceOf(File);
    expect(init?.headers).not.toHaveProperty('Content-Type');
    return { status: 200, body: { rows_added: 2, cells_added: 0 } };
  });
  render(<TableExchange {...props} onImported={changed} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Импорт из Excel' }));
  expect(screen.getByRole('button', { name: 'Добавить данные из файла' })).toBeDisabled();
  await user.upload(screen.getByLabelText('Заполненный шаблон'), new File(['xlsx'], 'Отпуск.xlsx'));
  await user.click(screen.getByRole('button', { name: 'Добавить данные из файла' }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(fetch.mock.calls[0][0]).toBe('/api/dormitories/7/data-transfer/custom_9/import');
  expect(screen.getByRole('status')).toHaveTextContent('Добавлено строк: 2');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('показывает причину отклонения шаблона и позволяет исправить файл', async () => {
  const changed = vi.fn();
  mockFetch(() => ({
    status: 422,
    body: { detail: 'Нужно заполнить данные строго по шаблону. Строка 3: неверная дата.' },
  }));
  render(<TableExchange {...props} onImported={changed} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Импорт из Excel' }));
  await user.upload(screen.getByLabelText('Заполненный шаблон'), new File(['xlsx'], 'Отпуск.xlsx'));
  await user.click(screen.getByRole('button', { name: 'Добавить данные из файла' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Строка 3: неверная дата');
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Добавить данные из файла' })).toBeEnabled();
});

it('после импорта из панели перечитывает отчёт и возвращает фокус на импорт', async () => {
  let imported = false;
  mockFetch((url) => {
    if (url === '/api/me') return { status: 200, body: { full_name: 'Тест', is_active: true } };
    if (url === '/api/dormitories/7')
      return { status: 200, body: { id: 7, name: 'Северное', client_name: 'Клиент' } };
    if (url.endsWith('/tabs')) return { status: 200, body: [] };
    if (url.includes('/data-transfer/report/import?')) {
      imported = true;
      return { status: 200, body: { rows_added: 0, cells_added: 1 } };
    }
    return { status: 404 };
  });
  const report = vi.spyOn(api, 'report').mockImplementation(async (_id, from, to) => ({
    from_date: from,
    to_date: to,
    rows: [
      {
        id: 1,
        name: 'Проживает',
        position: 0,
        formula: null,
        values: imported ? { [from]: '25' } : {},
        errors: {},
      },
    ],
  }));
  renderApp('/cabinet/dormitories/7/report');
  const user = userEvent.setup();
  await screen.findByRole('rowheader', { name: /Проживает/ });
  const actions = () => within(screen.getByRole('group', { name: 'Действия с таблицей' }));
  await user.click(actions().getByRole('button', { name: 'Импорт из Excel' }));
  await user.upload(screen.getByLabelText('Заполненный шаблон'), new File(['xlsx'], 'Отчёт.xlsx'));
  await user.click(screen.getByRole('button', { name: 'Добавить данные из файла' }));
  expect(await screen.findByDisplayValue('25')).toBeInTheDocument();
  expect(report).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Импорт завершён. Добавлено ячеек: 1.')).toBeInTheDocument();
  expect(actions().getByRole('button', { name: 'Импорт из Excel' })).toHaveFocus();
});

it('соблюдает отдельные настройки импорта и экспорта и режим чтения', () => {
  const { rerender } = render(
    <TableExchange {...props} options={{ import_enabled: false, export_enabled: true }} />,
  );
  expect(screen.queryByRole('button', { name: 'Импорт из Excel' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Экспорт в Excel' })).toBeEnabled();
  rerender(<TableExchange {...props} options={{ import_enabled: true, export_enabled: false }} />);
  expect(screen.getByRole('button', { name: 'Импорт из Excel' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Экспорт в Excel' })).not.toBeInTheDocument();
  rerender(<TableExchange {...props} readOnly />);
  expect(screen.queryByRole('button', { name: 'Импорт из Excel' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Экспорт в Excel' })).toBeEnabled();
  rerender(<TableExchange {...props} history />);
  expect(screen.queryByRole('button', { name: 'Импорт из Excel' })).not.toBeInTheDocument();
});

it('передаёт галочки при создании вкладки вместе с подвкладками', async () => {
  const create = vi
    .spyOn(api, 'createCustomTab')
    .mockResolvedValue({ id: 9 } as Awaited<ReturnType<typeof api.createCustomTab>>);
  render(<CreateCustomTabDialog dormitoryId="7" onClose={vi.fn()} onCreated={vi.fn()} />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Название вкладки'), 'Отпуск');
  await user.click(screen.getByLabelText('Создать вкладку с подвкладками'));
  await user.type(screen.getByLabelText('Название подвкладки 1'), 'Согласованные');
  await user.click(screen.getByLabelText('Экспорт данных в Excel'));
  await user.click(screen.getByRole('button', { name: 'Создать вкладку' }));
  expect(create.mock.calls[0][3]).toEqual(['Согласованные']);
  expect(create.mock.calls[0][6]).toMatchObject({ import_enabled: true, export_enabled: false });
});

it('сохраняет независимые галочки стандартной таблицы через общий конструктор', async () => {
  const data = {
    revision: 'a'.repeat(64),
    tables: {},
    tabs: [],
    rules: [],
    sections: [
      {
        key: 'residents',
        name: 'Проживающие',
        parent_key: null,
        status: 'active' as const,
        has_data: false,
        delete_block_reason: null,
      },
    ],
    exchange_options: { residents: { import_enabled: true, export_enabled: true } },
  };
  vi.spyOn(api, 'dormitorySettings').mockResolvedValue(data);
  const save = vi.spyOn(api, 'saveDormitorySettings').mockResolvedValue(data);
  render(
    <DormitorySettingsDialog
      dormitoryId="7"
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByLabelText('Импорт данных по шаблону'));
  await user.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][1].exchange_options?.residents).toEqual({
    import_enabled: false,
    export_enabled: true,
  });
});

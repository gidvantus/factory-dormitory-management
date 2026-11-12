import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ExchangePermissionsContext } from '../../auth/exchangePermissions';
import { api } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';
import { renderWithExchangePermissions as render } from '../../test/renderWithExchangePermissions';
import { TableExchange } from './TableExchange';
import { CreateCustomTabDialog } from './CreateCustomTabDialog';
import { DormitorySettingsDialog } from './DormitorySettingsDialog';

afterEach(() => {
  sessionStorage.clear();
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

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])('показывает кнопки только при правах: импорт %s, экспорт %s', (importEnabled, exportEnabled) => {
  render(<TableExchange {...props} />, {
    import_enabled: importEnabled,
    export_enabled: exportEnabled,
  });
  expect(screen.queryByRole('button', { name: 'Импорт из Excel' }) !== null).toBe(importEnabled);
  expect(screen.queryByRole('button', { name: 'Экспорт в Excel' }) !== null).toBe(exportEnabled);
});

it('скрывает открытый импорт при отзыве права', async () => {
  const view = render(<TableExchange {...props} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Импорт из Excel' }));
  expect(screen.getByTestId('table-import-modal')).toBeInTheDocument();
  view.rerender(
    <ExchangePermissionsContext.Provider value={{ import_enabled: false, export_enabled: true }}>
      <TableExchange {...props} />
    </ExchangePermissionsContext.Provider>,
  );
  expect(screen.queryByTestId('table-import-modal')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Импорт из Excel' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Экспорт в Excel' })).toBeInTheDocument();
});

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
  let jobId: string | undefined;
  const fetch = mockFetch((_url, init) => {
    if (init?.method !== 'POST')
      return {
        status: 200,
        body: { id: jobId, status: 'completed', rows_added: 2, cells_added: 0 },
      };
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get('file')).toBeInstanceOf(File);
    expect(init?.headers).not.toHaveProperty('Content-Type');
    jobId = new Headers(init.headers).get('Idempotency-Key') ?? undefined;
    expect(jobId).toMatch(/^[a-f0-9-]{36}$/);
    return { status: 202, body: { id: jobId, status: 'pending', rows_added: 0, cells_added: 0 } };
  });
  render(<TableExchange {...props} onImported={changed} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Импорт из Excel' }));
  expect(screen.getByRole('button', { name: 'Добавить данные из файла' })).toBeDisabled();
  await user.upload(screen.getByLabelText('Заполненный шаблон'), new File(['xlsx'], 'Отпуск.xlsx'));
  await user.click(screen.getByRole('button', { name: 'Добавить данные из файла' }));
  expect(await screen.findByRole('progressbar')).toHaveAttribute('value', '100');
  expect(fetch.mock.calls[0][0]).toBe('/api/dormitories/7/data-transfer/custom_9/import/jobs');
  expect(fetch.mock.calls[1][0]).toBe(
    `/api/dormitories/7/data-transfer/custom_9/import/jobs/${jobId}`,
  );
  expect(screen.getByRole('status')).toHaveTextContent('Добавлено строк: 2');
  await user.click(screen.getByRole('button', { name: 'Закрыть' }));
  expect(changed).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('показывает счётчик в окне и 100% только после сохранения', async () => {
  const changed = vi.fn();
  let poll = 0;
  mockFetch((_url, init) => {
    if (init?.method === 'POST') return { status: 202, body: { status: 'pending' } };
    poll += 1;
    const completed = poll > 2;
    return {
      status: 200,
      body: {
        status: completed ? 'completed' : 'pending',
        rows_added: completed ? 2325 : 0,
        progress: { rows_processed: poll === 1 ? 850 : 2325, rows_total: 2325 },
      },
    };
  });
  render(<TableExchange {...props} onImported={changed} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Импорт из Excel' }));
  await user.upload(screen.getByLabelText('Заполненный шаблон'), new File(['xlsx'], 'Отпуск.xlsx'));
  await user.click(screen.getByRole('button', { name: 'Добавить данные из файла' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(await dialog.findByText('Обработано строк: 850 из 2 325 · 37%')).toBeInTheDocument();
  expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '37');
  expect(
    await dialog.findByText('Обработано строк: 2 325 из 2 325 · 99%', {}, { timeout: 2500 }),
  ).toBeInTheDocument();
  expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '99');
  expect(
    await dialog.findByText('Обработано строк: 2 325 из 2 325 · 100%', {}, { timeout: 2500 }),
  ).toBeInTheDocument();
  expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '100');
  expect(dialog.getByText('Импорт завершён. Добавлено строк: 2325.')).toBeInTheDocument();
  expect(changed).not.toHaveBeenCalled();
  await user.click(dialog.getByRole('button', { name: 'Закрыть' }));
  expect(changed).toHaveBeenCalledOnce();
}, 10_000);

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

it('отменяет выполняющийся импорт и позволяет выбрать другой файл', async () => {
  const changed = vi.fn();
  let cancelRequested = false;
  mockFetch((url, init) => {
    if (url.endsWith('/cancel')) {
      expect(init?.method).toBe('POST');
      cancelRequested = true;
      return { status: 200, body: { status: 'pending', cancel_requested: true } };
    }
    if (init?.method === 'POST') return { status: 202, body: { status: 'pending' } };
    return {
      status: 200,
      body: cancelRequested
        ? { status: 'cancelled' }
        : { status: 'pending', progress: { rows_processed: 500, rows_total: 1000 } },
    };
  });
  render(<TableExchange {...props} onImported={changed} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Импорт из Excel' }));
  await user.upload(screen.getByLabelText('Заполненный шаблон'), new File(['xlsx'], 'Отпуск.xlsx'));
  await user.click(screen.getByRole('button', { name: 'Добавить данные из файла' }));
  expect(await screen.findByRole('progressbar')).toHaveAttribute('value', '50');
  await user.click(screen.getByRole('button', { name: 'Отменить импорт' }));
  expect(await screen.findByText('Импорт отменён. Данные из файла не сохранены.')).toBeVisible();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Выбрать другой файл' }));
  expect(screen.getByLabelText('Заполненный шаблон')).toHaveValue('');
});

it('после 504 проверяет статус принятого задания и не отправляет файл повторно', async () => {
  const changed = vi.fn();
  let jobId: string | null = null;
  const fetch = mockFetch((url, init) => {
    if (init?.method === 'POST') {
      jobId = new Headers(init.headers).get('Idempotency-Key');
      return { status: 504 };
    }
    expect(url).toBe(`/api/dormitories/7/data-transfer/custom_9/import/jobs/${jobId}`);
    return {
      status: 200,
      body: { id: jobId, status: 'completed', rows_added: 2336, cells_added: 0 },
    };
  });
  render(<TableExchange {...props} onImported={changed} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Импорт из Excel' }));
  await user.upload(screen.getByLabelText('Заполненный шаблон'), new File(['xlsx'], 'Отпуск.xlsx'));
  await user.click(screen.getByRole('button', { name: 'Добавить данные из файла' }));
  expect(await screen.findByText('Импорт завершён. Добавлено строк: 2336.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Закрыть' }));
  expect(changed).toHaveBeenCalledOnce();
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('после импорта из панели перечитывает отчёт и возвращает фокус на импорт', async () => {
  let imported = false;
  mockFetch((url) => {
    if (url === '/api/me')
      return {
        status: 200,
        body: {
          full_name: 'Тест',
          is_active: true,
          permissions: { import_enabled: true, export_enabled: true },
        },
      };
    if (url === '/api/dormitories/7')
      return { status: 200, body: { id: 7, name: 'Северное', client_name: 'Клиент' } };
    if (url.endsWith('/tabs')) return { status: 200, body: [] };
    if (url.includes('/data-transfer/report/import/jobs?')) {
      imported = true;
      return { status: 202, body: { status: 'completed', rows_added: 0, cells_added: 1 } };
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
  expect(await screen.findByRole('progressbar')).toHaveAttribute('value', '100');
  await user.click(screen.getByRole('button', { name: 'Закрыть' }));
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

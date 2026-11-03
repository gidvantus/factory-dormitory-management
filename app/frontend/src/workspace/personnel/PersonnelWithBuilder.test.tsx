import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as session from '../../auth/SessionProvider';
import { ApiError } from '../../api/client';
import { personnelApi } from '../../api/personnel';
import { personnelBuilderApi } from '../../api/personnelBuilder';
import type { BuilderDocument } from '../../api/personnelBuilder';
import { UnsavedChangesProvider } from '../../components/UnsavedChanges';
import { PersonnelWithBuilder } from './PersonnelWithBuilder';
import {
  emptyBuilderState,
  newColumn,
  newTab,
  seedData,
} from '../../pages/personnel-tab-builder/model';

function saved(): BuilderDocument {
  const tab = {
    ...newTab(),
    id: 'real-work',
    kind: 'table' as const,
    name: 'Рабочая таблица',
    columns: [
      { ...newColumn(), id: 'hours', name: 'Часы', kind: 'number' as const },
      {
        ...newColumn(),
        id: 'pay',
        name: 'Оплата',
        kind: 'number' as const,
        rule: {
          mode: 'formula' as const,
          expression: '=[Часы]*400',
          refs: { Часы: 'hours' },
          link: null,
        },
      },
    ],
    rows: [{ id: 'row', values: { hours: '8' } }],
  };
  return { revision: 4, state: { version: 3, defaultTab: 'workspace', tabs: [tab] } };
}
beforeEach(() => {
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  const NativeRequest = Request;
  vi.stubGlobal(
    'Request',
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, { ...init, signal: undefined });
      }
    },
  );
  vi.spyOn(personnelApi, 'workspace').mockResolvedValue(seedData());
  vi.spyOn(personnelBuilderApi, 'read').mockResolvedValue(saved());
  vi.spyOn(personnelBuilderApi, 'sources').mockResolvedValue({ sources: [], templates: [] });
  vi.spyOn(personnelBuilderApi, 'save').mockImplementation(async (document) => ({
    ...document,
    revision: document.revision + 1,
  }));
  vi.spyOn(personnelBuilderApi, 'evaluate').mockImplementation(async (request) => {
    const tab = request.state.tabs.find((tab) => tab.id === request.tabId)!;
    const hours = Number(tab.rows[0]?.values.hours ?? 0);
    return { columns: { row: { pay: { value: hours * 400 } } } };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function open(query = '?tab=real-work') {
  const router = createMemoryRouter(
    [
      {
        path: '/cabinet/personnel',
        element: (
          <UnsavedChangesProvider>
            <PersonnelWithBuilder />
          </UnsavedChangesProvider>
        ),
      },
      { path: '/outside', element: <h1>Другая страница</h1> },
    ],
    { initialEntries: [`/cabinet/personnel${query}`] },
  );
  return { ...render(<RouterProvider router={router} />), router };
}
async function editHours(value: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Изменить запись 1' }));
  fireEvent.change(screen.getByLabelText('Часы'), { target: { value } });
  await user.click(screen.getByRole('button', { name: 'Сохранить запись' }));
}
const amount = () =>
  screen
    .getByRole('table', { name: 'Рабочая таблица' })
    .querySelector('tbody tr')
    ?.children[1].textContent?.replace(/\s/g, '');

describe('Рабочий конструктор организации', () => {
  it('не загружает примеры из localStorage, использует серверный расчёт и сохраняет только свои вкладки', async () => {
    const storage = vi.spyOn(Storage.prototype, 'getItem');
    const view = open();
    await screen.findByRole('table', { name: 'Рабочая таблица' });
    await waitFor(() => expect(amount()).toBe('3200'));
    expect(screen.queryByRole('tab', { name: 'Учёт работы' })).not.toBeInTheDocument();
    expect(storage.mock.calls.some(([key]) => key.startsWith('domovoy-personnel'))).toBe(false);
    await editHours('9');
    await waitFor(() => expect(amount()).toBe('3600'));
    await waitFor(() => expect(personnelBuilderApi.save).toHaveBeenCalled());
    const sent = vi.mocked(personnelBuilderApi.save).mock.calls[0][0];
    expect(sent.revision).toBe(4);
    expect(sent.state.tabs.filter((tab) => !tab.builtin)[0].rows[0].values.hours).toBe('9');
    await waitFor(() =>
      expect(screen.getByText('Изменения конструктора сохранены.')).toBeInTheDocument(),
    );
    view.unmount();
  });
  it('берёт результаты с сервера, включая ошибки, вместо демонстрационного движка', async () => {
    vi.mocked(personnelBuilderApi.evaluate).mockResolvedValue({
      columns: { row: { pay: { value: null, error: 'Источник недоступен в организации' } } },
    });
    open();
    await screen.findByRole('table', { name: 'Рабочая таблица' });
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Рабочая таблица' })).toHaveTextContent(
        'Ошибка: Источник недоступен в организации',
      ),
    );
    expect(personnelBuilderApi.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          tabs: expect.not.arrayContaining([expect.objectContaining({ builtin: true })]),
        }),
      }),
      expect.any(AbortSignal),
    );
  });
  it('ожидает новый расчёт после обновления источников и закрывает CSV до получения результата', async () => {
    const document = saved();
    document.state.tabs[0].columns[1].rule = {
      mode: 'link',
      expression: '=',
      refs: {},
      link: {
        sourceId: 'arrivals',
        operation: 'sum',
        valueField: 'count',
        sourceRowId: null,
        match: null,
        filters: [],
        dateField: null,
        empty: 'zero',
      },
    };
    vi.mocked(personnelBuilderApi.read).mockResolvedValue(document);
    open();
    await waitFor(() => expect(amount()).toBe('3200'));
    expect(screen.getByRole('button', { name: 'Скачать CSV' })).toBeEnabled();
    let resolveCalculation:
      ((result: { columns: { row: { pay: { value: number } } } }) => void) | undefined;
    vi.mocked(personnelBuilderApi.evaluate).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCalculation = resolve;
        }),
    );
    vi.mocked(personnelApi.workspace).mockResolvedValue(structuredClone(seedData()));
    fireEvent.focus(window);
    await waitFor(() => expect(amount()).toBe('…'));
    expect(screen.getByRole('button', { name: 'Скачать CSV' })).toBeDisabled();
    await waitFor(() => expect(resolveCalculation).toBeDefined());
    await act(async () => resolveCalculation!({ columns: { row: { pay: { value: 7500 } } } }));
    await waitFor(() => expect(amount()).toBe('7500'));
    expect(screen.getByRole('button', { name: 'Скачать CSV' })).toBeEnabled();
  });
  it('не перекрывает новую правку ответом предыдущего сохранения и отправляет правильную следующую версию', async () => {
    let resolveFirst: ((document: BuilderDocument) => void) | undefined;
    vi.mocked(personnelBuilderApi.save).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    open();
    await screen.findByRole('table', { name: 'Рабочая таблица' });
    await editHours('9');
    await waitFor(() => expect(personnelBuilderApi.save).toHaveBeenCalledTimes(1));
    await editHours('10');
    await act(async () =>
      resolveFirst!({ ...vi.mocked(personnelBuilderApi.save).mock.calls[0][0], revision: 5 }),
    );
    await waitFor(() => expect(personnelBuilderApi.save).toHaveBeenCalledTimes(2));
    const sent = vi.mocked(personnelBuilderApi.save).mock.calls[1][0];
    expect(sent.revision).toBe(5);
    expect(sent.state.tabs.find((tab) => tab.id === 'real-work')!.rows[0].values.hours).toBe('10');
  });
  it('сохраняет черновик при конфликте, разрешает внутренние переходы и предупреждает об уходе со страницы', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    vi.mocked(personnelBuilderApi.save).mockRejectedValue(
      new ApiError(409, 'Конструктор изменён другим сотрудником'),
    );
    const user = userEvent.setup();
    const { router } = open();
    await screen.findByRole('table', { name: 'Рабочая таблица' });
    await editHours('9');
    await screen.findByText('Конструктор изменён другим сотрудником');
    expect(screen.getByRole('button', { name: 'Скачать черновик' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Рабочая поверхность' }));
    expect(confirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('tab', { name: 'Рабочая таблица' }));
    await editHours('11');
    await act(async () => {
      void router.navigate('/outside');
    });
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(router.state.location.pathname).toBe('/cabinet/personnel');
  });
  it('не обновляет версию поверх открытого черновика при возврате фокуса', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('table', { name: 'Рабочая таблица' });
    await user.click(screen.getByRole('button', { name: 'Настроить подвкладку' }));
    const before = vi.mocked(personnelBuilderApi.read).mock.calls.length;
    fireEvent.focus(window);
    await act(async () => Promise.resolve());
    expect(personnelBuilderApi.read).toHaveBeenCalledTimes(before);
    fireEvent.change(screen.getByLabelText('Название подвкладки'), {
      target: { value: 'Моя правка' },
    });
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(personnelBuilderApi.save).toHaveBeenCalled());
    expect(vi.mocked(personnelBuilderApi.save).mock.calls[0][0].revision).toBe(4);
  });
  it('открывает пустой конструктор организации с исходными тремя разделами и позволяет создать вкладку', async () => {
    vi.mocked(personnelBuilderApi.read).mockResolvedValue({
      revision: 0,
      state: { ...emptyBuilderState(), tabs: [] },
    });
    const user = userEvent.setup();
    open('');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '+ Добавить подвкладку' })).toBeEnabled(),
    );
    expect(
      within(screen.getByRole('tablist', { name: 'Раздел персонала' })).getAllByRole('tab'),
    ).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: '+ Добавить подвкладку' }));
    fireEvent.change(await screen.findByLabelText('Название подвкладки'), {
      target: { value: 'Проверить документы' },
    });
    await user.click(screen.getByRole('button', { name: 'Создать подвкладку' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Проверить документы' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    await waitFor(() => expect(personnelBuilderApi.save).toHaveBeenCalled());
    expect(personnelBuilderApi.sources).toHaveBeenCalled();
  });
});

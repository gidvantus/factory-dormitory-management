import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as session from '../../auth/SessionProvider';
import { personnelApi } from '../../api/personnel';
import { UnsavedChangesProvider } from '../../components/UnsavedChanges';
import { PersonnelProjectPreview } from './PersonnelProjectPreview';
import { PROJECT_STORAGE_KEY } from './projectModel';
import { PROJECT_DATA_KEY } from './projectApi';
import { STORAGE_KEY } from './model';

beforeEach(() => {
  localStorage.removeItem(PROJECT_STORAGE_KEY);
  localStorage.removeItem(PROJECT_DATA_KEY);
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
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function open(query = '') {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <UnsavedChangesProvider>
            <PersonnelProjectPreview />
          </UnsavedChangesProvider>
        ),
      },
    ],
    { initialEntries: [`/preview/personnel-tab-builder${query}`] },
  );
  return { ...render(<RouterProvider router={router} />), router };
}
const tableRows = () =>
  screen
    .getByRole('table', { name: 'Учёт работы' })
    .querySelectorAll<HTMLTableRowElement>('tbody tr');

describe('Конструктор на штатной странице проекта', () => {
  it('показывает исходную рабочую поверхность, список и отдельный план с четвёртой вкладкой без запросов в сервер', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const apiBefore = personnelApi.workspace;
    const user = userEvent.setup();
    const view = open();
    const tabs = await screen.findByRole('tablist', { name: 'Раздел персонала' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Рабочая поверхность', 'Сотрудники5', 'План заездов', 'Учёт работы']);
    expect(screen.getByTestId('personnel-workspace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Настроить поверхность' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /^Сотрудники/ }));
    expect(await screen.findByRole('heading', { name: 'Сотрудники' })).toBeInTheDocument();
    expect(screen.getByLabelText('Поиск сотрудника')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'План заездов' }));
    await user.click(await screen.findByRole('button', { name: 'Настроить вид' }));
    const dialog = screen.getByRole('dialog', { name: 'Настройки плана заездов' });
    expect(within(dialog).getByRole('tab', { name: /Поля формы/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: 'Правая панель' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await user.click(screen.getByRole('tab', { name: 'Учёт работы' }));
    expect(await screen.findByRole('table', { name: 'Учёт работы' })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    view.unmount();
    expect(personnelApi.workspace).toBe(apiBefore);
  });
  it('позволяет попробовать часы и изменить формулу в коротком отдельном окне', async () => {
    const user = userEvent.setup();
    open('?tab=work-register');
    await screen.findByRole('table', { name: 'Учёт работы' });
    await user.click(screen.getByRole('button', { name: 'Изменить запись 1' }));
    fireEvent.change(screen.getByLabelText('Часы'), { target: { value: '9' } });
    await user.click(screen.getByRole('button', { name: 'Сохранить запись' }));
    expect(tableRows()[0].cells[3].textContent?.replace(/\s/g, '')).toBe('3600');
    await user.click(screen.getByRole('button', { name: 'Изменить формулу начисления' }));
    expect(
      screen.getByRole('dialog', { name: 'Настроить столбец «Начислено»' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Формула'), {
      target: { value: '=([Часы]*[Ставка за час])+500' },
    });
    await user.click(screen.getByRole('button', { name: 'Проверить расчёт' }));
    expect(screen.getByRole('status')).toHaveTextContent('Результат: 4100');
    await user.click(screen.getByRole('button', { name: 'Сохранить правило' }));
    expect(tableRows()[0].cells[3].textContent?.replace(/\s/g, '')).toBe('4100');
    expect(tableRows()[1].cells[3].textContent?.replace(/\s/g, '')).toBe('5000');
  });
  it('открывает настоящую карточку, редактирует телефон и сразу обновляет связанную ячейку, сохраняя после перезагрузки', async () => {
    const user = userEvent.setup();
    const view = open('?tab=work-register');
    await screen.findByRole('table', { name: 'Учёт работы' });
    await user.click(screen.getByRole('button', { name: 'Алексей Иванов' }));
    const dialog = await screen.findByRole('dialog', { name: 'Карточка сотрудника' });
    await user.click(within(dialog).getByRole('button', { name: 'Уточнить данные' }));
    fireEvent.change(within(dialog).getByLabelText('Телефон'), {
      target: { value: '+7 900 123-45-67' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить данные карточки' }));
    await waitFor(() => expect(within(dialog).queryByLabelText('Телефон')).not.toBeInTheDocument());
    await user.click(within(dialog).getByRole('button', { name: 'Закрыть окно' }));
    expect(tableRows()[0].cells[4]).toHaveTextContent('+7 900 123-45-67');
    view.unmount();
    open('?tab=work-register');
    await screen.findByRole('table', { name: 'Учёт работы' });
    expect(tableRows()[0].cells[4]).toHaveTextContent('+7 900 123-45-67');
  });
  it('добавляет свою подвкладку рядом со штатными и сохраняет старый отдельный пример без изменений', async () => {
    const previous = localStorage.getItem(STORAGE_KEY);
    const user = userEvent.setup();
    const { router } = open();
    await screen.findByRole('tablist', { name: 'Раздел персонала' });
    await user.click(screen.getByRole('button', { name: '+ Добавить подвкладку' }));
    fireEvent.change(screen.getByLabelText('Название подвкладки'), {
      target: { value: 'Проверить документы' },
    });
    await user.click(screen.getByRole('button', { name: 'Создать подвкладку' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Проверить документы' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(router.state.location.search).toContain('tab=');
    expect(screen.getByRole('tab', { name: 'План заездов' })).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(previous);
  });
});

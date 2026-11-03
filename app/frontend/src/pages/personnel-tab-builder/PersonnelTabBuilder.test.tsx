import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonnelTabBuilder } from './PersonnelTabBuilder';
import { initialState, STORAGE_KEY } from './model';
import { UnsavedChangesProvider } from '../../components/UnsavedChanges';

function open(
  tab?: string,
): ReturnType<typeof render> & { router: ReturnType<typeof createMemoryRouter> } {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <UnsavedChangesProvider>
            <PersonnelTabBuilder />
          </UnsavedChangesProvider>
        ),
      },
    ],
    { initialEntries: [`/preview/personnel-tab-builder${tab ? `?tab=${tab}` : ''}`] },
  );
  return { ...render(<RouterProvider router={router} />), router };
}
beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  // Как в проверках UnsavedChanges: Node Request не принимает jsdom AbortSignal.
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Конструктор подвкладок персонала', () => {
  it('переходит к созданной вкладке после снятия защиты сохранённого черновика', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    const { router } = open();
    await user.click(screen.getByRole('button', { name: '+ Добавить подвкладку' }));
    fireEvent.change(screen.getByLabelText('Название подвкладки'), {
      target: { value: 'Новый список' },
    });
    await user.click(screen.getByRole('button', { name: 'Создать подвкладку' }));
    await waitFor(() => expect(router.state.location.search).toContain('tab='));
    expect(screen.getByRole('tab', { name: 'Новый список' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(confirm).not.toHaveBeenCalled();
  });
  it('сохраняет три основные вкладки, показывает свои примеры и работает без сети', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    open();
    const tabs = screen.getByRole('tablist', { name: 'Подвкладки персонала' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent?.replace('●', '')),
    ).toEqual([
      'Рабочая поверхность',
      'Сотрудники',
      'План заездов',
      'Заканчивается вахта',
      'Учёт документов',
      'Учёт смен',
      'Примеры расчётов',
    ]);
    expect(
      screen.getByRole('table', { name: 'Список сотрудников' }).querySelectorAll('tbody tr'),
    ).toHaveLength(3);
    await user.click(within(tabs).getByRole('tab', { name: 'Сотрудники' }));
    expect(
      screen.getByRole('table', { name: 'Список сотрудников' }).querySelectorAll('tbody tr'),
    ).toHaveLength(5);
    await user.click(within(tabs).getByRole('tab', { name: 'План заездов' }));
    await user.click(screen.getByRole('button', { name: 'Настроить вид' }));
    expect(screen.getByRole('dialog', { name: 'Настройки плана заездов' })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('создаёт отфильтрованный список, применяет настройки действий и сохраняет после перезагрузки', async () => {
    const user = userEvent.setup();
    const view = open();
    await user.click(screen.getByRole('button', { name: '+ Добавить подвкладку' }));
    const editor = screen.getByRole('dialog', { name: 'Добавить подвкладку' });
    fireEvent.change(within(editor).getByLabelText('Название подвкладки'), {
      target: { value: 'Северный — вахты' },
    });
    await user.selectOptions(within(editor).getByLabelText('Кого показывать'), 'ending');
    await user.click(within(editor).getByLabelText('Северный'));
    await user.click(within(editor).getByRole('tab', { name: 'Возможности' }));
    await user.click(within(editor).getByLabelText('Поиск на вкладке'));
    await user.click(
      within(editor).getByLabelText('Открывать эту подвкладку при входе в «Персонал»'),
    );
    await user.click(within(editor).getByRole('button', { name: 'Создать подвкладку' }));
    expect(screen.getByRole('tab', { name: 'Северный — вахты' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('textbox', { name: 'Поиск сотрудника' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Список сотрудников' }).querySelectorAll('tbody tr'),
    ).toHaveLength(1);
    view.unmount();
    open();
    expect(screen.getByRole('tab', { name: 'Северный — вахты' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('не допускает одинаковые имена и сохраняет незакрытый черновик при ошибке', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: '+ Добавить подвкладку' }));
    const editor = screen.getByRole('dialog');
    fireEvent.change(within(editor).getByLabelText('Название подвкладки'), {
      target: { value: 'Сотрудники' },
    });
    await user.click(within(editor).getByRole('button', { name: 'Создать подвкладку' }));
    expect(within(editor).getByRole('alert')).toHaveTextContent('уже есть');
    expect(within(editor).getByLabelText('Название подвкладки')).toHaveValue('Сотрудники');
  });

  it('создаёт таблицу с вариантами списка и добавляет, изменяет и возвращает запись', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: '+ Добавить подвкладку' }));
    const editor = screen.getByRole('dialog');
    fireEvent.change(within(editor).getByLabelText('Название подвкладки'), {
      target: { value: 'Выдача пропусков' },
    });
    await user.click(within(editor).getByRole('radio', { name: /Своя таблица/ }));
    fireEvent.change(within(editor).getByLabelText('Название столбца'), {
      target: { value: 'Пропуск' },
    });
    await user.selectOptions(within(editor).getByLabelText('Тип столбца'), 'select');
    fireEvent.change(within(editor).getByLabelText('Варианты списка'), {
      target: { value: 'Выдан\nОжидаем' },
    });
    await user.click(within(editor).getByRole('button', { name: 'Создать подвкладку' }));
    await user.click(screen.getByRole('button', { name: '+ Добавить запись' }));
    const rowEditor = screen.getByRole('dialog', { name: 'Добавить запись' });
    await user.selectOptions(within(rowEditor).getByLabelText('Пропуск'), 'Выдан');
    await user.click(within(rowEditor).getByRole('button', { name: 'Сохранить запись' }));
    expect(
      within(screen.getByRole('table', { name: 'Выдача пропусков' })).getByText('Выдан'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Изменить запись 1' }));
    await user.selectOptions(screen.getByLabelText('Пропуск'), 'Ожидаем');
    await user.click(screen.getByRole('button', { name: 'Сохранить запись' }));
    expect(
      within(screen.getByRole('table', { name: 'Выдача пропусков' })).getByText('Ожидаем'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Удалить запись 1' }));
    expect(
      within(screen.getByRole('table', { name: 'Выдача пропусков' })).queryByText('Ожидаем'),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Вернуть запись' }));
    expect(
      within(screen.getByRole('table', { name: 'Выдача пропусков' })).getByText('Ожидаем'),
    ).toBeInTheDocument();
  });

  it('скрывает и восстанавливает вкладку из архива вместе с данными, не меняя основные', async () => {
    const user = userEvent.setup();
    open('documents');
    await user.click(screen.getByRole('button', { name: 'Управление подвкладками' }));
    const manager = screen.getByRole('dialog', { name: 'Подвкладки персонала' });
    expect(
      within(manager).queryByRole('button', { name: 'В архив подвкладку Сотрудники' }),
    ).not.toBeInTheDocument();
    await user.click(
      within(manager).getByRole('button', { name: 'Скрыть подвкладку Учёт документов' }),
    );
    expect(screen.queryByRole('tab', { name: 'Учёт документов' })).not.toBeInTheDocument();
    await user.click(
      within(manager).getByRole('button', { name: 'Показать подвкладку Учёт документов' }),
    );
    await user.click(
      within(manager).getByRole('button', { name: 'Поднять подвкладку Учёт документов' }),
    );
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent?.replace('●', ''))[3]).toBe(
      'Учёт документов',
    );
    await user.click(
      within(manager).getByRole('button', { name: 'В архив подвкладку Учёт документов' }),
    );
    await user.click(within(manager).getByText('Архив подвкладок (1)'));
    await user.click(
      within(manager).getByRole('button', { name: 'Восстановить подвкладку Учёт документов' }),
    );
    await user.click(within(manager).getByRole('button', { name: 'Готово' }));
    await user.click(screen.getByRole('tab', { name: 'Учёт документов' }));
    expect(
      screen.getByRole('table', { name: 'Учёт документов' }).querySelectorAll('tbody tr'),
    ).toHaveLength(3);
  });

  it('сохраняет заполненные столбцы при скрытии и связывает сотрудника с карточкой', async () => {
    const user = userEvent.setup();
    open('documents');
    await user.click(screen.getByRole('button', { name: 'Настроить подвкладку' }));
    const editor = screen.getByRole('dialog');
    expect(within(editor).getAllByLabelText(/Тип столбца/)[0]).toBeDisabled();
    await user.click(within(editor).getAllByRole('button', { name: 'Скрыть столбец' })[1]);
    await user.click(within(editor).getByRole('button', { name: 'Сохранить настройки' }));
    expect(
      within(screen.getByRole('table', { name: 'Учёт документов' })).queryByText(
        'Медицинская книжка',
      ),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Настроить подвкладку' }));
    await user.click(screen.getByText('Скрытые столбцы'));
    await user.click(screen.getByRole('button', { name: 'Восстановить столбец' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(
      within(screen.getByRole('table', { name: 'Учёт документов' })).getByText(
        'Медицинская книжка',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Алексей Иванов' }));
    expect(screen.getByRole('dialog', { name: 'Алексей Иванов' })).toHaveTextContent(
      'Карточка из реестра сотрудников',
    );
  });

  it('создаёт отдельную поверхность блоков и редактирует блок исходным конструктором', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: '+ Добавить подвкладку' }));
    const editor = screen.getByRole('dialog');
    fireEvent.change(within(editor).getByLabelText('Название подвкладки'), {
      target: { value: 'Работа кадровика' },
    });
    await user.click(within(editor).getByRole('radio', { name: /Рабочие блоки/ }));
    await user.click(within(editor).getByRole('button', { name: 'Создать подвкладку' }));
    await user.click(screen.getByRole('button', { name: '+ Добавить блок' }));
    const block = screen.getByRole('dialog', { name: 'Добавить блок' });
    expect(within(block).getByLabelText('Содержимое')).toBeInTheDocument();
    await user.selectOptions(within(block).getByLabelText('Содержимое'), 'contacts');
    await user.click(within(block).getByRole('button', { name: 'Сохранить блок' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Контакты сотрудников' })).toBeInTheDocument();
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as ReturnType<typeof initialState>;
    expect(state.tabs.find((tab) => tab.name === 'Работа кадровика')?.blocks).toHaveLength(3);
    expect(state.tabs.find((tab) => tab.id === 'workspace')?.blocks).toHaveLength(4);
  });
});

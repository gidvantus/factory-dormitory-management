import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { UnsavedChangesProvider } from '../../components/UnsavedChanges';
import { PersonnelTabBuilder } from './PersonnelTabBuilder';
import { initialState, loadState, newColumn, STORAGE_KEY } from './model';
import type { PersonnelTab } from './model';

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
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

function open(tab = 'documents'): ReturnType<typeof render> {
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
    { initialEntries: [`/preview/personnel-tab-builder?tab=${tab}`] },
  );
  return render(<RouterProvider router={router} />);
}
function seed(id: string, change: (tab: PersonnelTab) => void): void {
  const state = initialState();
  change(state.tabs.find((tab) => tab.id === id)!);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
const tableRows = (name: string): HTMLTableRowElement[] => [
  ...screen.getByRole('table', { name }).querySelectorAll<HTMLTableRowElement>('tbody tr'),
];

describe('Расширенная своя таблица в персонале', () => {
  it('обновляет прежний сохранённый пример без потери записей и настроек кнопок', () => {
    const previous = initialState();
    const old = {
      ...previous,
      version: 1,
      tabs: previous.tabs
        .filter((tab) => tab.id !== 'timesheet')
        .map((tab) => {
          const value = { ...tab } as Partial<PersonnelTab>;
          delete value.tableOptions;
          delete value.dateColumnId;
          delete value.parentId;
          delete value.isGroup;
          if (tab.id === 'documents') value.actions = { ...tab.actions, add: false, remove: false };
          return value;
        }),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(old));
    const next = loadState();
    const documents = next.tabs.find((tab) => tab.id === 'documents')!;
    expect(next.version).toBe(3);
    expect(documents.rows).toEqual(previous.tabs.find((tab) => tab.id === 'documents')!.rows);
    expect(documents.tableOptions.add_row).toBe(false);
    expect(documents.tableOptions.row_actions).toBe(false);
    expect(next.tabs.some((tab) => tab.id === 'timesheet')).toBe(true);
  });

  it('отбирает записи по выбранной дате за месяц и диапазон, включая границы', async () => {
    seed('documents', (tab) => {
      tab.tableOptions.period_mode = 'month';
      tab.dateColumnId = 'date';
    });
    const user = userEvent.setup();
    open();
    expect(tableRows('Учёт документов')).toHaveLength(1);
    expect(tableRows('Учёт документов')[0]).toHaveTextContent('Медицинская книжка');
    await user.click(screen.getByRole('button', { name: 'Следующий месяц' }));
    expect(tableRows('Учёт документов')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Месяц таблицы'), { target: { value: '2027-04' } });
    expect(tableRows('Учёт документов')[0]).toHaveTextContent('Удостоверение');
    await user.click(screen.getByRole('button', { name: 'Настроить подвкладку' }));
    await user.selectOptions(screen.getByLabelText('Выбор периода'), 'range');
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    fireEvent.change(screen.getByLabelText('Период с'), { target: { value: '2026-11-10' } });
    fireEvent.change(screen.getByLabelText('Период по'), { target: { value: '2026-11-10' } });
    expect(tableRows('Учёт документов')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Период по'), { target: { value: '2026-11-09' } });
    expect(screen.getByRole('alert')).toHaveTextContent('начальная дата');
  });

  it('сохраняет дневные значения между месяцами, форматами и повторным открытием', async () => {
    const user = userEvent.setup();
    const view = open('timesheet');
    fireEvent.change(screen.getByLabelText('Алексей Иванов, 2026-11-02'), {
      target: { value: '9' },
    });
    expect(tableRows('Учёт смен')[0]).toHaveTextContent('23');
    await user.click(screen.getByRole('button', { name: 'Следующий месяц' }));
    expect(tableRows('Учёт смен')).toHaveLength(2);
    expect(screen.getByLabelText('Алексей Иванов, 2026-12-02')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Предыдущий месяц' }));
    expect(screen.getByLabelText('Алексей Иванов, 2026-11-02')).toHaveValue('9');
    await user.click(screen.getByRole('button', { name: 'Настроить подвкладку' }));
    await user.selectOptions(screen.getByLabelText('Формат таблицы'), 'list');
    await user.selectOptions(screen.getByLabelText('Выбор периода'), 'none');
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(tableRows('Учёт смен')).toHaveLength(2);
    expect(screen.queryByLabelText('Алексей Иванов, 2026-11-02')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Настроить подвкладку' }));
    await user.selectOptions(screen.getByLabelText('Формат таблицы'), 'calendar');
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(screen.getByLabelText('Алексей Иванов, 2026-11-02')).toHaveValue('9');
    view.unmount();
    open('timesheet');
    expect(screen.getByLabelText('Алексей Иванов, 2026-11-02')).toHaveValue('9');
  });

  it('применяет кнопки и скрытие дат, подтверждает очистку всего списка и восстанавливает его', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: 'Настроить подвкладку' }));
    await user.click(screen.getByLabelText('Добавить строку'));
    await user.click(screen.getByLabelText('Действия со строкой — удаление'));
    await user.click(screen.getByLabelText('Показывать столбцы дат'));
    await user.click(screen.getByLabelText('Очистить список'));
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(screen.queryByRole('button', { name: '+ Добавить запись' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Удалить запись 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Действует до' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Поиск по таблице'), { target: { value: 'Анна' } });
    expect(tableRows('Учёт документов')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Очистить список' }));
    expect(screen.getByRole('dialog', { name: 'Очистить список?' })).toHaveTextContent(
      'включая записи вне выбранного периода',
    );
    expect(tableRows('Учёт документов')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Очистить весь список' }));
    expect(tableRows('Учёт документов')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Вернуть список' }));
    fireEvent.change(screen.getByLabelText('Поиск по таблице'), { target: { value: '' } });
    expect(tableRows('Учёт документов')).toHaveLength(3);
  });

  it('копирует структуру из общежития с новыми идентификаторами и без записей', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: '+ Добавить подвкладку' }));
    fireEvent.change(screen.getByLabelText('Название подвкладки'), {
      target: { value: 'Журнал из общежития' },
    });
    await user.click(screen.getByRole('radio', { name: /Своя таблица/ }));
    const source = screen.getByLabelText('Основа таблицы');
    const option = within(source)
      .getAllByRole('option')
      .find((option) => option.getAttribute('value')?.startsWith('dorm:')) as HTMLOptionElement;
    expect(option).toBeDefined();
    await user.selectOptions(source, option.value);
    expect(screen.getAllByLabelText('Название столбца').length).toBeGreaterThan(3);
    await user.click(screen.getByRole('button', { name: 'Создать подвкладку' }));
    expect(tableRows('Журнал из общежития')).toHaveLength(0);
    const saved = loadState().tabs.find((tab) => tab.name === 'Журнал из общежития')!;
    expect(saved.columns.every((column) => column.id.includes('-'))).toBe(true);
    expect(
      saved.columns.some((column) => column.kind === 'select' && column.options.length > 0),
    ).toBe(true);
  });

  it('при создании по образцу сохраняет связи таблицы с самой собой и независимые значения', async () => {
    seed('documents', (tab) => {
      tab.tableOptions.period_mode = 'none';
      tab.columns = [
        { ...newColumn(), id: 'amount', name: 'Сумма', kind: 'number' },
        {
          ...newColumn(),
          id: 'total',
          name: 'Общий итог',
          kind: 'number',
          rule: {
            mode: 'link',
            expression: '=',
            refs: {},
            link: {
              sourceId: 'tab:documents',
              operation: 'sum',
              valueField: 'amount',
              sourceRowId: null,
              match: null,
              filters: [],
              dateField: null,
              empty: 'zero',
            },
          },
        },
      ];
      tab.rows = [{ id: 'original', values: { amount: '7' } }];
    });
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: '+ Добавить подвкладку' }));
    fireEvent.change(screen.getByLabelText('Название подвкладки'), {
      target: { value: 'Новый расчёт' },
    });
    await user.click(screen.getByRole('radio', { name: /Своя таблица/ }));
    await user.selectOptions(screen.getByLabelText('Основа таблицы'), 'personnel:documents');
    await user.click(screen.getByRole('button', { name: 'Создать подвкладку' }));
    await screen.findByRole('table', { name: 'Новый расчёт' });
    await user.click(screen.getByRole('button', { name: '+ Добавить запись' }));
    fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: '5' } });
    await user.click(screen.getByRole('button', { name: 'Сохранить запись' }));
    expect(within(tableRows('Новый расчёт')[0]).getAllByText('5')).toHaveLength(2);
    expect(loadState().tabs.find((tab) => tab.id === 'documents')!.rows[0].values.amount).toBe('7');
  });

  it('создаёт вложенные таблицы и сохраняет их независимость при скрытии родителя', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: '+ Добавить подвкладку' }));
    fireEvent.change(screen.getByLabelText('Название подвкладки'), {
      target: { value: 'Кадровые журналы' },
    });
    await user.click(screen.getByRole('radio', { name: /Своя таблица/ }));
    await user.selectOptions(screen.getByLabelText('Основа таблицы'), 'personnel:documents');
    await user.click(screen.getByLabelText('Создать вкладку с подвкладками'));
    fireEvent.change(screen.getByLabelText('Название подвкладки 1'), {
      target: { value: 'Журнал 2026' },
    });
    await user.click(screen.getByRole('button', { name: '+ Ещё подвкладка' }));
    fireEvent.change(screen.getByLabelText('Название подвкладки 2'), {
      target: { value: 'Журнал 2027' },
    });
    await user.click(screen.getByRole('button', { name: 'Создать подвкладку' }));
    const nested = screen.getByRole('tablist', { name: 'Подвкладки: Кадровые журналы' });
    expect(within(nested).getByRole('tab', { name: 'Журнал 2026' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(screen.getByRole('button', { name: '+ Добавить запись' }));
    const record = screen.getByRole('dialog', { name: 'Добавить запись' });
    await user.selectOptions(within(record).getByLabelText('Сотрудник *'), 'employee-0');
    fireEvent.change(within(record).getByLabelText('Документ *'), { target: { value: 'Паспорт' } });
    await user.click(within(record).getByRole('button', { name: 'Сохранить запись' }));
    expect(tableRows('Журнал 2026')).toHaveLength(1);
    await user.click(within(nested).getByRole('tab', { name: 'Журнал 2027' }));
    expect(tableRows('Журнал 2027')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Управление подвкладками' }));
    await user.click(screen.getByRole('button', { name: 'Скрыть подвкладку Кадровые журналы' }));
    expect(
      screen.queryByRole('tablist', { name: 'Подвкладки: Кадровые журналы' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Показать подвкладку Кадровые журналы' }));
    await user.click(screen.getByRole('button', { name: 'Готово' }));
    await user.click(screen.getByRole('tab', { name: 'Кадровые журналы' }));
    await user.click(screen.getByRole('tab', { name: 'Журнал 2026' }));
    expect(tableRows('Журнал 2026')[0]).toHaveTextContent('Паспорт');
    const children = loadState().tabs.filter((tab) => tab.parentId);
    expect(children[0].columns[0].id).not.toBe(children[1].columns[0].id);
  });

  it('копирует только структуру готовой таблицы и отдельно дублирует записи', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: 'Дублировать запись 1' }));
    expect(tableRows('Учёт документов')).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: 'Поднять запись 4' }));
    expect(tableRows('Учёт документов')[2]).toHaveTextContent('Медицинская книжка');
    await user.click(screen.getByRole('button', { name: 'Скопировать структуру' }));
    await user.click(screen.getByRole('button', { name: 'Создать подвкладку' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Учёт документов — копия' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(tableRows('Учёт документов — копия')).toHaveLength(0);
    const state = loadState(),
      source = state.tabs.find((tab) => tab.id === 'documents')!,
      copy = state.tabs.find((tab) => tab.name === 'Учёт документов — копия')!;
    expect(copy.columns[0].id).not.toBe(source.columns[0].id);
    expect(source.rows).toHaveLength(4);
  });
});

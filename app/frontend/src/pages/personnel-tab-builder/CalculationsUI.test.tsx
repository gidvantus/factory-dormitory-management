import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsavedChangesProvider } from '../../components/UnsavedChanges';
import { PersonnelTabBuilder } from './PersonnelTabBuilder';
import { STORAGE_KEY } from './model';
import { downloadCsv } from './csv';

vi.mock('./csv', () => ({ downloadCsv: vi.fn() }));
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
  vi.clearAllMocks();
});
function open(tab = 'demo-payroll') {
  return render(
    <RouterProvider
      router={createMemoryRouter(
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
      )}
    />,
  );
}
const rows = (name: string) =>
  screen.getByRole('table', { name }).querySelectorAll<HTMLTableRowElement>('tbody tr');

describe('Настройка формул и связей в окнах', () => {
  it('собирает формулу кнопками без предварительной установки курсора в поле', async () => {
    const user = userEvent.setup();
    open('demo-daily');
    await user.click(screen.getByRole('button', { name: '+ Добавить расчётную строку' }));
    fireEvent.change(screen.getByLabelText('Название строки'), {
      target: { value: 'Факт плюс план' },
    });
    const dialog = within(screen.getByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Факт' }));
    await user.click(dialog.getByRole('button', { name: '+' }));
    await user.click(dialog.getByRole('button', { name: 'План' }));
    expect(dialog.getByLabelText('Формула')).toHaveValue('=[Факт]+[План]');
    await user.click(dialog.getByRole('button', { name: 'Проверить расчёт' }));
    expect(dialog.getByRole('status')).toHaveTextContent('Результат: 17');
    await user.click(dialog.getByRole('button', { name: 'Сохранить строку' }));
    expect(screen.getByLabelText('Факт плюс план, 2026-11-02')).toHaveTextContent('17');
  });
  it('возвращает исходный тип, обязательность и ручные данные после отключения формулы', async () => {
    const user = userEvent.setup();
    open('documents');
    await user.click(screen.getByRole('button', { name: 'Настроить подвкладку' }));
    let column = within(screen.getByRole('group', { name: 'Столбец 2' }));
    await user.selectOptions(column.getByLabelText('Получение значения'), 'formula');
    fireEvent.change(column.getByLabelText('Формула'), { target: { value: '=5' } });
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(rows('Учёт документов')[0].cells[1]).toHaveTextContent('5');
    await user.click(screen.getByRole('button', { name: 'Настроить подвкладку' }));
    column = within(screen.getByRole('group', { name: 'Столбец 2' }));
    await user.selectOptions(column.getByLabelText('Получение значения'), 'manual');
    expect(column.getByLabelText(/Тип столбца/)).toHaveValue('text');
    expect(column.getByLabelText('Обязательное поле')).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(rows('Учёт документов')[0].cells[1]).toHaveTextContent('Медицинская книжка');
  });
  it('обновляет источник календарной связи после изменения плана заезда', async () => {
    const user = userEvent.setup();
    open('planning');
    await user.click(screen.getByRole('button', { name: 'Изменить заезд' }));
    fireEvent.change(screen.getByLabelText('Количество человек'), { target: { value: '6' } });
    await user.click(screen.getByRole('button', { name: 'Сохранить заезд' }));
    await user.click(screen.getByRole('tab', { name: 'Примеры расчётов' }));
    await user.click(screen.getByRole('tab', { name: 'План и факт' }));
    expect(screen.getByLabelText('Ожидается заезд, 2026-11-02')).toHaveTextContent('6');
  });
  it('изменяет источник, пересчитывает зависимую оплату, исключает расчётные поля из ручного ввода и экспортирует результат', async () => {
    const user = userEvent.setup();
    open('demo-rates');
    await user.click(screen.getByRole('button', { name: 'Изменить запись 1' }));
    fireEvent.change(screen.getByLabelText('Ставка за час *'), { target: { value: '500' } });
    await user.click(screen.getByRole('button', { name: 'Сохранить запись' }));
    await user.click(screen.getByRole('tab', { name: 'Расчёт оплаты' }));
    expect(rows('Расчёт оплаты')[0].cells[4].textContent?.replace(/\s/g, '')).toBe('4500');
    await user.click(screen.getByRole('button', { name: 'Изменить запись 1' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Ставка')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Оплата')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Часы'), { target: { value: '9' } });
    await user.click(screen.getByRole('button', { name: 'Сохранить запись' }));
    expect(rows('Расчёт оплаты')[0].cells[4].textContent?.replace(/\s/g, '')).toBe('5000');
    await user.click(screen.getByRole('button', { name: 'Скачать CSV' }));
    expect(vi.mocked(downloadCsv).mock.calls[0][2][0][4].replace(/\s/g, '')).toBe('5000');
  });
  it('проверяет формулу в окне, сохраняет несколько действий и блокирует неверный синтаксис', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: 'Настроить подвкладку' }));
    const column = within(screen.getByRole('group', { name: 'Столбец 5' }));
    fireEvent.change(column.getByLabelText('Формула'), {
      target: { value: '=([Часы]+2)*[Ставка]-[Доплата]' },
    });
    await user.click(column.getByRole('button', { name: 'Проверить расчёт' }));
    expect(column.getByRole('status')).toHaveTextContent('Результат: 3000');
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(rows('Расчёт оплаты')[0].cells[4].textContent?.replace(/\s/g, '')).toBe('3000');
    await user.click(screen.getByRole('button', { name: 'Настроить подвкладку' }));
    fireEvent.change(
      within(screen.getByRole('group', { name: 'Столбец 5' })).getByLabelText('Формула'),
      { target: { value: '=([Часы]+' } },
    );
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Оплата');
  });
  it('пересчитывает дневную формулу, сохраняет привязку после переименования и защищает используемую строку', async () => {
    const user = userEvent.setup();
    open('demo-daily');
    fireEvent.change(screen.getByLabelText('Факт, 2026-11-02'), { target: { value: '11' } });
    expect(screen.getByLabelText('Отклонение, 2026-11-02')).toHaveTextContent('3');
    expect(screen.getByLabelText('Ожидается заезд, 2026-11-02')).toHaveTextContent('5');
    await user.click(screen.getByRole('button', { name: 'Настроить строку Факт' }));
    fireEvent.change(screen.getByLabelText('Название строки'), { target: { value: 'Факт смены' } });
    await user.click(screen.getByRole('button', { name: 'Сохранить строку' }));
    expect(screen.getByLabelText('Факт смены, 2026-11-02')).toHaveValue('11');
    expect(screen.getByLabelText('Отклонение, 2026-11-02')).toHaveTextContent('3');
    await user.click(screen.getByRole('button', { name: 'Удалить запись 2' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Отклонение');
    expect(rows('План и факт')).toHaveLength(4);
  });
  it('создаёт расчётную строку со связью, агрегацией и фильтром в том же окне', async () => {
    const user = userEvent.setup();
    open('demo-daily');
    await user.click(screen.getByRole('button', { name: '+ Добавить расчётную строку' }));
    fireEvent.change(screen.getByLabelText('Название строки'), {
      target: { value: 'Высокая ставка' },
    });
    await user.selectOptions(screen.getByLabelText('Получение значения'), 'link');
    await user.selectOptions(screen.getByLabelText('Источник данных'), 'tab:demo-rates');
    await user.click(screen.getByRole('button', { name: '+ Добавить условие' }));
    await user.selectOptions(screen.getByLabelText('Поле условия 1'), 'hour-price');
    await user.selectOptions(screen.getByLabelText('Условие 1', { exact: true }), 'from');
    fireEvent.change(screen.getByLabelText('Значение условия 1'), { target: { value: '360' } });
    await user.click(screen.getByRole('button', { name: 'Проверить расчёт' }));
    expect(screen.getByRole('status')).toHaveTextContent('Результат: 400');
    await user.click(screen.getByRole('button', { name: 'Сохранить строку' }));
    expect(screen.getByLabelText('Высокая ставка, 2026-11-02')).toHaveTextContent('400');
    expect(rows('План и факт')[4].querySelectorAll('input')).toHaveLength(0);
  });
  it('защищает столбец и вкладку источника от скрытия и архива при действующих связях', async () => {
    const user = userEvent.setup();
    open('demo-rates');
    await user.click(screen.getByRole('button', { name: 'Настроить подвкладку' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Столбец 2' })).getByRole('button', {
        name: 'Скрыть столбец',
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Расчёт оплаты → Ставка');
    await user.click(screen.getByRole('button', { name: 'Отмена' }));
    await user.click(screen.getByRole('button', { name: 'Управление подвкладками' }));
    await user.click(screen.getByRole('button', { name: 'В архив подвкладку Ставки' }));
    expect(screen.getByRole('alert')).toHaveTextContent('используется в связях');
  });
});

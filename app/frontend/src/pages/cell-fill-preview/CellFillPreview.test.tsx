import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CellFillPreview } from './CellFillPreview';

function open(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <CellFillPreview />
    </MemoryRouter>,
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('Тестовая страница заполнения ячеек', () => {
  it('позволяет проверить живую связь, копию и смену человека без запросов к API', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    open();
    expect(screen.getByLabelText('Дата заселения, строка 1')).toHaveTextContent('14.09.2026');
    await user.click(screen.getByRole('button', { name: /Таблица-источник Измените данные/ }));
    const sourceDate = screen.getByLabelText('Дата заселения, Иванов Алексей Сергеевич, Т/н 1042');
    fireEvent.change(sourceDate, { target: { value: '2026-09-20' } });
    expect(screen.getByLabelText('Дата заселения, строка 1')).toHaveTextContent('20.09.2026');
    await user.click(screen.getByRole('radio', { name: /Скопировать один раз/ }));
    fireEvent.change(sourceDate, { target: { value: '2026-09-25' } });
    expect(screen.getByLabelText('Дата заселения, строка 1')).toHaveTextContent('20.09.2026');
    await user.selectOptions(screen.getByLabelText('ФИО, строка 1'), 'resident-4');
    expect(screen.getByLabelText('Дата заселения, строка 1')).toHaveTextContent('27.10.2026');
    await user.selectOptions(screen.getByLabelText('ФИО, строка 1'), '');
    expect(screen.getByLabelText('Дата заселения, строка 1')).toHaveTextContent(
      'Выберите человека',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('добавляет ручной столбец, строки, применяет настройки и снова открывает их', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: '+ Добавить столбец' }));
    await user.clear(screen.getByLabelText('Название столбца'));
    await user.type(screen.getByLabelText('Название столбца'), 'Комментарий');
    await user.type(screen.getByLabelText('Комментарий, строка 1'), 'Билет куплен');
    await user.click(screen.getByRole('button', { name: '+ Добавить строку' }));
    expect(screen.getByLabelText('ФИО, строка 3')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Применить настройки' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Комментарий, строка 1')).toHaveValue('Билет куплен');
    await user.click(screen.getByRole('button', { name: 'Настроить подвкладку' }));
    expect(screen.getByLabelText('Название столбца')).toHaveValue('Комментарий');
    await user.click(screen.getByRole('button', { name: 'Сбросить пример' }));
    expect(within(screen.getByRole('table', { name: 'Отпуск' })).getAllByRole('row')).toHaveLength(
      3,
    );
    expect(screen.queryByLabelText('Комментарий, строка 1')).not.toBeInTheDocument();
  });

  it('запрещает применение неполной связи и удаление используемого столбца', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: /ФИО Выбор записи/ }));
    expect(screen.getByRole('button', { name: 'Убрать столбец из примера' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Дата заселения Из другой таблицы/ }));
    await user.selectOptions(
      screen.getByLabelText('Таблица-источник', { exact: true }),
      'employees',
    );
    expect(screen.getByRole('button', { name: 'Применить настройки' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('из этой же таблицы');
    await user.click(screen.getByRole('button', { name: /ФИО Выбор записи/ }));
    await user.selectOptions(
      screen.getByLabelText('Таблица-источник', { exact: true }),
      'employees',
    );
    await user.click(screen.getByRole('button', { name: /Дата заселения/ }));
    await user.selectOptions(screen.getByLabelText('Человека выбрать в столбце'), 'person');
    expect(screen.getByRole('button', { name: 'Применить настройки' })).toBeEnabled();
    expect(screen.getByLabelText('Дата заселения, строка 1')).toHaveTextContent(
      'Выберите человека',
    );
    await user.selectOptions(screen.getByLabelText('ФИО, строка 1'), 'employee-2');
    expect(screen.getByLabelText('Дата заселения, строка 1')).toHaveTextContent('02.10.2026');
  });
});

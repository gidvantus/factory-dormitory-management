import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ConstructorWindows } from './ConstructorWindows';

function open(query = '?window=formula'): void {
  render(
    <MemoryRouter initialEntries={[`/preview/constructors-windows-live${query}`]}>
      <Routes>
        <Route
          path="/preview/constructors-windows-live/*"
          element={<ConstructorWindows liveResult />}
        />
      </Routes>
    </MemoryRouter>,
  );
}
describe('Настройки и живой результат внутри окна', () => {
  it('сразу показывает результат сложной формулы и пересчитывает его до сохранения', async () => {
    const user = userEvent.setup();
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Настроить строку' });
    expect(
      within(dialog).getByRole('region', { name: 'Настройки конструктора' }),
    ).toBeInTheDocument();
    const result = within(dialog).getByRole('complementary', {
      name: 'Живой результат конструктора',
    });
    await waitFor(() => expect(within(result).getAllByText('109')).not.toHaveLength(0));
    expect(within(dialog).queryByText('Проверить результат на примере')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Формула'), {
      target: { value: '=([Проживает М]+[Проживает Ж])*2+[Прибыло]-[Выбыло]' },
    });
    await waitFor(() => expect(within(result).getByText('217')).toBeInTheDocument());
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('✓ Строка отчёта сохранена.')).toBeInTheDocument();
  });
  it('показывает ошибку расчёта в результате и позволяет исправить выражение', async () => {
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Настроить строку' });
    const formula = within(dialog).getByLabelText('Формула');
    const result = within(dialog).getByRole('complementary', {
      name: 'Живой результат конструктора',
    });
    fireEvent.change(formula, { target: { value: '=1/0' } });
    await waitFor(() => expect(result).toHaveTextContent(/Деление на ноль/));
    fireEvent.change(formula, { target: { value: '=([Проживает М]+[Проживает Ж])/2' } });
    await waitFor(() => expect(within(result).getByText('54')).toBeInTheDocument());
  });
  it('обновляет ячейки нового столбца одновременно с его настройками', async () => {
    const user = userEvent.setup();
    open('?section=table');
    await user.click(await screen.findByRole('button', { name: '+ Добавить столбец' }));
    const dialog = await screen.findByRole('dialog', { name: 'Добавить столбец' });
    const result = within(dialog).getByRole('complementary', {
      name: 'Живой результат конструктора',
    });
    fireEvent.change(within(dialog).getByLabelText('Название столбца'), {
      target: { value: 'Комплект формы' },
    });
    await user.selectOptions(within(dialog).getByLabelText('Тип столбца'), 'select');
    fireEvent.change(within(dialog).getByLabelText('Вариант 1'), { target: { value: 'Зимний' } });
    await waitFor(() =>
      expect(
        within(result).getByRole('columnheader', { name: /Комплект формы/ }),
      ).toBeInTheDocument(),
    );
    expect(within(result).getAllByText('Зимний')).toHaveLength(3);
  });
  it('показывает несохранённые названия столбцов структуры в соседней части окна', async () => {
    open('?window=structure');
    const dialog = await screen.findByRole('dialog', { name: 'Настройки общежития' });
    fireEvent.change(await within(dialog).findByLabelText('Название столбца 1'), {
      target: { value: 'Имя сотрудника' },
    });
    const result = within(dialog).getByRole('complementary', {
      name: 'Живой результат конструктора',
    });
    await waitFor(() =>
      expect(
        within(result).getByRole('columnheader', { name: /Имя сотрудника/ }),
      ).toBeInTheDocument(),
    );
  });
  it('показывает текущий черновик блока персонала, включая поля формы', async () => {
    const user = userEvent.setup();
    open('?section=personnel');
    await user.click(await screen.findByRole('button', { name: 'Добавить блок' }));
    const dialog = await screen.findByRole('dialog', { name: 'Добавить блок' });
    fireEvent.change(within(dialog).getByLabelText('Название'), {
      target: { value: 'Новый блок проживания' },
    });
    const result = within(dialog).getByRole('complementary', {
      name: 'Живой результат конструктора',
    });
    await waitFor(() => expect(result).toHaveTextContent('Новый блок проживания'));
  });
});

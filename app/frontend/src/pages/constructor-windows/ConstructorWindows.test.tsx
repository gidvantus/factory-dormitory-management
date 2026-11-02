import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConstructorWindows } from './ConstructorWindows';

function open(query = ''): void {
  render(
    <MemoryRouter initialEntries={[`/preview/constructors-windows${query}`]}>
      <Routes>
        <Route path="/preview/constructors-windows/*" element={<ConstructorWindows />} />
      </Routes>
    </MemoryRouter>,
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('Конструкторы в отдельных окнах', () => {
  it.each([
    ['formula', 'Настроить строку'],
    ['links', 'Добавить строку'],
    ['places', 'Добавить строку'],
    ['structure', 'Настройки общежития'],
    ['structure-templates', 'Настройки общежития'],
    ['create-dormitory', 'Создать общежитие'],
    ['create-tab', 'Добавить вкладку'],
    ['tabs', 'Управление вкладками'],
    ['create-table', 'Создать таблицу'],
    ['report-templates', 'Шаблоны отчётов'],
    ['binding', 'Связь таблицы с персоналом'],
    ['arrival-fields', 'Настройки плана заездов'],
    ['arrival-display', 'Настройки плана заездов'],
  ])('%s: открывает полный отдельный диалог без сетевых запросов', async (kind, name) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    open(`?window=${kind}`);
    expect(await screen.findByRole('dialog', { name })).toHaveAttribute('aria-modal', 'true');
    expect(
      screen.queryByRole('complementary', { name: 'Живой результат настроек' }),
    ).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('открывает окно поверх отчёта, сохраняет сложную формулу и возвращает в отчёт', async () => {
    const user = userEvent.setup();
    open();
    const trigger = await screen.findByRole('button', { name: 'Настроить формулу' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Настроить строку' });
    const formula = '=([Проживает М]+[Проживает Ж])*2+[Прибыло]-[Выбыло]';
    fireEvent.change(within(dialog).getByLabelText('Формула'), { target: { value: formula } });
    const preview = within(dialog).getByText('Проверить результат на примере');
    expect(preview.closest('details')).not.toHaveAttribute('open');
    await user.click(preview);
    await waitFor(() => expect(within(dialog).getByText('217')).toBeVisible());
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('✓ Строка отчёта сохранена.')).toBeInTheDocument();
    await user.click(trigger);
    expect(await screen.findByLabelText('Формула')).toHaveValue(formula);
  });
  it('сохраняет два раздела заездов в одном окне и возвращает к карточке', async () => {
    const user = userEvent.setup();
    open('?section=arrivals');
    await user.click(await screen.findByRole('button', { name: 'Поля формы' }));
    const dialog = await screen.findByRole('dialog', { name: 'Настройки плана заездов' });
    await user.click(within(dialog).getByRole('button', { name: 'Добавить поле' }));
    expect(within(within(dialog).getByLabelText('Тип поля')).getAllByRole('option')).toHaveLength(
      7,
    );
    fireEvent.change(within(dialog).getByLabelText('Название поля'), {
      target: { value: 'Встречающий' },
    });
    await user.click(within(dialog).getByRole('tab', { name: 'Правая панель' }));
    await user.click(within(dialog).getByLabelText('Компактные карточки'));
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить настройки' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Поля формы и правая панель сохранены',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Правая панель' }));
    expect(await screen.findByLabelText('Компактные карточки')).toBeChecked();
  });
  it('показывает пример текущего столбца внутри его отдельного окна', async () => {
    const user = userEvent.setup();
    open('?section=table');
    await user.click(await screen.findByRole('button', { name: '+ Добавить столбец' }));
    const dialog = await screen.findByRole('dialog', { name: 'Добавить столбец' });
    fireEvent.change(within(dialog).getByLabelText('Название столбца'), {
      target: { value: 'Новый показатель' },
    });
    await user.click(within(dialog).getByText('Посмотреть пример ячеек'));
    expect(within(dialog).getByRole('columnheader', { name: /Новый показатель/ })).toBeVisible();
    expect(within(dialog).queryByText('Общий отчёт после сохранения')).not.toBeInTheDocument();
  });
  it('открывает редактор статистики отдельным окном с исходными настройками', async () => {
    const user = userEvent.setup();
    open('/statistics');
    await user.click(await screen.findByRole('link', { name: /Управленческий отчёт/ }));
    await user.click(
      await screen.findByRole('button', {
        name: /Настроить блок|Изменить блок|Редактировать блок/,
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Настроить блок статистики' });
    expect(within(dialog).getByLabelText('Общежитие для образца')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Откуда брать данные')).toHaveTextContent('План заездов');
  });
});

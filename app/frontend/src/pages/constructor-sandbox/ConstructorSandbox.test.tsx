import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConstructorSandbox } from './ConstructorSandbox';
import { inventory } from './inventory';

function open(scene = 'formula', suffix = ''): void {
  render(
    <MemoryRouter initialEntries={[`/preview/constructors-project?builder=${scene}${suffix}`]}>
      <Routes>
        <Route path="/preview/constructors-project/*" element={<ConstructorSandbox />} />
      </Routes>
    </MemoryRouter>,
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Исходные конструкторы проекта в варианте №2', () => {
  it.each(inventory)('$id: полный конструктор загружается локально', async (entry) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    open(entry.id);
    await waitFor(() =>
      expect(
        screen.getByRole('region', { name: 'Полный конструктор проекта' }),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.queryByText(/Не выполнено в стенде:/)).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { level: 1, name: entry.title })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('позволяет записать формулу из нескольких действий и скобок и сохранить её', async () => {
    const user = userEvent.setup();
    open();
    const input = await screen.findByLabelText('Формула');
    const formula = '=([Проживает М]+[Проживает Ж])*2+[Прибыло]-[Выбыло]';
    fireEvent.change(input, { target: { value: formula } });
    const preview = screen.getByRole('complementary', { name: 'Живой результат настроек' });
    await waitFor(() => expect(within(preview).getByText('217')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findAllByText('Строка отчёта сохранена.')).not.toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Открыть конструктор снова' }));
    expect(await screen.findByLabelText('Формула')).toHaveValue(formula);
    expect(screen.queryByLabelText('Первая строка')).not.toBeInTheDocument();
  });
  it('показывает черновик структуры рядом с исходным редактором', async () => {
    open('structure');
    const input = await screen.findByLabelText('Название столбца 1');
    fireEvent.change(input, { target: { value: 'Полное имя сотрудника' } });
    const preview = screen.getByRole('complementary', { name: 'Живой результат настроек' });
    await waitFor(() =>
      expect(
        within(preview).getByRole('columnheader', { name: /Полное имя сотрудника/ }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Сохранить изменения' })).toBeEnabled();
  });

  it('сохраняет оба раздела плана заездов и все семь типов полей', async () => {
    const user = userEvent.setup();
    open('arrival-fields');
    const fieldsTab = await screen.findByRole('tab', { name: 'Поля формы' });
    expect(fieldsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Правая панель' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Добавить поле' }));
    const type = screen.getByLabelText('Тип поля');
    expect(within(type).getAllByRole('option')).toHaveLength(7);
    fireEvent.change(screen.getByLabelText('Название поля'), {
      target: { value: 'Способ прибытия' },
    });
    await user.selectOptions(type, 'select');
    fireEvent.change(screen.getByLabelText(/^Варианты списка/), {
      target: { value: 'Автобус\nСамостоятельно\nПоезд' },
    });
    await user.selectOptions(screen.getByLabelText(/^Где заполнять/), 'person');
    await user.click(screen.getByRole('tab', { name: 'Правая панель' }));
    expect(screen.getByLabelText('Показывать итог за день')).toBeChecked();
    await user.click(screen.getByLabelText('Компактные карточки'));
    await user.selectOptions(screen.getByLabelText('Людей в карточке'), '10000');
    expect(screen.getAllByText('Способ прибытия')).not.toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    expect(
      await screen.findAllByText('Оба раздела настроек плана заездов сохранены.'),
    ).not.toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Открыть конструктор снова' }));
    await user.click(screen.getByRole('tab', { name: 'Правая панель' }));
    expect(screen.getByLabelText('Компактные карточки')).toBeChecked();
    expect(screen.getByLabelText('Людей в карточке')).toHaveValue('10000');
    expect(screen.queryByText(/Не выполнено в стенде:/)).not.toBeInTheDocument();
  });

  it('создаёт новую связанную строку по размещению со всеми показателями', async () => {
    const user = userEvent.setup();
    open('places');
    const name = await screen.findByLabelText('Название строки');
    fireEvent.change(name, { target: { value: 'Места для женщин' } });
    const metric = await screen.findByLabelText('Показатель');
    expect(within(metric).getAllByRole('option')).toHaveLength(10);
    await user.selectOptions(metric, 'free_f');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findAllByText('Строка отчёта сохранена.')).not.toHaveLength(0);
    expect(
      screen.getByRole('complementary', { name: 'Живой результат настроек' }),
    ).toHaveTextContent('Места для женщин');
  });

  it('создаёт столбец через исходную форму и сохраняет все варианты списка', async () => {
    const user = userEvent.setup();
    open('columns');
    await user.click(await screen.findByRole('button', { name: '+ Добавить столбец' }));
    fireEvent.change(screen.getByLabelText('Название столбца'), {
      target: { value: 'Выданный комплект' },
    });
    await user.selectOptions(screen.getByLabelText('Тип столбца'), 'select');
    fireEvent.change(screen.getByLabelText('Вариант 1'), { target: { value: 'Летний' } });
    await user.click(screen.getByRole('button', { name: '+ Вариант' }));
    fireEvent.change(screen.getByLabelText('Вариант 2'), { target: { value: 'Зимний' } });
    await user.click(screen.getByRole('button', { name: 'Сохранить столбец' }));
    await waitFor(() =>
      expect(
        screen.getByRole('complementary', { name: 'Живой результат настроек' }),
      ).toHaveTextContent('Выданный комплект'),
    );
    expect(screen.queryByText(/Не выполнено в стенде:/)).not.toBeInTheDocument();
  });

  it('предлагает до десяти условий по стандартным и пользовательским столбцам', async () => {
    const user = userEvent.setup();
    open('personnel-lists');
    await user.click(await screen.findByRole('button', { name: '+ Добавить фильтр' }));
    const field = screen.getByLabelText('Столбец фильтра 1');
    expect(
      within(field).getByRole('group', { name: 'Столбцы таблиц общежитий' }),
    ).toBeInTheDocument();
    await user.selectOptions(field, 'phone');
    await user.selectOptions(screen.getByLabelText('Условие фильтра 1'), 'empty');
    expect(
      screen.getByRole('complementary', { name: 'Живой результат настроек' }),
    ).toHaveTextContent('Найдено сотрудников: 1');
    for (let index = 1; index < 10; index++)
      await user.click(screen.getByRole('button', { name: '+ Добавить фильтр' }));
    expect(screen.getByRole('button', { name: '+ Добавить фильтр' })).toBeDisabled();
    expect(screen.getByLabelText('Столбец фильтра 10')).toBeInTheDocument();
  });

  it('показывает полный каталог источников и редактор статистики', async () => {
    const user = userEvent.setup();
    open('statistics');
    await user.click(await screen.findByRole('link', { name: /Управленческий отчёт/ }));
    await user.click(
      await screen.findByRole('button', {
        name: /Настроить блок|Редактировать блок|Изменить блок/,
      }),
    );
    expect(await screen.findByLabelText('Общежитие для образца')).toBeInTheDocument();
    expect(screen.getByLabelText('Откуда брать данные')).toHaveTextContent('Общий отчёт');
    expect(screen.getByLabelText('Откуда брать данные')).toHaveTextContent('Размещение персонала');
    expect(screen.getByLabelText('Откуда брать данные')).toHaveTextContent('План заездов');
    expect(screen.queryByText(/Не выполнено в стенде:/)).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { ConstructorWindows } from './ConstructorWindows';

function open(query = ''): void {
  render(
    <MemoryRouter initialEntries={[`/preview/constructors-organized${query}`]}>
      <Routes>
        <Route
          path="/preview/constructors-organized/*"
          element={<ConstructorWindows organizationDemo />}
        />
      </Routes>
    </MemoryRouter>,
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Организация существующих конструкторов', () => {
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
  ])('%s: остаётся отдельным рабочим окном без запросов в базу', async (kind, name) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    open(`?window=${kind}`);
    expect(await screen.findByRole('dialog', { name })).toHaveAttribute('aria-modal', 'true');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('сравнивает исходную и новую организацию на одной форме без потери сохранённых данных', async () => {
    const user = userEvent.setup();
    open('?window=formula');
    const dialog = await screen.findByRole('dialog', { name: 'Настроить строку' });
    expect(within(dialog).getByLabelText('Формула').tagName).toBe('TEXTAREA');
    const renamed = 'Расчёт потребности';
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Название строки' }), {
      target: { value: renamed },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Сейчас в проекте' }));
    await user.click(screen.getByRole('button', { name: 'Настроить формулу' }));
    const before = await screen.findByRole('dialog', { name: 'Настроить строку' });
    expect(within(before).getByRole('textbox', { name: 'Название строки' })).toHaveValue(renamed);
    expect(within(before).getByLabelText('Формула').tagName).toBe('INPUT');
    expect(
      within(before).queryByRole('navigation', { name: 'Разделы конструктора' }),
    ).not.toBeInTheDocument();
    await user.click(within(before).getByRole('button', { name: 'Отмена' }));
    await user.click(screen.getByRole('button', { name: 'Предлагаемая организация' }));
    await user.click(screen.getByRole('button', { name: 'Настроить формулу' }));
    const after = await screen.findByRole('dialog', { name: 'Настроить строку' });
    expect(within(after).getByRole('textbox', { name: 'Название строки' })).toHaveValue(renamed);
    expect(
      await within(after).findByRole('navigation', { name: 'Разделы конструктора' }),
    ).toBeInTheDocument();
  });

  it('вставляет ссылку вместо выделения, сохраняет сложное выражение и отделяет удаление', async () => {
    const user = userEvent.setup();
    open('?window=formula');
    const dialog = await screen.findByRole('dialog', { name: 'Настроить строку' });
    const input = within(dialog).getByLabelText('Формула') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '=(0+2)*3-[Выбыло]' } });
    input.focus();
    input.setSelectionRange(2, 3);
    await user.click(within(dialog).getByRole('button', { name: 'Проживает М' }));
    expect(input).toHaveValue('=([Проживает М]+2)*3-[Выбыло]');
    fireEvent.change(within(dialog).getByLabelText('Найти строку отчёта'), {
      target: { value: 'Проживает Ж' },
    });
    expect(within(dialog).queryByRole('button', { name: 'Проживает М' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Проживает Ж' })).toBeInTheDocument();
    const deletion = within(dialog).getByRole('region', { name: 'Удаление строки' });
    expect(within(deletion).getByRole('button', { name: 'Удалить строку' })).toBeInTheDocument();
    expect(within(deletion).queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument();
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const nav = await within(dialog).findByRole('navigation', { name: 'Разделы конструктора' });
    await user.click(within(nav).getByRole('button', { name: /Выражение/ }));
    expect(scroll).toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Настроить формулу' }));
    expect(await screen.findByLabelText('Формула')).toHaveValue('=([Проживает М]+2)*3-[Выбыло]');
  });

  it('перестраивает оглавление по способу заполнения, сохраняя черновик формулы', async () => {
    const user = userEvent.setup();
    open('?window=formula');
    const dialog = await screen.findByRole('dialog', { name: 'Настроить строку' });
    const original = (within(dialog).getByLabelText('Формула') as HTMLTextAreaElement).value;
    await user.click(within(dialog).getByRole('radio', { name: /Связь с таблицей/ }));
    expect(
      await within(dialog).findByRole('region', { name: 'Источник записей' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('region', { name: 'Какие записи учитывать' }),
    ).not.toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Раздел'), 'residents');
    const column = await within(dialog).findByLabelText('Столбец');
    expect(
      within(dialog).getByRole('region', { name: 'Какие записи учитывать' }),
    ).toBeInTheDocument();
    const choice = within(column).getAllByRole('option')[1] as HTMLOptionElement;
    await user.selectOptions(column, choice.value);
    expect(
      within(dialog).getByRole('region', { name: 'По какой дате считать' }),
    ).toBeInTheDocument();
    const nav = within(dialog).getByRole('navigation', { name: 'Разделы конструктора' });
    expect(within(nav).queryByRole('button', { name: /Выражение/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: /Формулой для всех дней/ }));
    expect(within(dialog).getByLabelText('Формула')).toHaveValue(original);
    await user.click(within(dialog).getByRole('radio', { name: /Вручную по дням/ }));
    expect(within(dialog).queryByLabelText('Формула')).not.toBeInTheDocument();
  });

  it('сохраняет оба раздела заездов и все семь типов поля', async () => {
    const user = userEvent.setup();
    open('?section=arrivals&window=arrival-fields');
    const dialog = await screen.findByRole('dialog', { name: 'Настройки плана заездов' });
    expect(within(dialog).getAllByRole('tab')).toHaveLength(2);
    await user.click(within(dialog).getByRole('button', { name: 'Добавить поле' }));
    expect(within(within(dialog).getByLabelText('Тип поля')).getAllByRole('option')).toHaveLength(
      7,
    );
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Название поля' }), {
      target: { value: 'Встречающий' },
    });
    await user.click(within(dialog).getByRole('tab', { name: 'Правая панель' }));
    expect(
      within(dialog).getByRole('region', { name: 'Содержание и порядок' }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText('Компактные карточки'));
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Поля формы' }));
    expect(await screen.findByText('Встречающий', { selector: 'strong' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Правая панель' }));
    expect(screen.getByLabelText('Компактные карточки')).toBeChecked();
  });

  it('группирует все шесть привязок персонала с прежними ограничениями типов', async () => {
    open('?window=binding');
    const dialog = await screen.findByRole('dialog', { name: 'Связь таблицы с персоналом' });
    const dates = await within(dialog).findByRole('region', { name: 'Даты вахты' });
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(6);
    expect(within(dates).getAllByRole('combobox')).toHaveLength(2);
    expect(within(dates).getByLabelText('Начало вахты')).toHaveTextContent('Начало вахты');
    expect(within(dates).getByLabelText('Начало вахты')).not.toHaveTextContent('ФИО');
    expect(within(dialog).getByRole('button', { name: 'Сохранить связь' })).toBeEnabled();
  });

  it('меняет порядок настоящих столбцов в запросе создания таблицы', async () => {
    const user = userEvent.setup();
    open('?section=table&window=create-table');
    const dialog = await screen.findByRole('dialog', { name: 'Создать таблицу' });
    const save = vi.spyOn(api, 'createCustomTabTable');
    fireEvent.change(within(dialog).getByLabelText('Название столбца'), {
      target: { value: 'ФИО' },
    });
    await user.click(within(dialog).getByRole('button', { name: '+ Добавить столбец' }));
    fireEvent.change(within(dialog).getAllByLabelText('Название столбца')[1], {
      target: { value: 'Смены' },
    });
    await user.selectOptions(within(dialog).getAllByLabelText('Тип столбца')[1], 'number');
    await user.click(within(dialog).getByRole('button', { name: 'Поднять столбец 2' }));
    expect(
      within(dialog)
        .getAllByLabelText('Название столбца')
        .map((el) => (el as HTMLInputElement).value),
    ).toEqual(['Смены', 'ФИО']);
    await user.click(within(dialog).getByRole('button', { name: 'Создать таблицу' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(save.mock.calls[0][2].map((col) => [col.name, col.kind])).toEqual([
      ['Смены', 'number'],
      ['ФИО', 'text'],
    ]);
  });

  it('ставит источник и расчёт дашборда перед отображением, сохраняя все виды источников', async () => {
    const user = userEvent.setup();
    open('?section=dashboard');
    await user.click(await screen.findByRole('button', { name: '+ Добавить блок' }));
    const dialog = await screen.findByRole('dialog', { name: 'Добавить блок статистики' });
    expect(
      within(dialog)
        .getAllByRole('heading', { level: 3 })
        .map((el) => el.textContent)
        .filter((text) => text !== 'Предпросмотр'),
    ).toEqual([
      'Название блока',
      'Данные и расчёт',
      'Общежития и источники',
      'Отображение',
      'Проверка расчёта',
    ]);
    expect(
      within(within(dialog).getByLabelText('Источник данных')).getAllByRole('option'),
    ).toHaveLength(4);
    await user.selectOptions(within(dialog).getByLabelText('Источник данных'), 'table');
    expect(within(dialog).getByLabelText('Что считать')).toHaveTextContent('Количество строк');
    expect(within(dialog).getByLabelText('Что считать')).toHaveTextContent(
      'Сумма числового столбца',
    );
    expect(
      within(within(dialog).getByRole('region', { name: 'Проверка расчёта' })).getByRole('button', {
        name: 'Проверить расчёт',
      }),
    ).toBeInTheDocument();
  });
});

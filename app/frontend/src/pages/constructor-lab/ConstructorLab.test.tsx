import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ConstructorLab } from './ConstructorLab';
import {
  aggregate,
  applyPreset,
  builders,
  chartData,
  formulaData,
  validate,
  variants,
} from './model';

function open(builder = 'statistics', variant = 'split'): void {
  render(
    <MemoryRouter initialEntries={[`/preview/constructors?builder=${builder}&variant=${variant}`]}>
      <ConstructorLab />
    </MemoryRouter>,
  );
}
function chooseVariant(name: string): void {
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Варианты интерфейса' })).getByRole('button', {
      name: new RegExp(name),
    }),
  );
}
function chooseBuilder(name: string): void {
  fireEvent.click(
    within(screen.getByRole('complementary', { name: 'Конструкторы проекта' })).getByRole(
      'button',
      { name },
    ),
  );
}

describe('Пять вариантов для всех конструкторов', () => {
  it.each(builders.flatMap((builder) => variants.map((variant) => ({ builder, variant }))))(
    '$builder.id / $variant.id: доступен результат и применение',
    ({ builder, variant }) => {
      open(builder.id, variant.id);
      expect(screen.getByRole('heading', { name: builder.name, level: 2 })).toBeInTheDocument();
      if (variant.id === 'steps')
        fireEvent.click(screen.getByRole('button', { name: /Проверка результата/ }));
      expect(screen.getByRole('region', { name: 'Предпросмотр результата' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Применить в примере' })).toBeEnabled();
    },
  );

  it('сохраняет независимые черновики при смене подхода и конструктора', () => {
    open();
    fireEvent.change(screen.getByLabelText('Название', { exact: true }), {
      target: { value: 'Мой отчёт' },
    });
    chooseVariant('Собрать как фразу');
    expect(screen.getByLabelText('Название', { exact: true })).toHaveValue('Мой отчёт');
    chooseBuilder('Столбцы');
    fireEvent.change(screen.getByLabelText('Название', { exact: true }), {
      target: { value: 'Моя таблица' },
    });
    chooseBuilder('Статистика');
    expect(screen.getByLabelText('Название', { exact: true })).toHaveValue('Мой отчёт');
    chooseBuilder('Столбцы');
    expect(screen.getByLabelText('Название', { exact: true })).toHaveValue('Моя таблица');
  });

  it('проводит через мастер и разрешает применение только после проверки', async () => {
    const user = userEvent.setup();
    open('arrivals', 'steps');
    expect(screen.getByRole('button', { name: 'Применить в примере' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Настроить содержимое' }));
    await user.selectOptions(screen.getByLabelText('Кто заполняет значение'), 'Одно на весь заезд');
    await user.click(screen.getByRole('button', { name: 'Посмотреть результат' }));
    expect(screen.getByRole('region', { name: 'Предпросмотр результата' })).toHaveTextContent(
      'одно на весь заезд',
    );
    await user.click(screen.getByRole('button', { name: 'Применить в примере' }));
    expect(screen.getByText('Применено в примере')).toBeInTheDocument();
    expect(screen.getByText(/хранятся до перезагрузки/)).toBeInTheDocument();
  });

  it('применяет шаблон, меняет график и отменяет применение шаблона', async () => {
    const user = userEvent.setup();
    open('statistics', 'templates');
    await user.click(screen.getByRole('button', { name: /Заезды за неделю Сумма заездов/ }));
    expect(screen.getByLabelText('Что считать')).toHaveValue('План заездов');
    expect(screen.getByLabelText('Как показывать')).toHaveValue('Таблица');
    expect(screen.getByRole('region', { name: 'Предпросмотр результата' })).toHaveTextContent('28');
    await user.click(screen.getByRole('button', { name: 'Отменить последнее изменение' }));
    expect(screen.getByLabelText('Что считать')).toHaveValue('Проживающие');
    expect(screen.getByLabelText('Как показывать')).toHaveValue('Столбцы');
  });

  it('переставляет и скрывает столбцы, сохраняет скрытый элемент и проверяет дубли', async () => {
    const user = userEvent.setup();
    open('columns');
    await user.click(screen.getByRole('button', { name: 'Поднять «Телефон»' }));
    const preview = within(screen.getByRole('region', { name: 'Предпросмотр результата' }));
    expect(preview.getAllByRole('columnheader')[1]).toHaveTextContent('Телефон');
    await user.click(screen.getByRole('checkbox', { name: 'Показывать «Телефон»' }));
    expect(preview.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getByLabelText('Название элемента 2')).toHaveValue('Телефон');
    fireEvent.change(screen.getByLabelText('Название элемента 3'), { target: { value: ' ФИО ' } });
    expect(
      screen.getByText('Названия видимых элементов не должны повторяться.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Применить в примере' })).toBeDisabled();
  });

  it('объясняет отбор связанных записей и учитывает отсутствие даты события', async () => {
    const user = userEvent.setup();
    open('link');
    const preview = screen.getByRole('region', { name: 'Предпросмотр результата' });
    expect(preview).toHaveTextContent('Нет даты события');
    expect(within(preview).getAllByText('+1')).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText('Распределять по дате'), 'Дате создания записи');
    expect(within(preview).getAllByText('+1')).toHaveLength(2);
    await user.selectOptions(screen.getByLabelText('Условие для статуса'), 'Статус заполнен');
    expect(screen.queryByLabelText('Какой статус')).not.toBeInTheDocument();
    expect(within(preview).getAllByText('+1')).toHaveLength(3);
  });

  it('открывает инспектор выбранной части результата и сразу меняет вид', async () => {
    const user = userEvent.setup();
    open('statistics', 'canvas');
    await user.click(screen.getByRole('button', { name: 'Настроить вид и поведение' }));
    await user.selectOptions(screen.getByLabelText('Как показывать'), 'Число');
    expect(screen.getByRole('region', { name: 'Предпросмотр результата' })).toHaveTextContent(
      '284',
    );
    await user.click(screen.getByRole('button', { name: /Проживающие по общежитиям Название/ }));
    fireEvent.change(screen.getByLabelText('Название', { exact: true }), {
      target: { value: 'Новый заголовок' },
    });
    expect(screen.getByRole('heading', { name: 'Новый заголовок' })).toBeInTheDocument();
  });

  it('блокирует деление на ноль с понятным объяснением', async () => {
    const user = userEvent.setup();
    open('formula');
    await user.selectOptions(screen.getByLabelText('Действие'), 'Разделить');
    await user.selectOptions(screen.getByLabelText('Вторая строка'), 'Выбыло');
    expect(screen.getByRole('button', { name: 'Применить в примере' })).toBeDisabled();
    expect(screen.getByText(/В примере получается деление на ноль/)).toBeInTheDocument();
  });

  it('меняет выборку, число строк и ширину блока персонала', async () => {
    const user = userEvent.setup();
    open('workspace', 'canvas');
    const preview = screen.getByRole('region', { name: 'Предпросмотр результата' });
    expect(preview).toHaveTextContent('Показано 3 из 3');
    await user.selectOptions(screen.getByLabelText('На сколько дней вперёд'), '3');
    expect(preview).toHaveTextContent('Показано 1 из 1');
    await user.click(screen.getByRole('button', { name: 'Настроить вид и поведение' }));
    await user.click(screen.getByLabelText('Блок на всю ширину'));
    expect(within(preview).queryByText('Соседний блок')).not.toBeInTheDocument();
    expect(preview).toHaveTextContent('На всю ширину.');
  });

  it('пересчитывает свой список по всем выбранным условиям', async () => {
    const user = userEvent.setup();
    open('filters');
    const preview = screen.getByRole('region', { name: 'Предпросмотр результата' });
    expect(preview).toHaveTextContent('Петрова Анна');
    expect(preview).not.toHaveTextContent('Морозов Павел');
    await user.selectOptions(screen.getByLabelText('Условие', { exact: true }), 'Равно');
    expect(preview).toHaveTextContent('Никто не подходит под все условия.');
    await user.selectOptions(screen.getByLabelText('Проверить поле'), 'Общежитие');
    expect(preview).toHaveTextContent('Найдено: 2');
    await user.selectOptions(screen.getByLabelText('Кого искать'), 'Все сотрудники');
    expect(preview).toHaveTextContent('Найдено: 3');
    expect(preview).toHaveTextContent('Морозов Павел');
  });
});

describe('Расчёты и примеры', () => {
  it('все исходные примеры и шаблоны можно применить', () => {
    for (const builder of builders) {
      expect(validate(builder, builder.initial), builder.name).toEqual([]);
      for (const preset of builder.presets)
        expect(validate(builder, applyPreset(builder.initial, preset)), preset.name).toEqual([]);
    }
  });
  it('различает срез, сумму, среднее и максимум', () => {
    expect(aggregate([10, 20, 15], 'Последнее значение')).toBe(15);
    expect(aggregate([10, 20, 15], 'Сумма за период')).toBe(45);
    expect(aggregate([10, 20, 15], 'Среднее за день')).toBe(15);
    expect(aggregate([10, 20, 15], 'Максимум')).toBe(20);
    const stats = builders.find((builder) => builder.id === 'statistics')!;
    const draft = applyPreset(stats.initial, stats.presets[2]);
    expect(chartData(draft).map((row) => row.value)).toEqual([28, 13, 9]);
  });
  it('рассчитывает формулу на примере каждой даты', () => {
    const builder = builders.find((item) => item.id === 'formula')!;
    expect(formulaData(builder.initial).values).toEqual([122, 126, 130]);
    expect(formulaData(applyPreset(builder.initial, builder.presets[1])).values).toEqual([
      119, 120, 124,
    ]);
  });
  it('объясняет, когда таблица с периодом не может работать', () => {
    const builder = builders.find((item) => item.id === 'table')!;
    const draft = {
      ...builder.initial,
      items: builder.initial.items.filter((item) => item.kind !== 'Дата'),
    };
    expect(validate(builder, draft)).toContain(
      'Добавьте видимый столбец типа «Дата» для отбора записей за период.',
    );
  });
});

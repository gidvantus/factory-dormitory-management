import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ConstructorProjectPreview } from './ConstructorProjectPreview';
import { editorInfo, projectBuilders, sections } from './data';

function open(builder = 'statistics'): void {
  render(
    <MemoryRouter initialEntries={[`/preview/constructors-project?builder=${builder}`]}>
      <ConstructorProjectPreview />
    </MemoryRouter>,
  );
}

describe('Вариант №2 в кабинете проекта', () => {
  it.each(projectBuilders)('$id: редактор сохраняет результат в нужный раздел', (builder) => {
    open(builder.id);
    const info = editorInfo[builder.id];
    expect(screen.getByRole('heading', { level: 1, name: info.title })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Настройки конструктора' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Результат настройки' })).toHaveTextContent(
      String(builder.initial.values.name),
    );
    fireEvent.click(screen.getByRole('button', { name: info.save }));
    expect(screen.getByRole('status')).toHaveTextContent('сохранено в тестовом кабинете');
    const sectionName = sections.find((item) => item.id === info.section)!.name;
    const nav = screen.getByRole('navigation', { name: 'Разделы тестового кабинета' });
    expect(within(nav).getByRole('button', { name: sectionName })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen.queryByRole('region', { name: 'Настройки конструктора' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent(String(builder.initial.values.name));
  });

  it('показывает изменение и сохраняет его обратно в отчёт', async () => {
    const user = userEvent.setup();
    open();
    fireEvent.change(screen.getByLabelText('Название блока', { exact: true }), {
      target: { value: 'Мой показатель' },
    });
    await user.selectOptions(screen.getByLabelText('Как показывать'), 'Число');
    await user.selectOptions(screen.getByLabelText('Какие общежития'), 'Только Северный');
    const preview = screen.getByRole('complementary', { name: 'Результат настройки' });
    expect(preview).toHaveTextContent('124');
    expect(preview).toHaveTextContent('Данные общежития «Северный»');
    await user.click(screen.getByRole('button', { name: /^Что изменится/ }));
    expect(preview).toHaveTextContent('Было: Все общежития');
    expect(preview).toHaveTextContent('Стало: Только Северный');
    await user.click(screen.getByRole('button', { name: 'Сохранить блок' }));
    expect(
      screen.getByRole('heading', { name: 'Управленческий отчёт', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Мой показатель', level: 2 })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Настроить блок' }));
    expect(screen.getByLabelText('Название блока')).toHaveValue('Мой показатель');
    expect(screen.getByLabelText('Какие общежития')).toHaveValue('Только Северный');
  });

  it('позволяет продолжить настройку или отменить изменения при выходе', async () => {
    const user = userEvent.setup();
    open();
    fireEvent.change(screen.getByLabelText('Название блока'), { target: { value: 'Черновик' } });
    await user.click(screen.getByRole('button', { name: 'Отмена' }));
    const dialog = screen.getByRole('dialog', { name: 'Сохранить изменения перед выходом?' });
    await user.click(within(dialog).getByRole('button', { name: 'Продолжить настройку' }));
    expect(screen.getByLabelText('Название блока')).toHaveValue('Черновик');
    await user.click(screen.getByRole('button', { name: 'Вернуться к отчёту' }));
    await user.click(screen.getByRole('button', { name: 'Выйти без сохранения' }));
    await user.click(screen.getByRole('button', { name: 'Настроить блок' }));
    expect(screen.getByLabelText('Название блока')).toHaveValue('Проживающие по общежитиям');
  });

  it('сохраняет перед переходом в другой раздел', async () => {
    const user = userEvent.setup();
    open();
    fireEvent.change(screen.getByLabelText('Название блока'), {
      target: { value: 'Сохранённый показатель' },
    });
    const nav = screen.getByRole('navigation', { name: 'Разделы тестового кабинета' });
    await user.click(within(nav).getByRole('button', { name: 'Общежития' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить и выйти' }));
    expect(screen.getByRole('heading', { name: 'Северный', level: 1 })).toBeInTheDocument();
    await user.click(within(nav).getByRole('button', { name: 'Статистика' }));
    expect(
      screen.getByRole('heading', { name: 'Сохранённый показатель', level: 2 }),
    ).toBeInTheDocument();
  });

  it('блокирует пустое название и отменяет ошибочную правку', async () => {
    const user = userEvent.setup();
    open();
    fireEvent.change(screen.getByLabelText('Название блока'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Сохранить блок' })).toBeDisabled();
    expect(screen.getByText('Укажите название — его увидят коллеги.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Отменить последнее изменение' }));
    expect(screen.getByRole('button', { name: 'Сохранить блок' })).toBeEnabled();
    expect(screen.getByLabelText('Название блока')).toHaveValue('Проживающие по общежитиям');
  });

  it('открывает конструкторы из рабочих разделов', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: 'Вернуться к отчёту' }));
    const nav = screen.getByRole('navigation', { name: 'Разделы тестового кабинета' });
    await user.click(within(nav).getByRole('button', { name: 'Общежития' }));
    await user.click(screen.getByRole('button', { name: 'Настроить столбцы' }));
    expect(
      screen.getByRole('heading', { name: 'Настроить столбцы', level: 1 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Вернуться в таблицу' }));
    await user.click(within(nav).getByRole('button', { name: 'Персонал' }));
    await user.click(screen.getByRole('button', { name: 'План заездов' }));
    await user.click(screen.getByRole('button', { name: 'Настроить поля и карточки' }));
    expect(
      screen.getByRole('heading', { name: 'Настроить поле заезда', level: 1 }),
    ).toBeInTheDocument();
  });
});

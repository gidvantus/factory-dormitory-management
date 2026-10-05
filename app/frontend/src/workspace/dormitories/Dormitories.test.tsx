import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../api/client';
import type { Dormitory } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';
import { currentMonth } from '../dashboard/dates';

const DORMITORY: Dormitory = {
  id: 7,
  name: 'Северное',
  client_name: 'Стройкомплект',
  created_at: '2026-10-04T10:00:00Z',
};
const USER = {
  email: 'worker@example.com',
  full_name: 'Иван Иванов',
  created_at: '2026-01-01T00:00:00Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockList(items: Dormitory[] = []): void {
  mockFetch((url) => {
    if (url.endsWith('/api/me')) return { status: 200, body: USER };
    if (url.endsWith('/api/dormitories')) return { status: 200, body: items };
    if (url.endsWith('/api/report-templates')) return { status: 200, body: [] };
    if (url.endsWith('/api/dormitories/7')) return { status: 200, body: DORMITORY };
    if (url.includes('/api/dormitories/7/report?'))
      return {
        status: 200,
        body: { from_date: currentMonth().from, to_date: currentMonth().to, rows: [] },
      };
    return { status: 404, body: { detail: 'Общежитие не найдено' } };
  });
}

async function openDialog(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  const button = await screen.findByTestId('create-dormitory-button');
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  return user;
}

async function fillDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('Название общежития'), DORMITORY.name);
  await user.type(screen.getByLabelText('Название клиента'), DORMITORY.client_name);
}

describe('общежития', () => {
  it('создаёт карточку с клиентом перед названием, открывает разделы общежития и возвращает в список', async () => {
    let items: Dormitory[] = [];
    const fetchMock = mockFetch((url, init) => {
      if (url.endsWith('/api/me')) return { status: 200, body: USER };
      if (url.endsWith('/api/dormitories') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          name: DORMITORY.name,
          client_name: DORMITORY.client_name,
        });
        items = [DORMITORY];
        return { status: 201, body: DORMITORY };
      }
      if (url.endsWith('/api/dormitories')) return { status: 200, body: items };
      if (url.endsWith('/api/report-templates')) return { status: 200, body: [] };
      if (url.includes('/api/dormitories/7/report?'))
        return {
          status: 200,
          body: { from_date: currentMonth().from, to_date: currentMonth().to, rows: [] },
        };
      return { status: 200, body: DORMITORY };
    });
    renderApp('/cabinet/dormitories');
    const user = await openDialog();
    expect(screen.getByLabelText('Название общежития')).toHaveFocus();
    await fillDialog(user);
    await user.click(screen.getByTestId('create-dormitory-submit'));
    const card = await screen.findByTestId('dormitory-card-7');
    expect(card.textContent).toBe(`${DORMITORY.client_name}${DORMITORY.name}`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe('hidden');
    await user.click(card);
    const details = await screen.findByTestId('dormitory-details-page');
    await waitFor(() => expect(within(details).queryByRole('status')).not.toBeInTheDocument());
    expect(within(details).getByText('Клиент: Стройкомплект')).toBeInTheDocument();
    expect(
      within(details).getByRole('heading', { name: 'Общежитие «Северное»' }),
    ).toBeInTheDocument();
    expect(
      within(details).getByRole('navigation', { name: 'Разделы общежития' }),
    ).toBeInTheDocument();
    expect(within(details).getByTestId('dormitory-tab-report')).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByTestId('workspace-nav-dormitories')).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByTestId('dormitory-back'));
    expect(await screen.findByTestId('dormitory-card-7')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('проверяет обязательные поля до отправки и закрывается по Escape с возвратом фокуса', async () => {
    mockList();
    const create = vi.spyOn(api, 'createDormitory');
    renderApp('/cabinet/dormitories');
    const user = await openDialog();
    await user.click(screen.getByTestId('create-dormitory-submit'));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getByLabelText('Название общежития')).toHaveFocus();
    expect(create).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Название общежития'), 'Несохранённое');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('create-dormitory-button')).toHaveFocus();
    expect(document.body.style.overflow).not.toBe('hidden');
    await user.click(screen.getByTestId('create-dormitory-button'));
    expect(screen.getByLabelText('Название общежития')).toHaveValue('');
  });

  it('не теряет введённые данные при ошибке и позволяет повторить сохранение', async () => {
    mockList();
    const create = vi
      .spyOn(api, 'createDormitory')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce(DORMITORY);
    renderApp('/cabinet/dormitories');
    const user = await openDialog();
    await fillDialog(user);
    await user.click(screen.getByTestId('create-dormitory-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось создать общежитие');
    expect(screen.getByLabelText('Название общежития')).toHaveValue(DORMITORY.name);
    expect(screen.getByLabelText('Название клиента')).toHaveValue(DORMITORY.client_name);
    await user.click(screen.getByTestId('create-dormitory-submit'));
    expect(await screen.findByTestId('dormitory-card-7')).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('блокирует повторную отправку и закрытие, пока сохраняется общежитие', async () => {
    mockList();
    let resolve!: (value: Dormitory) => void;
    const create = vi.spyOn(api, 'createDormitory').mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    renderApp('/cabinet/dormitories');
    const user = await openDialog();
    await fillDialog(user);
    const form = screen.getByTestId('create-dormitory-submit').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('create-dormitory-submit')).toBeDisabled();
    expect(screen.getByTestId('create-dormitory-modal-close')).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    resolve(DORMITORY);
    expect(await screen.findByTestId('dormitory-card-7')).toBeInTheDocument();
  });

  it('восстанавливает сохранённые карточки при открытии списка и даёт повторить загрузку', async () => {
    mockList();
    vi.spyOn(api, 'dormitories')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce([DORMITORY]);
    renderApp('/cabinet/dormitories');
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить список');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByTestId('dormitory-card-7')).toBeInTheDocument();
  });

  it('открывает общежитие по прямой ссылке', async () => {
    mockList([DORMITORY]);
    renderApp('/cabinet/dormitories/7');
    const details = await screen.findByTestId('dormitory-details-page');
    await waitFor(() => expect(within(details).queryByRole('status')).not.toBeInTheDocument());
    expect(within(details).getByTestId('dormitory-tab-report')).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(details).getByRole('heading', { name: 'Большой отчёт' })).toBeInTheDocument();
  });

  it('сохраняет шаблон, выбирает его для нового общежития и удаляет из списка', async () => {
    const newDormitory: Dormitory = { ...DORMITORY, id: 8, name: 'Восточное' };
    let templates: Array<{ id: number; name: string; row_count: number; created_at: string }> = [];
    let dormitories = [DORMITORY];
    const fetchMock = mockFetch((url, init) => {
      if (url.endsWith('/api/me')) return { status: 200, body: USER };
      if (url.endsWith('/api/report-templates') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ name: 'Стандарт', dormitory_id: 7 });
        templates = [{ id: 4, name: 'Стандарт', row_count: 1, created_at: '2026-10-05T10:00:00Z' }];
        return { status: 201, body: templates[0] };
      }
      if (url.endsWith('/api/report-templates/4') && init?.method === 'DELETE') {
        templates = [];
        return { status: 204 };
      }
      if (url.endsWith('/api/report-templates')) return { status: 200, body: templates };
      if (url.endsWith('/api/dormitories') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          name: 'Восточное',
          client_name: 'Стройкомплект',
          template_id: 4,
        });
        dormitories = [newDormitory, DORMITORY];
        return { status: 201, body: newDormitory };
      }
      if (url.endsWith('/api/dormitories')) return { status: 200, body: dormitories };
      if (url.endsWith('/api/dormitories/7')) return { status: 200, body: DORMITORY };
      if (url.includes('/api/dormitories/7/report?'))
        return {
          status: 200,
          body: {
            from_date: currentMonth().from,
            to_date: currentMonth().to,
            rows: [
              {
                id: 1,
                name: 'Проживающие',
                position: 1,
                formula: null,
                values: { [currentMonth().from]: '17' },
                errors: {},
              },
            ],
          },
        };
      return { status: 404, body: {} };
    });
    const user = userEvent.setup();
    renderApp('/cabinet/dormitories/7/report');
    await user.click(await screen.findByTestId('report-save-template'));
    await user.type(screen.getByTestId('report-template-name'), 'Стандарт');
    await user.click(screen.getByRole('button', { name: 'Сохранить шаблон' }));
    expect(await screen.findByText(/Шаблон «Стандарт» сохранён/)).toBeInTheDocument();
    await user.click(screen.getByTestId('dormitory-back'));
    expect(
      await screen.findByRole('button', { name: 'Удалить шаблон Стандарт' }),
    ).toBeInTheDocument();
    await openDialog();
    await user.type(screen.getByLabelText('Название общежития'), 'Восточное');
    await user.type(screen.getByLabelText('Название клиента'), 'Стройкомплект');
    await waitFor(() => expect(screen.getByTestId('dormitory-template')).toBeEnabled());
    await user.selectOptions(screen.getByTestId('dormitory-template'), '4');
    await user.click(screen.getByTestId('create-dormitory-submit'));
    expect(await screen.findByTestId('dormitory-card-8')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Удалить шаблон Стандарт' }));
    await user.click(screen.getByRole('button', { name: 'Подтвердить удаление шаблона Стандарт' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Удалить шаблон Стандарт' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith('/api/report-templates/4') && init?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('создаёт строку отчёта и автоматически сохраняет ячейку за выбранную дату', async () => {
    const day = currentMonth().from;
    let rows: Array<{
      id: number;
      name: string;
      position: number;
      formula: string | null;
      values: Record<string, string>;
      errors: Record<string, string>;
    }> = [];
    const fetchMock = mockFetch((url, init) => {
      if (url.endsWith('/api/me')) return { status: 200, body: USER };
      if (url.endsWith('/api/dormitories/7')) return { status: 200, body: DORMITORY };
      if (url.includes('/api/dormitories/7/report?'))
        return {
          status: 200,
          body: { from_date: currentMonth().from, to_date: currentMonth().to, rows },
        };
      if (url.endsWith('/api/dormitories/7/report/rows') && init?.method === 'POST') {
        const data = JSON.parse(String(init.body)) as { name: string; formula: string | null };
        rows = [
          { id: 1, name: data.name, position: 1, formula: data.formula, values: {}, errors: {} },
        ];
        return { status: 201, body: rows[0] };
      }
      if (url.endsWith(`/api/dormitories/7/report/rows/1/cells/${day}`) && init?.method === 'PUT') {
        const data = JSON.parse(String(init.body)) as { value: string };
        rows = [{ ...rows[0], values: { [day]: data.value } }];
        return { status: 204 };
      }
      return { status: 404, body: {} };
    });
    const user = userEvent.setup();
    renderApp('/cabinet/dormitories/7/report');
    await screen.findByText('Пока нет строк отчёта');
    await user.click(screen.getByTestId('report-add-row'));
    await user.type(screen.getByTestId('report-row-name'), 'Проживающие');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    const cell = await screen.findByTestId(`report-cell-1-${day}`);
    await user.type(cell, '17');
    fireEvent.blur(cell);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith(`/report/rows/1/cells/${day}`) && init?.method === 'PUT',
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(cell).toHaveValue('17'));
    expect(rows[0].values[day]).toBe('17');
    expect(screen.queryByTitle('Сохранено')).not.toBeInTheDocument();
  });

  it('меняет порядок строк отчёта', async () => {
    let rows = [
      { id: 1, name: 'Первая', position: 1, formula: null, values: {}, errors: {} },
      { id: 2, name: 'Вторая', position: 2, formula: null, values: {}, errors: {} },
    ];
    const fetchMock = mockFetch((url, init) => {
      if (url.endsWith('/api/me')) return { status: 200, body: USER };
      if (url.endsWith('/api/dormitories/7')) return { status: 200, body: DORMITORY };
      if (url.includes('/api/dormitories/7/report?'))
        return {
          status: 200,
          body: { from_date: currentMonth().from, to_date: currentMonth().to, rows },
        };
      if (url.endsWith('/api/dormitories/7/report/rows/2/move') && init?.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({ direction: 'up' });
        rows = [rows[1], rows[0]];
        return { status: 200, body: rows[0] };
      }
      return { status: 404, body: {} };
    });
    const user = userEvent.setup();
    renderApp('/cabinet/dormitories/7/report');
    await screen.findByRole('button', { name: 'Переместить строку Вторая вверх' });
    await user.click(screen.getByRole('button', { name: 'Переместить строку Вторая вверх' }));
    await waitFor(() =>
      expect(screen.getAllByRole('rowheader').map((header) => header.textContent)).toEqual([
        'Вторая↑↓',
        'Первая↑↓',
      ]),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).endsWith('/rows/2/move') && init?.method === 'PATCH',
      ),
    ).toBe(true);
  });

  it('переключает основные и вложенные разделы по прямым ссылкам без повторной загрузки общежития', async () => {
    const fetchMock = mockFetch((url) => {
      if (url.endsWith('/api/me')) return { status: 200, body: USER };
      if (url.endsWith('/api/dormitories/7')) return { status: 200, body: DORMITORY };
      return { status: 404, body: {} };
    });
    const user = userEvent.setup();
    renderApp('/cabinet/dormitories/7/movement/outflow');
    const details = await screen.findByTestId('dormitory-details-page');
    expect(await within(details).findByRole('heading', { name: 'Отток' })).toBeInTheDocument();
    expect(within(details).getByTestId('dormitory-tab-movement')).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(details).getByTestId('dormitory-subtab-outflow')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(within(details).getByTestId('dormitory-tab-payments'));
    expect(within(details).getByRole('heading', { name: 'На аванс' })).toBeInTheDocument();
    await user.click(within(details).getByTestId('dormitory-subtab-settlement'));
    expect(within(details).getByRole('heading', { name: 'На расчёт' })).toBeInTheDocument();
    await user.click(within(details).getByTestId('dormitory-tab-archive'));
    expect(within(details).getByRole('heading', { name: 'Архив' })).toBeInTheDocument();
    expect(
      within(details).queryByRole('navigation', { name: 'Разделы: Выплаты' }),
    ).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/api/dormitories/7'))).toHaveLength(
      1,
    );
  });

  it('показывает текущий месяц по умолчанию и сохраняет выбранный период при смене вкладки', async () => {
    mockList([DORMITORY]);
    const user = userEvent.setup();
    renderApp('/cabinet/dormitories/7');
    const details = await screen.findByTestId('dormitory-details-page');
    await within(details).findByRole('heading', { name: 'Общежитие «Северное»' });
    const from = within(details).getByTestId('dormitory-period-from');
    const to = within(details).getByTestId('dormitory-period-to');
    expect(from).toHaveValue(currentMonth().from);
    expect(to).toHaveValue(currentMonth().to);

    fireEvent.change(from, { target: { value: '2026-09-20' } });
    fireEvent.change(to, { target: { value: '2026-09-10' } });
    await user.click(within(details).getByRole('button', { name: 'Применить' }));
    expect(within(details).getByRole('alert')).toHaveTextContent('Дата «От» должна быть не позже');

    fireEvent.change(to, { target: { value: '2026-09-30' } });
    await user.click(within(details).getByRole('button', { name: 'Применить' }));
    expect(within(details).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(details).getByTestId('dormitory-period-applied')).toHaveTextContent(
      '20.09.2026 — 30.09.2026',
    );
    await user.click(within(details).getByTestId('dormitory-tab-places'));
    expect(within(details).getByTestId('dormitory-period-applied')).toHaveTextContent(
      '20.09.2026 — 30.09.2026',
    );
    await user.click(within(details).getByRole('button', { name: 'Текущий месяц' }));
    expect(from).toHaveValue(currentMonth().from);
    expect(to).toHaveValue(currentMonth().to);
  });

  it('показывает отсутствие общежития и оставляет рабочую кнопку назад', async () => {
    mockList();
    renderApp('/cabinet/dormitories/999');
    expect(await screen.findByRole('alert')).toHaveTextContent('Общежитие не найдено');
    expect(screen.getByTestId('dormitory-back')).toHaveAttribute('href', '/cabinet/dormitories');
  });
});

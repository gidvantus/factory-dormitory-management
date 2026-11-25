import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { Journal } from './Journal';
import { OperatorContext } from '../auth/operatorContext';
import { mockFetch } from '../test/mockFetch';
import type { MockStep } from '../test/mockFetch';

/** Запись журнала в форме ответа основного API (порядок ключей как у сервера). */
function entry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 14821,
    created_at: '2026-11-24T06:12:00Z',
    actor_id: 5,
    actor_name: 'Иванов Иван Иванович',
    method: 'PATCH',
    path: '/api/organization',
    action: 'patch_organization',
    action_title: 'Изменил организацию',
    kind: 'data',
    status: 200,
    duration_ms: 64,
    ip: null,
    user_agent: null,
    request_id: null,
    path_params: null,
    request_body: null,
    changes: null,
    organization_id: 3,
    organization_name: 'ООО Ромашка',
    ...overrides,
  };
}

const COMPANY_ROW = entry({ id: 14821 });
const PLATFORM_ROW = entry({
  id: 14820,
  actor_id: null,
  actor_name: null,
  action: 'post_login',
  action_title: 'Вход',
  kind: 'security',
  status: 302,
  duration_ms: null,
  organization_id: null,
  organization_name: null,
});
const UNKNOWN_ROW = entry({
  id: 14819,
  actor_id: 7,
  actor_name: null,
  action: 'delete_legacy_thing',
  action_title: 'delete_legacy_thing',
  kind: 'noise',
  status: 500,
  duration_ms: 12,
  organization_id: 4,
  organization_name: null,
});

const FIRST_PAGE = {
  items: [COMPANY_ROW, PLATFORM_ROW, UNKNOWN_ROW],
  next_cursor: null,
  total: 3,
};

/** Журнал в настоящем роутере: переходы не нужны, но маршрут - тот же, что в приложении. */
function renderJournal(steps: MockStep[]) {
  const network = mockFetch(steps);
  render(
    <OperatorContext.Provider value={{ username: 'operator' }}>
      <MemoryRouter initialEntries={['/journal']}>
        <Routes>
          <Route path="/journal" element={<Journal />} />
        </Routes>
      </MemoryRouter>
    </OperatorContext.Provider>,
  );
  return network;
}

/** Адреса запросов журнала, по порядку: в них видно, что уходит наверх. */
function requestedParams(network: { calls: { url: string }[] }): URLSearchParams[] {
  return network.calls.map((call) => new URL(call.url, 'http://localhost').searchParams);
}

function dateInput(testId: string): HTMLInputElement {
  return screen.getByTestId(testId) as HTMLInputElement;
}

describe('раздел «Журнал» кабинета оператора', () => {
  it('показывает загрузку, затем ленту с подписью периода и счётчиком', async () => {
    const network = renderJournal([{ status: 200, body: FIRST_PAGE }]);

    expect(screen.getByTestId('operator-journal-loading')).toHaveTextContent('Загружаем журнал…');
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(dateInput('operator-journal-from')).toBeDisabled();
    expect(screen.getByTestId('operator-journal-apply')).toBeDisabled();

    expect(await screen.findByTestId('operator-journal-count')).toHaveTextContent(
      'За этот период — 3 записи',
    );
    expect(screen.getAllByTestId('operator-journal-row')).toHaveLength(3);
    expect(screen.getByRole('table')).toHaveAccessibleName(/События всех компаний платформы/);
    expect(network.calls).toHaveLength(1);
  });

  it('первый запрос без вида и с периодом по умолчанию, лимит страницы 50', async () => {
    const network = renderJournal([{ status: 200, body: FIRST_PAGE }]);
    await screen.findByTestId('operator-journal-count');

    const [params] = requestedParams(network);
    expect(params.get('limit')).toBe('50');
    expect(params.has('kind')).toBe(false);
    expect(params.get('date_from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(params.get('date_to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(params.has('cursor')).toBe(false);
    // Поля формы заполнены тем же периодом, что ушёл на сервер.
    expect(dateInput('operator-journal-from').value).toBe(params.get('date_from'));
    expect(dateInput('operator-journal-to').value).toBe(params.get('date_to'));
  });

  it('строка ленты: «Платформа», безымянный сотрудник, код действия и тона статуса', async () => {
    renderJournal([{ status: 200, body: FIRST_PAGE }]);
    await screen.findByTestId('operator-journal-count');
    const [company, platform, unknown] = screen.getAllByTestId('operator-journal-row');

    expect(within(company).getByTestId('operator-journal-company')).toHaveTextContent(
      'ООО Ромашка',
    );
    expect(within(company).getByTestId('operator-journal-actor')).toHaveTextContent(
      'Иванов Иван Иванович',
    );
    expect(within(company).getByTestId('operator-journal-kind-cell')).toHaveTextContent('Данные');
    expect(within(company).getByTestId('operator-journal-status')).toHaveTextContent('200');
    expect(within(company).getByTestId('operator-journal-status')).toHaveTextContent('64 мс');
    expect(
      within(company).getByTestId('operator-journal-status').querySelector('.journal__status'),
    ).toHaveAttribute('data-state', 'ok');

    const platformCompany = within(platform).getByTestId('operator-journal-company');
    expect(platformCompany).toHaveTextContent(/^Платформа$/);
    expect(platformCompany).toHaveClass('journal__company--platform');
    expect(within(platform).getByTestId('operator-journal-actor')).toHaveTextContent(/^—$/);
    expect(within(platform).getByTestId('operator-journal-actor')).toHaveClass(
      'journal__actor--none',
    );
    expect(within(platform).getByTestId('operator-journal-kind-cell')).toHaveTextContent(
      'Безопасность',
    );
    // Статус 302 - тоже шалфей; без длительности «мс» не печатается.
    expect(
      within(platform).getByTestId('operator-journal-status').querySelector('.journal__status'),
    ).toHaveAttribute('data-state', 'ok');
    expect(within(platform).getByTestId('operator-journal-status')).not.toHaveTextContent('мс');

    // Сотрудник без снимка имени - «Сотрудник №{id}»; действие без названия - кодом.
    expect(within(unknown).getByTestId('operator-journal-actor')).toHaveTextContent('Сотрудник №7');
    const action = within(unknown).getByTestId('operator-journal-action');
    expect(action).toHaveTextContent('delete_legacy_thing');
    expect(action).toHaveAttribute('data-unknown', 'true');
    // Неизвестная компания (id есть, имени нет) - не «Платформа».
    expect(within(unknown).getByTestId('operator-journal-company')).not.toHaveTextContent(
      'Платформа',
    );
    // Статус 500 - кирпичный тон.
    expect(
      within(unknown).getByTestId('operator-journal-status').querySelector('.journal__status'),
    ).toHaveAttribute('data-state', 'fail');
  });

  it('статус null: полая точка и прочерк вместо кода', async () => {
    renderJournal([
      {
        status: 200,
        body: { items: [entry({ status: null, duration_ms: null })], next_cursor: null, total: 1 },
      },
    ]);
    await screen.findByTestId('operator-journal-count');

    const status = screen.getByTestId('operator-journal-status');
    expect(status.querySelector('.journal__status')).toHaveAttribute('data-state', 'none');
    expect(status).toHaveTextContent('—');
  });

  it('раскрытие записи: нативный details, JSON и фон открытой строки', async () => {
    renderJournal([{ status: 200, body: FIRST_PAGE }]);
    await screen.findByTestId('operator-journal-count');

    const [company] = screen.getAllByTestId('operator-journal-row');
    const [detail] = screen.getAllByTestId('operator-journal-detail');
    const summary = detail.querySelector('summary');
    expect(summary).not.toBeNull();
    if (summary === null) throw new Error('У записи нет summary');
    expect(detail.tagName).toBe('DETAILS');
    expect(summary).toHaveTextContent('Запись журнала');
    expect(summary).toHaveTextContent('№ 14821');
    expect(company).not.toHaveClass('journal__row--open');
    const json = within(detail).getByTestId('operator-journal-json');
    const parsed = JSON.parse(json.textContent ?? '') as Record<string, unknown>;
    expect(parsed.id).toBe(14821);
    expect(parsed.organization_name).toBe('ООО Ромашка');
    expect(json.textContent).toContain('\n  "id": 14821');

    await userEvent.click(summary);
    await waitFor(() => expect(company).toHaveClass('journal__row--open'));

    await userEvent.click(summary);
    await waitFor(() => expect(company).not.toHaveClass('journal__row--open'));
  });

  it('фильтр по виду уходит параметром kind и заменяет ленту', async () => {
    const security = { items: [PLATFORM_ROW], next_cursor: null, total: 1 };
    const network = renderJournal([
      { status: 200, body: FIRST_PAGE },
      { status: 200, body: security },
    ]);
    await screen.findByTestId('operator-journal-count');

    await userEvent.selectOptions(screen.getByTestId('operator-journal-kind'), 'security');
    await userEvent.click(screen.getByTestId('operator-journal-apply'));

    expect(await screen.findByTestId('operator-journal-count')).toHaveTextContent(
      'За этот период — 1 запись',
    );
    const [, second] = requestedParams(network);
    expect(second.get('kind')).toBe('security');
  });

  it('422 по периоду: текст сервера дословно, обе даты помечены, «Повторить» нет', async () => {
    const detail = 'Дата начала периода позже даты окончания';
    renderJournal([{ status: 422, body: { detail } }]);

    const alert = await screen.findByTestId('operator-journal-error');
    expect(alert).toHaveTextContent(detail);
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert.textContent).toBe(detail);
    expect(dateInput('operator-journal-from')).toHaveAttribute('aria-invalid', 'true');
    expect(dateInput('operator-journal-to')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByTestId('operator-journal-retry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('operator-journal-count')).not.toBeInTheDocument();
  });

  it('502: текст шлюза и «Повторить», повтор перезапрашивает ленту', async () => {
    const network = renderJournal([
      { status: 502, body: { detail: 'Основной API недоступен' } },
      { status: 200, body: FIRST_PAGE },
    ]);

    expect(await screen.findByTestId('operator-journal-error')).toHaveTextContent(
      'Основной API недоступен',
    );
    expect(dateInput('operator-journal-from')).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByTestId('operator-journal-count')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('operator-journal-retry'));

    expect(await screen.findByTestId('operator-journal-count')).toHaveTextContent(
      'За этот период — 3 записи',
    );
    expect(network.calls).toHaveLength(2);
  });

  it('пусто за период: текст с выбранными датами и видом, фильтры остаются заполненными', async () => {
    renderJournal([{ status: 200, body: { items: [], next_cursor: null, total: 0 } }]);

    const empty = await screen.findByTestId('operator-journal-empty');
    expect(within(empty).getByRole('heading', { level: 2 })).toHaveTextContent(
      'За этот период записей нет',
    );
    const from = dateInput('operator-journal-from').value;
    const to = dateInput('operator-journal-to').value;
    const [fy, fm, fd] = from.split('-');
    const [ty, tm, td] = to.split('-');
    expect(empty).toHaveTextContent(
      `С ${fd}.${fm}.${fy} по ${td}.${tm}.${ty} событий по всем компаниям не записано.`,
    );
    expect(dateInput('operator-journal-from').value).toBe(from);
  });

  it('пусто при виде «Безопасность»: фраза собирается по выбранному виду', async () => {
    renderJournal([
      { status: 200, body: FIRST_PAGE },
      { status: 200, body: { items: [], next_cursor: null, total: 0 } },
    ]);
    await screen.findByTestId('operator-journal-count');

    await userEvent.selectOptions(screen.getByTestId('operator-journal-kind'), 'security');
    await userEvent.click(screen.getByTestId('operator-journal-apply'));

    expect(await screen.findByTestId('operator-journal-empty')).toHaveTextContent(
      'событий безопасности по всем компаниям не записано',
    );
  });

  it('«Показать ещё» дописывает строки и держит счётчик с первой страницы', async () => {
    const page1 = {
      items: [COMPANY_ROW],
      next_cursor: '2026-11-24T06:12:00Z|14821',
      total: 2,
    };
    const page2 = { items: [PLATFORM_ROW], next_cursor: null, total: null };
    const network = renderJournal([
      { status: 200, body: page1 },
      { status: 200, body: page2 },
    ]);

    await screen.findByTestId('operator-journal-count');
    expect(screen.getAllByTestId('operator-journal-row')).toHaveLength(1);
    await userEvent.click(screen.getByTestId('operator-journal-more'));

    await waitFor(() => expect(screen.getAllByTestId('operator-journal-row')).toHaveLength(2));
    expect(screen.getByTestId('operator-journal-count')).toHaveTextContent(
      'За этот период — 2 записи',
    );
    // Курсор ушёл как получен, без пересборки на клиенте.
    expect(requestedParams(network)[1].get('cursor')).toBe('2026-11-24T06:12:00Z|14821');
    // Страницы без `next_cursor` - кнопки нет.
    expect(screen.queryByTestId('operator-journal-more')).not.toBeInTheDocument();
  });

  it('отказ догрузки: уже показанные строки остаются, ошибка под подвалом', async () => {
    const page1 = { items: [COMPANY_ROW], next_cursor: 'c|1', total: 2 };
    renderJournal([
      { status: 200, body: page1 },
      { status: 502, body: { detail: 'Основной API недоступен' } },
    ]);

    await screen.findByTestId('operator-journal-count');
    await userEvent.click(screen.getByTestId('operator-journal-more'));

    expect(await screen.findByTestId('operator-journal-more-error')).toHaveTextContent(
      'Основной API недоступен',
    );
    expect(screen.getAllByTestId('operator-journal-row')).toHaveLength(1);
    expect(screen.getByTestId('operator-journal-count')).toHaveTextContent(
      'За этот период — 2 записи',
    );
  });
});

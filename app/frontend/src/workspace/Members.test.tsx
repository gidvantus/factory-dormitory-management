import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api/client';
import type { OrganizationMember } from '../api/client';
import { mockFetch, type MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const USER = {
  email: 'owner@example.com',
  full_name: 'Иванов Иван Иванович',
  created_at: '2026-01-01T00:00:00Z',
  is_active: true,
};

const SESSION: MockResponse = { status: 200, body: USER };

const OWNER: OrganizationMember = {
  id: 1,
  email: 'owner@example.com',
  full_name: 'Иванов Иван Иванович',
  role: 'owner',
  is_active: true,
  created_at: '2026-10-01T00:00:00Z',
};

const INVITED: OrganizationMember = {
  id: 2,
  email: 'novyi@example.com',
  full_name: 'Петров Пётр',
  role: 'commandant',
  is_active: false,
  created_at: '2026-10-02T00:00:00Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * `SessionProvider` при монтировании сам ходит в `/api/me`, поэтому заглушка
 * отвечает на все три маршрута: профиль, список участников и приглашение.
 */
function mountMembers(
  membersResponse: MockResponse,
  extra?: (url: string, init?: RequestInit) => MockResponse | null,
): ReturnType<typeof vi.fn> {
  return mockFetch((url, init) => {
    if (url.endsWith('/api/me')) return SESSION;
    if (url.endsWith('/api/organization/invitations')) {
      return extra?.(url, init) ?? { status: 201, body: INVITED };
    }
    if (url.endsWith('/api/organization/members')) {
      return extra?.(url, init) ?? membersResponse;
    }
    return { status: 404, body: { detail: 'Не найдено' } };
  });
}

function rows(): HTMLElement[] {
  return screen.getAllByTestId('member-row');
}

function rowFor(email: string): HTMLElement {
  const found = rows().find((row) => within(row).queryByText(email) !== null);
  if (!found) throw new Error(`нет строки с ${email}`);
  return found;
}

describe('экран сотрудников', () => {
  it('показывает участников организации с ролями словами и статусами', async () => {
    mountMembers({ status: 200, body: [OWNER, INVITED] });
    renderApp('/cabinet/organization/members');

    expect(await screen.findByTestId('members-table')).toBeInTheDocument();
    await waitFor(() => expect(rows()).toHaveLength(2));

    const ownerRow = rowFor(OWNER.email);
    expect(within(ownerRow).getByTestId('member-name')).toHaveTextContent('Иванов Иван Иванович');
    expect(within(ownerRow).getByTestId('member-role')).toHaveTextContent('Владелец');
    expect(within(ownerRow).getByTestId('member-status')).toHaveTextContent('Активирован');

    const invitedRow = rowFor(INVITED.email);
    expect(within(invitedRow).getByTestId('member-role')).toHaveTextContent('Комендант');
    expect(within(invitedRow).getByTestId('member-status')).toHaveTextContent(
      'Приглашение отправлено',
    );
    expect(screen.getByTestId('members-count')).toHaveTextContent('2');
  });

  it('показывает роль менеджера словами', async () => {
    mountMembers({ status: 200, body: [{ ...INVITED, role: 'manager' }] });
    renderApp('/cabinet/organization/members');

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByTestId('member-role')).toHaveTextContent('Менеджер');
  });

  it('отправляет приглашение с выбранной ролью и добавляет сотрудника в список', async () => {
    const fetchMock = mountMembers({ status: 200, body: [OWNER] });
    const user = userEvent.setup();
    renderApp('/cabinet/organization/members');

    await user.type(await screen.findByTestId('invite-email'), 'novyi@example.com');
    await user.type(screen.getByTestId('invite-full-name'), 'Петров Пётр');
    await user.selectOptions(screen.getByTestId('invite-role'), 'commandant');
    await user.click(screen.getByTestId('invite-submit'));

    expect(await screen.findByTestId('invite-success')).toHaveTextContent('Приглашение отправлено');
    await waitFor(() => expect(rows()).toHaveLength(2));

    const post = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/api/organization/invitations') && init?.method === 'POST',
    );
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      email: 'novyi@example.com',
      full_name: 'Петров Пётр',
      role: 'commandant',
    });

    const invitedRow = rowFor(INVITED.email);
    expect(within(invitedRow).getByTestId('member-status')).toHaveTextContent(
      'Приглашение отправлено',
    );
    // Поля очищаются после успеха: следующее приглашение вводится с нуля.
    expect(screen.getByTestId('invite-email')).toHaveValue('');
    expect(screen.getByTestId('invite-full-name')).toHaveValue('');
  });

  it('по умолчанию предлагает роль менеджера', async () => {
    mountMembers({ status: 200, body: [OWNER] });
    renderApp('/cabinet/organization/members');

    expect(await screen.findByTestId('invite-role')).toHaveValue('manager');
  });

  it('показывает текст 409 от сервера и возвращает фокус в поле email', async () => {
    mountMembers({ status: 200, body: [OWNER] }, (_url, init) =>
      init?.method === 'POST'
        ? { status: 409, body: { detail: 'Пользователь с таким email уже зарегистрирован' } }
        : null,
    );
    const user = userEvent.setup();
    renderApp('/cabinet/organization/members');

    await user.type(await screen.findByTestId('invite-email'), 'zanyat@example.com');
    await user.type(screen.getByTestId('invite-full-name'), 'Занятый Адрес');
    await user.click(screen.getByTestId('invite-submit'));

    expect(await screen.findByTestId('invite-error')).toHaveTextContent(
      'Пользователь с таким email уже зарегистрирован',
    );
    expect(screen.queryByTestId('invite-success')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('invite-email')).toHaveFocus());
  });

  it('показывает 422 FastAPI так, как его отдаёт сервер, — списком detail', async () => {
    mountMembers({ status: 200, body: [OWNER] }, (_url, init) =>
      init?.method === 'POST'
        ? {
            status: 422,
            body: {
              detail: [
                {
                  type: 'value_error',
                  loc: ['body', 'full_name'],
                  msg: 'Value error, ФИО не может быть пустым',
                  input: '   ',
                },
              ],
            },
          }
        : null,
    );
    const user = userEvent.setup();
    renderApp('/cabinet/organization/members');

    await user.type(await screen.findByTestId('invite-email'), 'novyi@example.com');
    await user.type(screen.getByTestId('invite-full-name'), '   ');
    await user.click(screen.getByTestId('invite-submit'));

    const error = await screen.findByTestId('invite-error');
    expect(error).toHaveTextContent('full_name: ФИО не может быть пустым');
    expect(error).not.toHaveTextContent('Запрос не удался');
    await waitFor(() => expect(screen.getByTestId('invite-full-name')).toHaveFocus());
  });

  it('показывает 422 на пустой email текстом валидатора', async () => {
    mountMembers({ status: 200, body: [OWNER] }, (_url, init) =>
      init?.method === 'POST'
        ? {
            status: 422,
            body: {
              detail: [
                {
                  type: 'value_error',
                  loc: ['body', 'email'],
                  msg: 'value is not a valid email address',
                  input: '',
                },
              ],
            },
          }
        : null,
    );
    const user = userEvent.setup();
    renderApp('/cabinet/organization/members');

    await screen.findByTestId('invite-email');
    await user.type(screen.getByTestId('invite-full-name'), 'Петров Пётр');
    await user.click(screen.getByTestId('invite-submit'));

    expect(await screen.findByTestId('invite-error')).toHaveTextContent(
      'email: value is not a valid email address',
    );
  });

  it('вместо формы выводит сообщение, если пользователь не привязан к организации', async () => {
    mountMembers({ status: 404, body: { detail: 'Организация не найдена' } });
    renderApp('/cabinet/organization/members');

    expect(await screen.findByTestId('members-not-linked')).toHaveTextContent(
      'Организация не привязана',
    );
    expect(screen.queryByTestId('invite-submit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('members-table')).not.toBeInTheDocument();
  });

  it('даёт повторить загрузку после сбоя', async () => {
    let gets = 0;
    mountMembers({ status: 200, body: [OWNER] }, (_url, init) => {
      if (init?.method === 'POST') return null;
      gets += 1;
      return gets === 1 ? { status: 500, body: { detail: 'Сбой' } } : null;
    });
    const user = userEvent.setup();
    renderApp('/cabinet/organization/members');

    expect(await screen.findByTestId('members-error')).toHaveTextContent(
      'Не удалось загрузить список сотрудников',
    );
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('отправляет форму один раз, пока идёт запрос', async () => {
    let resolveInvite!: (value: OrganizationMember) => void;
    const fetchMock = mockFetch((url, init) => {
      if (url.endsWith('/api/me')) return SESSION;
      if (init?.method === 'POST') throw new Error('перехвачено spy');
      return { status: 200, body: [OWNER] };
    });
    const invite = vi.spyOn(api, 'inviteMember').mockImplementation(
      () =>
        new Promise<OrganizationMember>((done) => {
          resolveInvite = done;
        }),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/organization/members');

    await user.type(await screen.findByTestId('invite-email'), 'novyi@example.com');
    await user.type(screen.getByTestId('invite-full-name'), 'Петров Пётр');
    await user.click(screen.getByTestId('invite-submit'));
    await waitFor(() => expect(screen.getByTestId('invite-submit')).toBeDisabled());
    await user.click(screen.getByTestId('invite-submit'));

    expect(invite).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);

    resolveInvite({ ...INVITED, email: 'novyi@example.com' });
    expect(await screen.findByTestId('invite-success')).toBeInTheDocument();
  });
});

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api/client';
import type { Organization as OrganizationRecord } from '../api/client';
import { mockFetch, type MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const USER = {
  email: 'worker@example.com',
  full_name: 'Иванов Иван Иванович',
  created_at: '2026-01-01T00:00:00Z',
  is_active: true,
};

const EMPTY: OrganizationRecord = {
  id: 1,
  name: null,
  inn: null,
  created_at: '2026-10-01T00:00:00Z',
};

const SESSION: MockResponse = { status: 200, body: USER };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * `SessionProvider` при монтировании сам ходит в `/api/me`, поэтому заглушка
 * отвечает на оба маршрута: и на профиль, и на организацию.
 */
function mountOrganization(
  organizationResponse: MockResponse,
  extra?: (url: string, init?: RequestInit) => MockResponse | null,
): ReturnType<typeof vi.fn> {
  return mockFetch((url, init) => {
    if (url.endsWith('/api/me')) return SESSION;
    if (url.endsWith('/api/organization')) {
      const handled = extra?.(url, init);
      if (handled) return handled;
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { name: string; inn: string };
        return {
          status: 200,
          body: {
            ...EMPTY,
            name: body.name || null,
            inn: body.inn || null,
          },
        };
      }
      return organizationResponse;
    }
    return { status: 404, body: { detail: 'Не найдено' } };
  });
}

describe('страница организации', () => {
  it('показывает пустую форму для незаполненной организации', async () => {
    mountOrganization({ status: 200, body: EMPTY });
    renderApp('/cabinet/organization');

    // Ждём именно поле формы: контейнер страницы есть в разметке с первого
    // рендера, поэтому по нему загрузку не отличить от готовности.
    expect(await screen.findByTestId('organization-name')).toHaveValue('');
    expect(screen.getByTestId('organization-page')).toHaveTextContent('Организация');
    expect(screen.getByTestId('organization-inn')).toHaveValue('');
    expect(screen.getByLabelText('Название организации')).toBeInTheDocument();
    expect(screen.getByLabelText('ИНН')).toBeInTheDocument();
  });

  it('сохраняет название и ИНН и показывает успех', async () => {
    const fetchMock = mountOrganization({ status: 200, body: EMPTY });
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await user.type(await screen.findByTestId('organization-name'), 'ООО Ромашка');
    await user.type(screen.getByTestId('organization-inn'), '7701234567');
    await user.click(screen.getByTestId('organization-submit'));

    expect(await screen.findByTestId('organization-save-success')).toHaveTextContent(
      'Изменения сохранены',
    );
    const patch = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/api/organization') && init?.method === 'PATCH',
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      name: 'ООО Ромашка',
      inn: '7701234567',
    });
    expect(screen.getByTestId('organization-name')).toHaveValue('ООО Ромашка');
  });

  it('показывает сохранённые значения после перезагрузки страницы', async () => {
    const saved: OrganizationRecord = { ...EMPTY, name: 'ООО Ромашка', inn: '7701234567' };
    mountOrganization({ status: 200, body: saved });
    renderApp('/cabinet/organization');

    expect(await screen.findByTestId('organization-name')).toHaveValue('ООО Ромашка');
    expect(screen.getByTestId('organization-inn')).toHaveValue('7701234567');
  });

  it('показывает текст ошибки сервера на некорректный ИНН', async () => {
    mountOrganization({ status: 200, body: EMPTY }, (_url, init) =>
      init?.method === 'PATCH'
        ? { status: 422, body: { detail: 'ИНН должен состоять из 10 или 12 цифр' } }
        : null,
    );
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await user.type(await screen.findByTestId('organization-name'), 'ООО Ромашка');
    await user.type(screen.getByTestId('organization-inn'), '12345');
    await user.click(screen.getByTestId('organization-submit'));

    expect(await screen.findByTestId('organization-save-error')).toHaveTextContent(
      'ИНН должен состоять из 10 или 12 цифр',
    );
    expect(screen.queryByTestId('organization-save-success')).not.toBeInTheDocument();
  });

  it('показывает 409 при занятом ИНН', async () => {
    mountOrganization({ status: 200, body: EMPTY }, (_url, init) =>
      init?.method === 'PATCH'
        ? { status: 409, body: { detail: 'Организация с таким ИНН уже есть' } }
        : null,
    );
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await user.type(await screen.findByTestId('organization-name'), 'ООО Ромашка');
    await user.type(screen.getByTestId('organization-inn'), '7701234567');
    await user.click(screen.getByTestId('organization-submit'));

    expect(await screen.findByTestId('organization-save-error')).toHaveTextContent(
      'Организация с таким ИНН уже есть',
    );
  });

  it('вместо формы выводит сообщение, если пользователь не привязан к организации', async () => {
    mountOrganization({ status: 404, body: { detail: 'Организация не найдена' } });
    renderApp('/cabinet/organization');

    expect(await screen.findByTestId('organization-not-linked')).toHaveTextContent(
      'не привязана к организации',
    );
    expect(screen.queryByTestId('organization-name')).not.toBeInTheDocument();
    expect(screen.queryByTestId('organization-submit')).not.toBeInTheDocument();
  });

  it('даёт повторить загрузку после сбоя', async () => {
    let gets = 0;
    mountOrganization({ status: 200, body: EMPTY }, (_url, init) => {
      if (init?.method === 'PATCH') return null;
      gets += 1;
      return gets === 1 ? { status: 500, body: { detail: 'Сбой' } } : null;
    });
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    expect(await screen.findByTestId('organization-error')).toHaveTextContent(
      'Не удалось загрузить данные организации',
    );
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByTestId('organization-name')).toBeInTheDocument();
  });

  it('отправляет форму один раз, пока идёт сохранение', async () => {
    let resolveSave!: (value: OrganizationRecord) => void;
    const fetchMock = mockFetch((url, init) => {
      if (url.endsWith('/api/me')) return SESSION;
      if (init?.method === 'PATCH') throw new Error('перехвачено spy');
      return { status: 200, body: EMPTY };
    });
    const save = vi.spyOn(api, 'saveOrganization').mockImplementation(
      () =>
        new Promise<OrganizationRecord>((done) => {
          resolveSave = done;
        }),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await user.type(await screen.findByTestId('organization-name'), 'ООО Ромашка');
    await user.click(screen.getByTestId('organization-submit'));
    await waitFor(() => expect(screen.getByTestId('organization-submit')).toBeDisabled());
    await user.click(screen.getByTestId('organization-submit'));

    expect(save).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);

    resolveSave({ ...EMPTY, name: 'ООО Ромашка' });
    expect(await screen.findByTestId('organization-save-success')).toBeInTheDocument();
  });
});

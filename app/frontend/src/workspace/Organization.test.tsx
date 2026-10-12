import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api/client';
import type { Organization as OrganizationRecord, OrganizationLookup } from '../api/client';
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
  kpp: null,
  ogrn: null,
  address: null,
  created_at: '2026-10-01T00:00:00Z',
};

/** Организация, какой она приходит с сервера после сохранения реквизитов. */
const SAVED: OrganizationRecord = {
  ...EMPTY,
  name: 'ПАО СБЕРБАНК',
  inn: '7707083893',
  kpp: '773601001',
  ogrn: '1027700132195',
  address: '117312, г Москва, ул Вавилова, д 19',
};

const FOUND: OrganizationLookup = {
  found: true,
  reason: null,
  details: {
    name: 'ПАО СБЕРБАНК',
    kpp: '773601001',
    ogrn: '1027700132195',
    address: '117312, г Москва, ул Вавилова, д 19',
  },
};

/** Ответ DaData по ИНН индивидуального предпринимателя: КПП не бывает. */
const FOUND_ENTREPRENEUR: OrganizationLookup = {
  found: true,
  reason: null,
  details: {
    name: 'ИП Иванов И.И.',
    kpp: null,
    ogrn: '304500116000157',
    address: '140000, Московская обл, г Люберцы',
  },
};

const SESSION: MockResponse = { status: 200, body: USER };

interface MountOptions {
  /** Ответ ручки поиска. По умолчанию организация находится. */
  lookup?: MockResponse;
  /** Перехват `PATCH /api/organization` и повторных `GET`, идёт перед общим ответом. */
  extra?: (url: string, init?: RequestInit) => MockResponse | null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * `SessionProvider` при монтировании сам ходит в `/api/me`, поэтому заглушка
 * отвечает на все три маршрута: профиль, организацию и поиск по ИНН.
 */
function mountOrganization(
  organizationResponse: MockResponse,
  options: MountOptions = {},
): ReturnType<typeof vi.fn> {
  return mockFetch((url, init) => {
    if (url.endsWith('/api/me')) return SESSION;
    if (url.includes('/api/organization/lookup')) {
      return options.lookup ?? { status: 200, body: FOUND };
    }
    if (url.endsWith('/api/organization')) {
      const handled = options.extra?.(url, init);
      if (handled) return handled;
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Partial<OrganizationRecord>;
        return { status: 200, body: { ...EMPTY, ...body } };
      }
      return organizationResponse;
    }
    return { status: 404, body: { detail: 'Не найдено' } };
  });
}

function lookupCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes('/lookup'));
}

/** Ввод ИНН и уход фокуса с поля: поиск запускается именно по `blur`. */
async function typeInnAndBlur(user: ReturnType<typeof userEvent.setup>, value: string) {
  const inn = await screen.findByTestId('organization-inn');
  await user.clear(inn);
  await user.type(inn, value);
  await user.tab();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('страница организации', () => {
  it('редактирует только ИНН, остальные поля недоступны', async () => {
    mountOrganization({ status: 200, body: SAVED });
    renderApp('/cabinet/organization');

    expect(await screen.findByTestId('organization-inn')).toHaveValue('7707083893');
    expect(screen.getByTestId('organization-inn')).toBeEnabled();
    expect(screen.getByTestId('organization-name')).toBeDisabled();
    expect(screen.getByTestId('organization-name')).toHaveValue('ПАО СБЕРБАНК');
    expect(screen.getByTestId('organization-kpp')).toBeDisabled();
    expect(screen.getByTestId('organization-ogrn')).toBeDisabled();
    expect(screen.getByTestId('organization-address')).toBeDisabled();
    expect(screen.getByLabelText('Адрес регистрации')).toBeInTheDocument();
  });

  it('показывает пустую форму для незаполненной организации', async () => {
    mountOrganization({ status: 200, body: EMPTY });
    renderApp('/cabinet/organization');

    // Ждём именно поле формы: контейнер страницы есть в разметке с первого
    // рендера, поэтому по нему загрузку не отличить от готовности.
    expect(await screen.findByTestId('organization-name')).toHaveValue('');
    expect(screen.getByTestId('organization-page')).toHaveTextContent('Организация');
    expect(screen.getByTestId('organization-inn')).toHaveValue('');
    expect(screen.getByTestId('organization-kpp')).toHaveValue('');
    expect(screen.getByTestId('organization-ogrn')).toHaveValue('');
    expect(screen.getByTestId('organization-address')).toHaveValue('');
  });

  it('заполняет название и реквизиты из DaData по ИНН', async () => {
    const fetchMock = mountOrganization({ status: 200, body: EMPTY });
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await typeInnAndBlur(user, '7707083893');

    expect(await screen.findByTestId('organization-source')).toHaveTextContent(
      'Заполнено из DaData',
    );
    expect(screen.getByTestId('organization-name')).toHaveValue('ПАО СБЕРБАНК');
    expect(screen.getByTestId('organization-kpp')).toHaveValue('773601001');
    expect(screen.getByTestId('organization-ogrn')).toHaveValue('1027700132195');
    expect(screen.getByTestId('organization-address')).toHaveValue(
      '117312, г Москва, ул Вавилова, д 19',
    );
    expect(lookupCalls(fetchMock)).toHaveLength(1);
    expect(String(lookupCalls(fetchMock)[0][0])).toContain('inn=7707083893');
  });

  it('показывает «Ищем организацию…», пока идёт поиск', async () => {
    const pending = deferred<OrganizationLookup>();
    vi.spyOn(api, 'lookupOrganization').mockImplementation(() => pending.promise);
    mountOrganization({ status: 200, body: EMPTY });
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await typeInnAndBlur(user, '7707083893');

    expect(await screen.findByTestId('organization-lookup-status')).toHaveTextContent(
      'Ищем организацию…',
    );
    pending.resolve(FOUND);
    expect(await screen.findByTestId('organization-source')).toHaveTextContent(
      'Заполнено из DaData',
    );
    expect(screen.queryByTestId('organization-lookup-status')).not.toBeInTheDocument();
  });

  it('не падает, когда у индивидуального предпринимателя КПП пустой', async () => {
    mountOrganization(
      { status: 200, body: EMPTY },
      { lookup: { status: 200, body: FOUND_ENTREPRENEUR } },
    );
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await typeInnAndBlur(user, '500100732259');

    expect(await screen.findByTestId('organization-source')).toBeInTheDocument();
    expect(screen.getByTestId('organization-name')).toHaveValue('ИП Иванов И.И.');
    expect(screen.getByTestId('organization-kpp')).toHaveValue('');
    expect(screen.getByTestId('organization-ogrn')).toHaveValue('304500116000157');
  });

  it('сообщает, что по ИНН ничего не найдено, и оставляет сохранение доступным', async () => {
    mountOrganization(
      { status: 200, body: EMPTY },
      { lookup: { status: 200, body: { found: false, reason: 'not_found', details: null } } },
    );
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await typeInnAndBlur(user, '7707083890');

    expect(await screen.findByTestId('organization-lookup-error')).toHaveTextContent(
      'По этому ИНН ничего не найдено',
    );
    expect(screen.getByTestId('organization-name')).toHaveValue('');
    expect(screen.getByTestId('organization-kpp')).toHaveValue('');
    expect(screen.getByTestId('organization-submit')).toBeEnabled();
  });

  it('сообщает о недоступном сервисе проверки', async () => {
    mountOrganization(
      { status: 200, body: EMPTY },
      { lookup: { status: 200, body: { found: false, reason: 'unavailable', details: null } } },
    );
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await typeInnAndBlur(user, '7707083893');

    expect(await screen.findByTestId('organization-lookup-error')).toHaveTextContent(
      'Сервис проверки недоступен. Проверьте ИНН и попробуйте снова.',
    );
    expect(screen.getByTestId('organization-name')).toHaveValue('');
    expect(screen.getByTestId('organization-submit')).toBeEnabled();
  });

  it('не ищет повторно то же значение и не ищет на неполный ИНН', async () => {
    const fetchMock = mountOrganization({ status: 200, body: EMPTY });
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    const inn = await screen.findByTestId('organization-inn');
    await typeInnAndBlur(user, '500100732');
    expect(lookupCalls(fetchMock)).toHaveLength(0);

    await typeInnAndBlur(user, '7707083893');
    expect(lookupCalls(fetchMock)).toHaveLength(1);

    // Тот же ИНН, но фокус заходил и уходил: второй запрос не уходит.
    await user.click(inn);
    await user.tab();
    expect(lookupCalls(fetchMock)).toHaveLength(1);
  });

  it('отправляет сохранение с пятью полями', async () => {
    const fetchMock = mountOrganization({ status: 200, body: EMPTY });
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await typeInnAndBlur(user, '7707083893');
    await screen.findByTestId('organization-source');
    await user.click(screen.getByTestId('organization-submit'));

    expect(await screen.findByTestId('organization-save-success')).toHaveTextContent(
      'Изменения сохранены',
    );
    const patch = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/api/organization') && init?.method === 'PATCH',
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      name: 'ПАО СБЕРБАНК',
      inn: '7707083893',
      kpp: '773601001',
      ogrn: '1027700132195',
      address: '117312, г Москва, ул Вавилова, д 19',
    });
  });

  it('показывает сохранённые значения после перезагрузки страницы', async () => {
    mountOrganization({ status: 200, body: SAVED });
    renderApp('/cabinet/organization');

    expect(await screen.findByTestId('organization-name')).toHaveValue('ПАО СБЕРБАНК');
    expect(screen.getByTestId('organization-inn')).toHaveValue('7707083893');
    expect(screen.getByTestId('organization-kpp')).toHaveValue('773601001');
    expect(screen.getByTestId('organization-ogrn')).toHaveValue('1027700132195');
    expect(screen.getByTestId('organization-address')).toHaveValue(
      '117312, г Москва, ул Вавилова, д 19',
    );
  });

  it('показывает текст ошибки 422 так, как его отдаёт FastAPI, — списком detail', async () => {
    // Тело настоящего ответа: у ошибки валидации `detail` — СПИСОК объектов,
    // а не строка. Подменять его строкой нельзя: именно на этом различии
    // пользователь вместо причины видел «Запрос не удался (422)».
    mountOrganization(
      { status: 200, body: EMPTY },
      {
        extra: (_url, init) =>
          init?.method === 'PATCH'
            ? {
                status: 422,
                body: {
                  detail: [
                    {
                      type: 'value_error',
                      loc: ['body', 'inn'],
                      msg: 'Value error, ИНН должен состоять из 10 или 12 цифр',
                      input: '12345',
                    },
                  ],
                },
              }
            : null,
      },
    );
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await user.type(await screen.findByTestId('organization-inn'), '12345');
    await user.click(screen.getByTestId('organization-submit'));

    const error = await screen.findByTestId('organization-save-error');
    expect(error).toHaveTextContent('inn: ИНН должен состоять из 10 или 12 цифр');
    expect(error).not.toHaveTextContent('Запрос не удался');
    expect(screen.queryByTestId('organization-save-success')).not.toBeInTheDocument();
  });

  it('возвращает фокус в поле ИНН после неудачного сохранения', async () => {
    mountOrganization(
      { status: 200, body: EMPTY },
      {
        extra: (_url, init) =>
          init?.method === 'PATCH'
            ? {
                status: 422,
                body: {
                  detail: [
                    { type: 'value_error', loc: ['body', 'inn'], msg: 'Value error, ИНН неверный' },
                  ],
                },
              }
            : null,
      },
    );
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await user.type(await screen.findByTestId('organization-inn'), '12345');
    await user.click(screen.getByTestId('organization-submit'));

    await screen.findByTestId('organization-save-error');
    // Поле ИНН — единственное редактируемое, и фокус возвращается туда, а не
    // остаётся на `<body>`.
    await waitFor(() => expect(screen.getByTestId('organization-inn')).toHaveFocus());
  });

  it('возвращает фокус в поле ИНН после успешного сохранения', async () => {
    mountOrganization({ status: 200, body: EMPTY });
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await typeInnAndBlur(user, '7707083893');
    await screen.findByTestId('organization-source');
    await user.click(screen.getByTestId('organization-submit'));

    await screen.findByTestId('organization-save-success');
    await waitFor(() => expect(screen.getByTestId('organization-inn')).toHaveFocus());
  });

  it('показывает 409 при занятом ИНН', async () => {
    mountOrganization(
      { status: 200, body: EMPTY },
      {
        extra: (_url, init) =>
          init?.method === 'PATCH'
            ? { status: 409, body: { detail: 'Организация с таким ИНН уже есть' } }
            : null,
      },
    );
    const user = userEvent.setup();
    renderApp('/cabinet/organization');

    await user.type(await screen.findByTestId('organization-inn'), '7707083893');
    await user.click(screen.getByTestId('organization-submit'));

    expect(await screen.findByTestId('organization-save-error')).toHaveTextContent(
      'Организация с таким ИНН уже есть',
    );
    await waitFor(() => expect(screen.getByTestId('organization-inn')).toHaveFocus());
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
    mountOrganization(
      { status: 200, body: EMPTY },
      {
        extra: (_url, init) => {
          if (init?.method === 'PATCH') return null;
          gets += 1;
          return gets === 1 ? { status: 500, body: { detail: 'Сбой' } } : null;
        },
      },
    );
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
      if (url.includes('/lookup')) return { status: 200, body: FOUND };
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

    await user.type(await screen.findByTestId('organization-inn'), '7707083893');
    await user.click(screen.getByTestId('organization-submit'));
    await waitFor(() => expect(screen.getByTestId('organization-submit')).toBeDisabled());
    await user.click(screen.getByTestId('organization-submit'));

    expect(save).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);

    resolveSave(SAVED);
    expect(await screen.findByTestId('organization-save-success')).toBeInTheDocument();
  });
});

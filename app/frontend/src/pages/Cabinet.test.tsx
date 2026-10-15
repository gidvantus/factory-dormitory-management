import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionProvider } from '../auth/SessionProvider';
import { mockFetch } from '../test/mockFetch';
import { Notifications } from '../workspace/Notifications';
import { Cabinet } from './Cabinet';

const INACTIVE = {
  email: 'worker@example.com',
  full_name: 'Иванов Иван Иванович',
  created_at: '2026-01-01T00:00:00Z',
  is_active: false,
};

/**
 * Оболочка кабинета монтируется без `RequireAuth`: неактивного туда штатно
 * не пускают, а плашка — страховка на случай смены состояния сессии.
 */
function renderCabinet(profile: typeof INACTIVE): ReturnType<typeof render> {
  mockFetch((url) =>
    url.includes('/api/me')
      ? { status: 200, body: profile }
      : { status: 404, body: { detail: 'Не найдено' } },
  );
  return render(
    <MemoryRouter initialEntries={['/cabinet']}>
      <SessionProvider>
        <Routes>
          <Route path="/cabinet" element={<Cabinet />} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('плашка активации в кабинете', () => {
  it('показывается, пока кабинет не активирован', async () => {
    renderCabinet(INACTIVE);

    expect(await screen.findByTestId('activation-banner')).toHaveTextContent(
      'Кабинет не активирован',
    );
    expect(screen.getByRole('link', { name: 'запросите письмо ещё раз' })).toHaveAttribute(
      'href',
      '/activate',
    );
  });

  it('при активированном кабинете плашки нет', async () => {
    renderCabinet({ ...INACTIVE, is_active: true });

    expect(await screen.findByTestId('cabinet-page')).toBeInTheDocument();
    expect(screen.queryByTestId('activation-banner')).not.toBeInTheDocument();
  });
});

describe('пункты меню учётной записи', () => {
  function renderCabinetAt(route: string): ReturnType<typeof render> {
    mockFetch((url) =>
      url.includes('/api/me')
        ? { status: 200, body: { ...INACTIVE, is_active: true } }
        : { status: 404, body: { detail: 'Не найдено' } },
    );
    return render(
      <MemoryRouter initialEntries={[route]}>
        <SessionProvider>
          <Routes>
            <Route path="/cabinet" element={<Cabinet />}>
              <Route path="organization" element={<p>Страница организации</p>} />
              <Route path="organization/members" element={<p>Страница сотрудников</p>} />
              <Route path="profile" element={<p>Личные данные</p>} />
            </Route>
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );
  }

  it('ставит «Организацию» выше «Личных данных» и ведёт на свой адрес', async () => {
    const user = userEvent.setup();
    renderCabinetAt('/cabinet');

    const organization = await screen.findByTestId('workspace-nav-organization');
    const profile = screen.getByTestId('workspace-nav-profile');

    expect(organization).toHaveTextContent('Организация');
    expect(organization).toHaveAttribute('href', '/cabinet/organization');
    // Порядок проверяется по разметке, а не по глазомеру: ссылка обязана идти выше.
    expect(
      organization.compareDocumentPosition(profile) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(organization);
    expect(await screen.findByText('Страница организации')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-nav-organization')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('заголовок вкладки на странице организации — «Организация — Домовой»', async () => {
    renderCabinetAt('/cabinet/organization');

    expect(await screen.findByTestId('workspace-nav-organization')).toBeInTheDocument();
    expect(document.title).toBe('Организация — Домовой');
  });

  it('ставит «Сотрудников» рядом с «Организацией» и ведёт на свой адрес', async () => {
    const user = userEvent.setup();
    renderCabinetAt('/cabinet');

    const organization = await screen.findByTestId('workspace-nav-organization');
    const members = screen.getByTestId('workspace-nav-members');

    expect(members).toHaveTextContent('Сотрудники');
    expect(members).toHaveAttribute('href', '/cabinet/organization/members');
    expect(
      organization.compareDocumentPosition(members) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(members);
    expect(await screen.findByText('Страница сотрудников')).toBeInTheDocument();
  });

  it('заголовок вкладки на странице сотрудников — «Сотрудники — Домовой»', async () => {
    renderCabinetAt('/cabinet/organization/members');

    expect(await screen.findByTestId('workspace-nav-members')).toBeInTheDocument();
    expect(document.title).toBe('Сотрудники — Домовой');
  });

  it('подсвечивает ровно один пункт меню: «Сотрудники» не подсвечивает «Организацию»', async () => {
    renderCabinetAt('/cabinet/organization/members');

    const members = await screen.findByTestId('workspace-nav-members');
    expect(members).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('workspace-nav-organization')).not.toHaveAttribute('aria-current');
  });
});

describe('пункт меню «Уведомления»', () => {
  const ACTIVE = { ...INACTIVE, is_active: true };

  /** Каталог решений: одна строка, право — по параметру. */
  function solution(isOwned: boolean): Record<string, unknown> {
    return {
      id: 7,
      code: 'telegram_notifications',
      name: 'Уведомления в Telegram',
      description: 'Сообщения о событиях, которые вас касаются',
      amount: '500.00',
      currency: 'RUB',
      period: 'month',
      price_label: '500 ₽ в месяц',
      is_owned: isOwned,
      expires_at: isOwned ? '2026-11-14T10:00:00Z' : null,
    };
  }

  function renderWithSolutions(isOwned: boolean): ReturnType<typeof render> {
    mockFetch((url) => {
      if (url.endsWith('/api/me')) return { status: 200, body: ACTIVE };
      if (url.endsWith('/api/solutions')) {
        return { status: 200, body: { items: [solution(isOwned)] } };
      }
      return { status: 404, body: { detail: 'Не найдено' } };
    });
    return render(
      <MemoryRouter initialEntries={['/cabinet']}>
        <SessionProvider>
          <Routes>
            <Route path="/cabinet" element={<Cabinet />}>
              <Route index element={<p>Обзор кабинета</p>} />
              <Route path="notifications" element={<p>Страница уведомлений</p>} />
              <Route path="shop" element={<p>Страница магазина</p>} />
            </Route>
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );
  }

  it('появляется при действующем праве организации и ведёт на свой адрес', async () => {
    const user = userEvent.setup();
    renderWithSolutions(true);

    const notifications = await screen.findByTestId('workspace-nav-notifications');
    expect(notifications).toHaveTextContent('Уведомления');
    expect(notifications).toHaveAttribute('href', '/cabinet/notifications');

    await user.click(notifications);
    expect(await screen.findByText('Страница уведомлений')).toBeInTheDocument();
  });

  it('отсутствует без права', async () => {
    // Прямой заход на адрес платной функции: экран сам сообщает, что права нет.
    // Его состояние — положительный сигнал, что каталог уже прочитан, поэтому
    // отсутствие пункта меню проверяется без гонки с загрузкой.
    render(
      <MemoryRouter initialEntries={['/cabinet/notifications']}>
        <SessionProvider>
          <Routes>
            <Route path="/cabinet" element={<Cabinet />}>
              <Route index element={<p>Обзор кабинета</p>} />
              <Route path="notifications" element={<Notifications />} />
            </Route>
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('notifications-no-solution')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-nav-notifications')).not.toBeInTheDocument();
  });

  it('«Магазин улучшений» есть всегда и ведёт на свой адрес', async () => {
    const user = userEvent.setup();
    renderWithSolutions(false);

    const shop = await screen.findByTestId('workspace-nav-shop');
    expect(shop).toHaveAttribute('href', '/cabinet/shop');

    await user.click(shop);
    expect(await screen.findByText('Страница магазина')).toBeInTheDocument();
  });

  it('ставит магазин после «Статистики», а разделы решений — после магазина', async () => {
    renderWithSolutions(true);

    await screen.findByTestId('workspace-nav-notifications');
    const order = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="workspace-nav-"]'),
    ).map((node) => node.dataset.testid);

    // Порядок чтения меню, а не порядок в разметке: позиции сравниваются по
    // документному порядку ссылок в боковой панели.
    expect(order.indexOf('workspace-nav-shop')).toBe(order.indexOf('workspace-nav-statistics') + 1);
    expect(order.indexOf('workspace-nav-notifications')).toBe(
      order.indexOf('workspace-nav-shop') + 1,
    );
  });
});

describe('закрытый кабинет и пробный период', () => {
  const ACTIVE = { ...INACTIVE, is_active: true };

  const LOCKED_TRIAL = {
    ends_at: '2026-10-01T00:00:00Z',
    days_left: 0,
    is_active: false,
    locked: true,
    member_limit: 3,
  };

  /** Закрытый кабинет: `/api/trial` сообщает `locked: true`. */
  function renderLocked(route: string): ReturnType<typeof render> {
    mockFetch((url) => {
      if (url.endsWith('/api/me')) return { status: 200, body: ACTIVE };
      if (url.endsWith('/api/trial')) return { status: 200, body: LOCKED_TRIAL };
      return { status: 404, body: { detail: 'Не найдено' } };
    });
    return render(
      <MemoryRouter initialEntries={[route]}>
        <SessionProvider>
          <Routes>
            <Route path="/cabinet" element={<Cabinet />}>
              <Route index element={<p>Обзор кабинета</p>} />
              <Route path="dormitories" element={<p>Страница общежитий</p>} />
              <Route path="organization" element={<p>Страница организации</p>} />
              <Route path="organization/members" element={<p>Страница сотрудников</p>} />
              <Route path="tariffs" element={<p>Страница тарифа</p>} />
            </Route>
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );
  }

  it('помечает рабочие пункты меню недоступными, а разделы аккаунта оставляет', async () => {
    renderLocked('/cabinet');

    for (const testId of [
      'workspace-nav-dormitories',
      'workspace-nav-personnel',
      'workspace-nav-statistics',
      'workspace-nav-members',
    ]) {
      const link = await screen.findByTestId(testId);
      expect(link).toHaveAttribute('aria-disabled', 'true');
      expect(link).toHaveAttribute('tabindex', '-1');
    }

    for (const testId of [
      'workspace-nav-overview',
      'workspace-nav-tariffs',
      'workspace-nav-shop',
      'workspace-nav-documents',
      'workspace-nav-organization',
      'workspace-nav-profile',
    ]) {
      expect(screen.getByTestId(testId)).not.toHaveAttribute('aria-disabled');
    }
  });

  it('не уводит с обзора по клику на закрытый раздел', async () => {
    const user = userEvent.setup();
    renderLocked('/cabinet');

    const dormitories = await screen.findByTestId('workspace-nav-dormitories');
    await user.click(dormitories);

    expect(screen.getByText('Обзор кабинета')).toBeInTheDocument();
    expect(screen.queryByText('Страница общежитий')).not.toBeInTheDocument();
  });

  it('возвращает на обзор при прямом заходе на закрытый адрес', async () => {
    renderLocked('/cabinet/dormitories');

    expect(await screen.findByText('Обзор кабинета')).toBeInTheDocument();
    expect(screen.queryByText('Страница общежитий')).not.toBeInTheDocument();
  });

  it('возвращает на обзор и со страницы сотрудников', async () => {
    renderLocked('/cabinet/organization/members');

    expect(await screen.findByText('Обзор кабинета')).toBeInTheDocument();
    expect(screen.queryByText('Страница сотрудников')).not.toBeInTheDocument();
  });

  it('оставляет открытыми тариф и организацию', async () => {
    const user = userEvent.setup();
    renderLocked('/cabinet');

    await user.click(await screen.findByTestId('workspace-nav-tariffs'));
    expect(await screen.findByText('Страница тарифа')).toBeInTheDocument();

    await user.click(screen.getByTestId('workspace-nav-organization'));
    expect(await screen.findByText('Страница организации')).toBeInTheDocument();
  });
});

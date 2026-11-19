import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { anonymousSession, mockFetch } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

afterEach(() => {
  vi.unstubAllGlobals();
  // «Принять» поднимает счётчик Метрики и оставляет его `<script>` в документе;
  // для теста плашки это шум, который не должен переезжать в следующий тест.
  for (const script of document.querySelectorAll('script[src*="mc.yandex.ru"]')) {
    script.remove();
  }
  delete window.ym;
});

describe('плашка согласия на cookie', () => {
  it('видна на первом визите и ссылается на политику конфиденциальности', async () => {
    mockFetch(() => anonymousSession());
    renderApp('/');

    const consent = await screen.findByTestId('cookie-consent');
    expect(consent).toHaveAttribute('role', 'region');
    expect(screen.getByTestId('cookie-consent-text')).toHaveTextContent('Мы используем cookie');
    // Текст плашки — та редакция, под которой собирают согласие `v2`: об
    // аналитике сказано прямо, и загрузка счётчика обещана только после «Принять».
    expect(screen.getByTestId('cookie-consent-text')).toHaveTextContent('Яндекс.Метрику');
    expect(screen.getByTestId('cookie-consent-text')).toHaveTextContent('только после нажатия');
    expect(screen.getByTestId('cookie-consent-policy')).toHaveAttribute(
      'href',
      '/documents/privacy-policy',
    );
    // Плашка немодальная: на лендинге диалогового окна нет.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('принятие убирает плашку и запоминает текущую версию согласия', async () => {
    mockFetch(() => anonymousSession());
    const user = userEvent.setup();
    renderApp('/');

    await user.click(await screen.findByTestId('cookie-consent-accept'));

    expect(screen.queryByTestId('cookie-consent')).not.toBeInTheDocument();
    expect(document.cookie).toContain('domovoy_cookie_consent=v2');
  });

  it('сохранённое согласие не показывает плашку', async () => {
    mockFetch(() => anonymousSession());
    document.cookie = 'domovoy_cookie_consent=v2; path=/';

    renderApp('/cabinet');

    // Ждём, пока анонимного посетителя кабинета отправят на лендинг.
    expect(await screen.findByTestId('landing')).toBeInTheDocument();
    expect(screen.queryByTestId('cookie-consent')).not.toBeInTheDocument();
  });

  it('прежнее согласие v1 показывается снова: текст сменился', async () => {
    mockFetch(() => anonymousSession());
    document.cookie = 'domovoy_cookie_consent=v1; path=/';

    renderApp('/');

    expect(await screen.findByTestId('cookie-consent')).toBeInTheDocument();
  });
});

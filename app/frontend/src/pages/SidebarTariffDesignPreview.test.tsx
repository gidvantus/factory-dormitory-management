import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockFetch } from '../test/mockFetch';
import { SidebarTariffDesignPreview } from './SidebarTariffDesignPreview';

const CSS = readFileSync(
  join(resolve(process.cwd(), 'src'), 'pages', 'SidebarTariffDesignPreview.module.css'),
  'utf8',
);

/** Тело правила по точному селектору; пустая строка, если правила нет. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm');
  return [...css.matchAll(re)][0]?.[1] ?? '';
}

function renderPreview(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/preview/sidebar-tariff']}>
      <SidebarTariffDesignPreview />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('примерочная карточки тарифа в панели', () => {
  it('открывается без сети: данные макета — константы страницы', () => {
    // Любой запрос уронил бы тест: подмены нет, а `fetch` в jsdom отсутствует.
    const fetchMock = mockFetch(() => ({ status: 500, body: { detail: 'Сеть не нужна' } }));

    renderPreview();

    expect(screen.getByTestId('sidebar-tariff-design-preview')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.title).toBe('Тариф в левой панели — Домовой');
  });

  it('показывает карточку в панели кабинета, а не в пустоте', () => {
    renderPreview();

    const sidebar = screen.getByRole('complementary', { name: 'Боковая панель кабинета' });

    expect(within(sidebar).getByTestId('sidebar-tariff')).toBeInTheDocument();
    expect(within(sidebar).getByText('Домовой')).toBeInTheDocument();
    expect(within(sidebar).getByTestId('sidebar-tariff-ends')).toHaveTextContent(
      'Оплачен до 02.12.2026',
    );
  });

  it('переключает четыре состояния карточки', async () => {
    const user = userEvent.setup();
    renderPreview();

    const card = screen.getByTestId('sidebar-tariff');

    expect(card).toHaveAttribute('data-access', 'paid');

    await user.click(screen.getByRole('button', { name: 'Осталось 5 дней' }));
    expect(screen.getByTestId('sidebar-tariff')).toHaveAttribute('data-state', 'expiring');
    expect(screen.getByTestId('sidebar-tariff-link')).toHaveTextContent('Продлить тариф');

    await user.click(screen.getByRole('button', { name: 'Пробный идёт' }));
    expect(screen.getByTestId('sidebar-tariff')).toHaveAttribute('data-access', 'trial');
    expect(screen.getByTestId('sidebar-tariff-trial-days')).toHaveTextContent(
      'осталось 29 дней, до 01.12.2026',
    );

    await user.click(screen.getByRole('button', { name: 'Кабинет закрыт' }));
    expect(screen.getByTestId('sidebar-tariff')).toHaveAttribute('data-access', 'locked');
    expect(screen.getByTestId('sidebar-tariff')).toHaveTextContent('Доступ закрыт');

    await user.click(screen.getByRole('button', { name: 'Куплен со сроком' }));
    expect(screen.getByTestId('sidebar-tariff')).toHaveAttribute('data-access', 'paid');
    expect(screen.getByTestId('sidebar-tariff-name')).toHaveTextContent('Рост');
  });

  it('показывает панель на 220 px, чтобы видеть перенос названия и даты', async () => {
    const user = userEvent.setup();
    renderPreview();

    const frame = screen
      .getByRole('complementary', { name: 'Боковая панель кабинета' })
      .closest('[data-width]');

    expect(frame).toHaveAttribute('data-width', 'wide');

    await user.click(screen.getByRole('button', { name: '220 px' }));

    expect(
      screen
        .getByRole('complementary', { name: 'Боковая панель кабинета' })
        .closest('[data-width]'),
    ).toHaveAttribute('data-width', 'narrow');
  });

  it('держит кадр панели не ниже 800 px и не фиксирует высоту', () => {
    // jsdom не считает геометрию, поэтому правило проверяется текстом — как в
    // `SidebarTariff.layout.test.ts` (замечание тестировщика Ф1 по #124).
    //
    // Фиксированные 620 px сжимали список разделов до подписи (nav 20 px из
    // 317 px): пять пунктов меню уезжали за край, и «панель в реальном каркасе»
    // не показывала каркаса. 800 px — нижняя граница из макета, выше панель
    // растёт по содержимому, поэтому меню и аккаунт видны целиком.
    const frame = ruleBody(CSS, '.page .frame > aside');
    expect(frame).toContain('min-height: 800px');
    expect(frame).toContain('height: auto');
    expect(frame).not.toMatch(/(?:^|\s)height:\s*\d+(?:\.\d+)?px/);
  });
});

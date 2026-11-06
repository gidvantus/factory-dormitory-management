import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { CompanyDetails } from './CompanyDetails';
import { OperatorContext } from '../auth/operatorContext';
import { mockFetch } from '../test/mockFetch';
import type { MockStep } from '../test/mockFetch';

/** Строка реквизитов в форме ответа кабинета: поля ровно по контракту постановки. */
const DETAILS = {
  id: 1,
  name: 'ООО «Домовой»',
  inn: '7701234567',
  kpp: '770101001',
  ogrn: '1237700123456',
  address: '127254, г. Москва, ул. Руставели, д. 14',
  bank_name: 'АО «Банк»',
  bank_bic: '044525225',
  bank_account: '40702810000000000123',
  corr_account: '30101810400000000225',
  signatory: 'Генеральный директор И. И. Иванов',
  vat_note: 'НДС не облагается',
  updated_at: '2026-11-06T01:00:00',
};

/** Пустая база: основной API отдаёт `200` со всеми `null`, а не `404`. */
const EMPTY_DETAILS = {
  id: 1,
  name: null,
  inn: null,
  kpp: null,
  ogrn: null,
  address: null,
  bank_name: null,
  bank_bic: null,
  bank_account: null,
  corr_account: null,
  signatory: null,
  vat_note: null,
  updated_at: null,
};

/** Тело правки по контракту: все одиннадцать полей, пустое — `null`. */
const EMPTY_PAYLOAD = {
  name: null,
  inn: null,
  kpp: null,
  ogrn: null,
  address: null,
  bank_name: null,
  bank_bic: null,
  bank_account: null,
  corr_account: null,
  signatory: null,
  vat_note: null,
};

/** Раздел в настоящем роутере: навигация и проверка сессии — часть экрана. */
function renderCompany(steps: MockStep[]) {
  const network = mockFetch(steps);
  render(
    <OperatorContext.Provider value={{ username: 'operator' }}>
      <MemoryRouter initialEntries={['/company']}>
        <Routes>
          <Route path="/company" element={<CompanyDetails />} />
        </Routes>
      </MemoryRouter>
    </OperatorContext.Provider>,
  );
  return network;
}

/** Открыть раздел и дождаться формы: загрузка проверяется отдельным тестом. */
async function renderLoaded(steps: MockStep[]) {
  const network = renderCompany(steps);
  await screen.findByTestId('operator-company');
  return network;
}

/** Тела запросов указанного метода, ушедших на сервер. */
function bodies(
  network: { calls: { url: string; init: RequestInit }[] },
  method: string,
): string[] {
  return network.calls
    .filter((call) => call.init.method === method)
    .map((call) => String(call.init.body));
}

describe('реквизиты поставщика в кабинете оператора', () => {
  it('показывает одиннадцать полей с подписями и значения из ответа', async () => {
    const network = await renderLoaded([{ status: 200, body: DETAILS }]);

    expect(network.calls[0].url).toBe('/api/company-details');
    expect(network.calls[0].init.credentials).toBe('include');

    expect(screen.getByLabelText('Название')).toHaveValue('ООО «Домовой»');
    expect(screen.getByTestId('operator-company-inn')).toHaveValue('7701234567');
    expect(screen.getByTestId('operator-company-kpp')).toHaveValue('770101001');
    expect(screen.getByTestId('operator-company-ogrn')).toHaveValue('1237700123456');
    expect(screen.getByTestId('operator-company-address')).toHaveValue(
      '127254, г. Москва, ул. Руставели, д. 14',
    );
    expect(screen.getByTestId('operator-company-bank-name')).toHaveValue('АО «Банк»');
    expect(screen.getByTestId('operator-company-bank-bic')).toHaveValue('044525225');
    expect(screen.getByTestId('operator-company-account')).toHaveValue('40702810000000000123');
    expect(screen.getByTestId('operator-company-corr-account')).toHaveValue('30101810400000000225');
    expect(screen.getByTestId('operator-company-signatory')).toHaveValue(
      'Генеральный директор И. И. Иванов',
    );
    expect(screen.getByTestId('operator-company-vat-note')).toHaveValue('НДС не облагается');

    // У каждого поля своя подпись: скринридер читает «ИНН», а не «поле ввода».
    for (const label of [
      'Название',
      'ИНН',
      'КПП',
      'ОГРН',
      'Адрес',
      'Банк',
      'БИК',
      'Расчётный счёт',
      'Корреспондентский счёт',
      'Подписант',
      'Строка про НДС',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it('пустая база — пустая форма, а не ошибка и не прочерки', async () => {
    await renderLoaded([{ status: 200, body: EMPTY_DETAILS }]);

    expect(screen.getByTestId('operator-company-name')).toHaveValue('');
    expect(screen.getByTestId('operator-company-inn')).toHaveValue('');
    expect(screen.getByTestId('operator-company-vat-note')).toHaveValue('');
    expect(screen.queryByTestId('operator-company-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('operator-company-save')).toBeEnabled();
  });

  it('во время загрузки показывает «Загружаем реквизиты…»', () => {
    renderCompany([{ status: 200, body: DETAILS }]);

    const state = screen.getByRole('status');
    expect(state).toHaveTextContent('Загружаем реквизиты…');
    expect(screen.queryByTestId('operator-company')).not.toBeInTheDocument();
  });

  it('ошибку загрузки показывает дословно и повторяет запрос по «Повторить»', async () => {
    const network = renderCompany([
      { status: 502, body: { detail: 'Основной API недоступен' } },
      { status: 200, body: DETAILS },
    ]);
    const user = userEvent.setup();

    const error = await screen.findByTestId('operator-company-error');
    expect(error).toHaveTextContent(/^Основной API недоступен$/);
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('operator-company')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('operator-company-retry'));

    expect(await screen.findByTestId('operator-company')).toBeInTheDocument();
    expect(screen.getByTestId('operator-company-name')).toHaveValue('ООО «Домовой»');
    expect(network.calls).toHaveLength(2);
    expect(network.calls[1].url).toBe('/api/company-details');
  });

  it('404 «Реквизиты поставщика не заведены» — это тоже отказ загрузки', async () => {
    renderCompany([{ status: 404, body: { detail: 'Реквизиты поставщика не заведены' } }]);

    expect(await screen.findByTestId('operator-company-error')).toHaveTextContent(
      'Реквизиты поставщика не заведены',
    );
    expect(screen.getByTestId('operator-company-retry')).toBeInTheDocument();
  });

  it('сохранение отправляет все одиннадцать полей и показывает «Сохранено»', async () => {
    const network = await renderLoaded([
      { status: 200, body: EMPTY_DETAILS },
      { status: 200, body: { ...DETAILS } },
    ]);
    const user = userEvent.setup();

    await user.type(screen.getByTestId('operator-company-name'), 'ООО «Домовой»');
    await user.type(screen.getByTestId('operator-company-inn'), '7701234567');
    await user.type(screen.getByTestId('operator-company-vat-note'), 'НДС не облагается');
    await user.click(screen.getByTestId('operator-company-save'));

    expect(await screen.findByTestId('operator-company-saved')).toHaveTextContent('Сохранено');
    expect(screen.getByTestId('operator-company-name')).toHaveValue('ООО «Домовой»');

    const [patch] = bodies(network, 'PATCH');
    expect(JSON.parse(patch)).toEqual({
      ...EMPTY_PAYLOAD,
      name: 'ООО «Домовой»',
      inn: '7701234567',
      vat_note: 'НДС не облагается',
    });
  });

  it('пустое поле уходит как null: очистка поля — это PATCH с null', async () => {
    const network = await renderLoaded([
      { status: 200, body: DETAILS },
      { status: 200, body: EMPTY_DETAILS },
    ]);
    const user = userEvent.setup();

    await user.clear(screen.getByTestId('operator-company-inn'));
    await user.clear(screen.getByTestId('operator-company-vat-note'));
    await user.click(screen.getByTestId('operator-company-save'));

    await screen.findByTestId('operator-company-saved');
    const [patch] = bodies(network, 'PATCH');
    expect(JSON.parse(patch)).toMatchObject({ inn: null, vat_note: null, name: 'ООО «Домовой»' });
    // Форма перерисована ответом сервера: очищенные поля пусты.
    expect(screen.getByTestId('operator-company-inn')).toHaveValue('');
  });

  it('422 показывает текст основного API дословно, не сбрасывая введённое', async () => {
    await renderLoaded([
      { status: 200, body: EMPTY_DETAILS },
      {
        status: 422,
        body: {
          detail: [
            {
              type: 'value_error',
              loc: ['body', 'inn'],
              msg: 'Value error, ИНН должен состоять из 10 или 12 цифр',
            },
          ],
        },
      },
    ]);
    const user = userEvent.setup();

    await user.type(screen.getByTestId('operator-company-inn'), '77012345678');
    await user.click(screen.getByTestId('operator-company-save'));

    const error = await screen.findByTestId('operator-company-error');
    expect(error).toHaveTextContent(/^ИНН должен состоять из 10 или 12 цифр$/);
    expect(error).toHaveAttribute('role', 'alert');
    // Введённое остаётся в поле: правку можно исправить и отправить снова.
    expect(screen.getByTestId('operator-company-inn')).toHaveValue('77012345678');
    expect(screen.getByTestId('operator-company-inn')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByTestId('operator-company-saved')).not.toBeInTheDocument();
  });

  it('отказ сети без detail показывает общий текст', async () => {
    await renderLoaded([{ status: 200, body: EMPTY_DETAILS }, { reject: true }]);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-company-save'));

    expect(await screen.findByTestId('operator-company-error')).toHaveTextContent(
      'Не удалось сохранить реквизиты',
    );
  });

  it('на отправке кнопка неактивна и говорит «Сохраняем…»', async () => {
    let release: (response: { status: number; body: unknown }) => void = () => undefined;
    const pending = new Promise<{ status: number; body: unknown }>((resolve) => {
      release = resolve;
    });
    await renderLoaded([{ status: 200, body: EMPTY_DETAILS }, () => pending]);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-company-save'));

    const save = screen.getByTestId('operator-company-save');
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent('Сохраняем…');
    expect(save).toHaveAttribute('aria-busy', 'true');

    release({ status: 200, body: DETAILS });
    expect(await screen.findByTestId('operator-company-saved')).toBeInTheDocument();
    expect(screen.getByTestId('operator-company-save')).toBeEnabled();
  });

  it('«Реквизиты» — активный раздел навигации на /company', async () => {
    await renderLoaded([{ status: 200, body: DETAILS }]);

    expect(screen.getByTestId('operator-nav-company')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('operator-nav-organizations')).not.toHaveAttribute('aria-current');
  });

  it('«Сохранено» гаснет, когда поле снова правят', async () => {
    await renderLoaded([
      { status: 200, body: EMPTY_DETAILS },
      { status: 200, body: DETAILS },
    ]);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-company-save'));
    await screen.findByTestId('operator-company-saved');

    await user.type(screen.getByTestId('operator-company-inn'), '77');

    expect(screen.queryByTestId('operator-company-saved')).not.toBeInTheDocument();
  });

  it('форма не подменяет пустые поля прочерком', async () => {
    await renderLoaded([{ status: 200, body: EMPTY_DETAILS }]);

    expect(screen.getByTestId('operator-company-bank-name')).toHaveValue('');
    expect(screen.getByTestId('operator-company-signatory')).toHaveValue('');
    // Внутри формы нет «—»: прочерк — это утверждение, а не пустое значение.
    expect(within(screen.getByTestId('operator-company')).queryByText('—')).not.toBeInTheDocument();
  });
});

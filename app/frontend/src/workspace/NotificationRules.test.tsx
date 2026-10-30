import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockFetch } from '../test/mockFetch';
import type { MockResponse } from '../test/mockFetch';
import { NotificationRules } from './NotificationRules';

const DORMITORIES = [
  { id: 1, name: 'Общежитие №1 на Заводской', client_name: '', is_archived: false },
  { id: 2, name: 'Общежитие №2 на Строителей', client_name: '', is_archived: false },
  { id: 3, name: 'Архивное общежитие', client_name: '', is_archived: true },
];

const CATALOG = {
  tables: [
    {
      key: 'residents',
      title: 'Проживающие',
      columns: [
        {
          id: 11,
          name: 'Дата заселения',
          kind: 'date',
          operators: ['equals', 'not_equals', 'greater', 'less', 'not_empty', 'is_empty'],
        },
        {
          id: 12,
          name: 'Пол',
          kind: 'select',
          operators: ['equals', 'not_equals', 'not_empty', 'is_empty'],
        },
        {
          id: 13,
          name: 'ФИО',
          kind: 'text',
          operators: ['equals', 'not_equals', 'not_empty', 'is_empty'],
        },
        {
          id: 14,
          name: 'Готов к заселению',
          kind: 'checkbox',
          operators: ['equals', 'not_empty', 'is_empty'],
        },
      ],
    },
    {
      key: 'custom_5',
      title: 'Вахтовый график',
      columns: [
        {
          id: 21,
          name: 'Кол-во смен',
          kind: 'number',
          operators: ['equals', 'not_equals', 'greater', 'less', 'not_empty', 'is_empty'],
        },
      ],
    },
  ],
};

/** Столбцы таблицы с вариантами списка: каталог вариантов не отдаёт. */
const RESIDENT_COLUMNS = [
  {
    id: 12,
    table_key: 'residents',
    builtin_key: 'gender',
    name: 'Пол',
    kind: 'select',
    position: 1,
    archived: false,
    options: [
      { id: 'male', label: 'Мужской', archived: false },
      { id: 'female', label: 'Женский', archived: false },
    ],
  },
];

const RULE = {
  id: 12,
  name: 'Новое заселение',
  table_key: 'residents',
  table_title: 'Проживающие',
  is_enabled: true,
  conditions: [{ column_id: 12, operator: 'equals', value: 'male' }],
  broken: false,
};

const BROKEN_RULE = {
  id: 14,
  name: 'Медосмотр просрочен',
  table_key: 'custom_5',
  table_title: 'Вахтовый график',
  is_enabled: true,
  conditions: [{ column_id: 99, operator: 'less', value: '2026-11-01' }],
  broken: true,
};

const NOT_FOUND: MockResponse = { status: 404, body: { detail: 'Правило не найдено' } };

/** Правило, чья таблица удалена: в каталоге такого ключа уже нет. */
const DELETED_TABLE_RULE = {
  id: 15,
  name: 'Вкладка удалена',
  table_key: 'custom_7',
  table_title: 'Таблица удалена',
  is_enabled: true,
  conditions: [{ column_id: 99, operator: 'not_empty', value: null }],
  broken: true,
};

interface MountOptions {
  dormitories?: MockResponse;
  rules?: MockResponse;
  catalog?: MockResponse;
  /** Перехват остальных маршрутов: вызывается перед ответом по умолчанию. */
  extra?: (url: string, init?: RequestInit) => MockResponse | null;
}

function mount(options: MountOptions = {}): ReturnType<typeof mockFetch> {
  const fetchMock = mockFetch((url, init) => {
    const custom = options.extra?.(url, init);
    if (custom) return custom;
    if (url.endsWith('/api/dormitories'))
      return options.dormitories ?? { status: 200, body: DORMITORIES };
    if (url.endsWith('/telegram-rules/catalog'))
      return options.catalog ?? { status: 200, body: CATALOG };
    if (url.endsWith('/telegram-rules/preview')) {
      return { status: 200, body: { text: 'Новое заселение', matched: 3 } };
    }
    if (url.endsWith('/telegram-rules')) {
      if (init?.method === 'POST') return { status: 201, body: RULE };
      return options.rules ?? { status: 200, body: [RULE, BROKEN_RULE] };
    }
    if (/\/telegram-rules\/\d+$/.test(url)) {
      if (init?.method === 'DELETE') return { status: 204 };
      if (init?.method === 'PUT') return { status: 200, body: { ...RULE, is_enabled: false } };
    }
    if (url.endsWith('/tables/residents/columns')) return { status: 200, body: RESIDENT_COLUMNS };
    return NOT_FOUND;
  });
  render(
    <MemoryRouter>
      <NotificationRules />
    </MemoryRouter>,
  );
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('блок «Правила уведомлений»', () => {
  it('показывает загрузку, затем правила с условиями, таблицей и пометкой сломанного', async () => {
    mount();

    expect(screen.getByTestId('telegram-rules-loading')).toHaveTextContent('Загружаем правила…');
    expect(await screen.findByTestId('telegram-rule-row-12')).toHaveTextContent('Новое заселение');
    // Условие читается фразой: подпись варианта списка берётся из столбцов таблицы.
    expect(await screen.findByText('Пол равно Мужской')).toBeInTheDocument();
    expect(screen.getByTestId('telegram-rule-row-12')).toHaveTextContent('Проживающие');
    expect(screen.getByTestId('telegram-rule-broken-14')).toHaveTextContent(
      'Столбец удалён, правило не работает',
    );
    // Архивное общежитие в селектор не попадает.
    const selector = screen.getByTestId('telegram-rule-dormitory');
    expect(selector).not.toHaveTextContent('Архивное общежитие');
    // Сломанное правило сервер не сохранит, поэтому переключатель погашен и
    // подписан, а удаление при этом остаётся доступным.
    expect(screen.getByTestId('telegram-rule-toggle-14')).toBeDisabled();
    expect(screen.getByText('Сначала исправьте условие')).toBeInTheDocument();
    expect(screen.getByTestId('telegram-rule-delete-14')).toBeEnabled();
    // Рабочее правило переключается как обычно.
    expect(screen.getByTestId('telegram-rule-toggle-12')).toBeEnabled();
  });

  it('без правил показывает пустое состояние', async () => {
    mount({ rules: { status: 200, body: [] } });

    expect(await screen.findByTestId('telegram-rule-empty')).toHaveTextContent('Правил пока нет');
  });

  it('ошибку загрузки показывает текстом контракта и даёт повторить', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    mount({
      extra: (url) => {
        if (!url.endsWith('/telegram-rules/catalog')) return null;
        attempts += 1;
        return attempts === 1
          ? { status: 500, body: { detail: 'Ошибка' } }
          : { status: 200, body: CATALOG };
      },
    });

    expect(await screen.findByTestId('telegram-rules-error')).toHaveTextContent(
      'Не удалось загрузить правила. Проверьте соединение.',
    );
    await user.click(screen.getByTestId('telegram-rules-retry'));
    expect(await screen.findByTestId('telegram-rule-row-12')).toBeInTheDocument();
  });

  it('на 403 показывает «Решение не подключено»', async () => {
    mount({
      rules: {
        status: 403,
        body: { detail: 'Решение не подключено. Оформите подписку в магазине улучшений' },
      },
    });

    expect(await screen.findByTestId('telegram-rules-locked')).toHaveTextContent(
      'Решение не подключено',
    );
  });

  it('переключатель уходит на сервер с полным правилом', async () => {
    const user = userEvent.setup();
    const fetchMock = mount({ rules: { status: 200, body: [RULE] } });

    const toggle = await screen.findByTestId('telegram-rule-toggle-12');
    expect(toggle).toBeChecked();
    await user.click(toggle);

    await waitFor(() => expect(screen.getByTestId('telegram-rule-toggle-12')).not.toBeChecked());
    const call = fetchMock.mock.calls.find(
      (item) => String(item[0]).endsWith('/telegram-rules/12') && item[1]?.method === 'PUT',
    );
    expect(call).toBeDefined();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      name: 'Новое заселение',
      table_key: 'residents',
      is_enabled: false,
      conditions: [{ column_id: 12, operator: 'equals', value: 'male' }],
    });
  });

  it('удаление убирает строку, а 404 при удалении не показывает ошибки', async () => {
    const user = userEvent.setup();
    const fetchMock = mount({
      extra: (url, init) =>
        /\/telegram-rules\/\d+$/.test(url) && init?.method === 'DELETE'
          ? { status: 404, body: { detail: 'Правило не найдено' } }
          : null,
    });

    await user.click(await screen.findByTestId('telegram-rule-delete-12'));

    await waitFor(() =>
      expect(screen.queryByTestId('telegram-rule-row-12')).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('telegram-rules-action-error')).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        (item) => String(item[0]).endsWith('/telegram-rules/12') && item[1]?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('диалог: превью приходит с сервера, сохранение отправляет условия', async () => {
    const user = userEvent.setup();
    const fetchMock = mount();

    await user.click(await screen.findByTestId('telegram-rule-add'));
    expect(await screen.findByTestId('telegram-rule-dialog')).toBeInTheDocument();

    await user.type(screen.getByTestId('telegram-rule-name'), 'Новое заселение');
    expect(screen.getByText('15 из 80')).toBeInTheDocument();

    await user.click(screen.getByTestId('telegram-rule-condition-add'));
    await user.selectOptions(screen.getByTestId('telegram-rule-condition-0-column'), '13');
    await user.selectOptions(screen.getByTestId('telegram-rule-condition-0-operator'), 'equals');
    await user.type(screen.getByTestId('telegram-rule-condition-0-value'), 'Иванов');

    await user.click(screen.getByTestId('telegram-rule-preview-button'));
    // Превью — ровно `text` из ответа сервера: клиент сообщение не собирает.
    expect(await screen.findByTestId('telegram-rule-preview-text')).toHaveTextContent(
      'Новое заселение',
    );
    expect(screen.getByText(/Под правило подходит 3 строки/)).toBeInTheDocument();

    await user.click(screen.getByTestId('telegram-rule-save'));
    await waitFor(() =>
      expect(screen.queryByTestId('telegram-rule-dialog')).not.toBeInTheDocument(),
    );
    const call = fetchMock.mock.calls.find(
      (item) =>
        String(item[0]).endsWith('/api/dormitories/1/telegram-rules') && item[1]?.method === 'POST',
    );
    expect(call).toBeDefined();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      name: 'Новое заселение',
      table_key: 'residents',
      is_enabled: true,
      conditions: [{ column_id: 13, operator: 'equals', value: 'Иванов' }],
    });
  });

  it('отказ 422 показывается дословно в блоке ошибки диалога', async () => {
    const user = userEvent.setup();
    mount({
      extra: (url, init) =>
        url.endsWith('/telegram-rules/preview') && init?.method === 'POST'
          ? { status: 422, body: { detail: 'Столбец недоступен. Измените правило' } }
          : null,
    });

    await user.click(await screen.findByTestId('telegram-rule-edit-12'));
    await user.click(await screen.findByTestId('telegram-rule-preview-button'));

    expect(await screen.findByTestId('telegram-rule-error')).toHaveTextContent(
      'Столбец недоступен. Измените правило',
    );
    expect(screen.getByTestId('telegram-rule-preview-text')).not.toHaveTextContent(
      'Столбец недоступен',
    );
  });

  it('правка открывает диалог с условиями правила', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByTestId('telegram-rule-edit-12'));

    expect(await screen.findByTestId('telegram-rule-dialog')).toHaveTextContent(
      'Правило «Новое заселение»',
    );
    expect(screen.getByTestId('telegram-rule-name')).toHaveValue('Новое заселение');
    expect(await screen.findByTestId('telegram-rule-condition-0-column')).toHaveValue('12');
    // Варианты списка подставлены подписями: значение условия — идентификатор.
    expect(await screen.findByTestId('telegram-rule-condition-0-value')).toHaveValue('male');
  });

  it('потолок условий: «4 из 4», добавление неактивно, пятого условия нет', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByTestId('telegram-rule-add'));
    for (let index = 0; index < 4; index += 1) {
      await user.click(screen.getByTestId('telegram-rule-condition-add'));
    }

    expect(screen.getByTestId('telegram-rule-conditions')).toHaveTextContent('4 из 4');
    expect(screen.getByTestId('telegram-rule-condition-3-column')).toBeInTheDocument();
    expect(screen.getByTestId('telegram-rule-condition-add')).toBeDisabled();
    // Клик по погашенной кнопке не добавляет пятого условия и не двигает счётчик.
    await user.click(screen.getByTestId('telegram-rule-condition-add'));
    expect(screen.queryByTestId('telegram-rule-condition-4-column')).not.toBeInTheDocument();
    expect(screen.getByTestId('telegram-rule-conditions')).toHaveTextContent('4 из 4');
  });

  it('правка правила с удалённой таблицей называет её в селекторе и сохраняет ключ', async () => {
    const user = userEvent.setup();
    const fetchMock = mount({ rules: { status: 200, body: [DELETED_TABLE_RULE] } });

    await user.click(await screen.findByTestId('telegram-rule-edit-15'));

    // Каталог удалённую вкладку не отдаёт, поэтому у селектора нет своего
    // `option`: без него контрол выглядел бы пустым, а человек пришёл починить
    // ровно это правило.
    const selector = await screen.findByTestId('telegram-rule-table');
    expect(selector).toHaveValue('custom_7');
    expect(selector).toHaveTextContent('Таблица удалена');

    await user.click(screen.getByTestId('telegram-rule-save'));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
    const call = fetchMock.mock.calls.find(
      (item) => String(item[0]).endsWith('/telegram-rules/15') && item[1]?.method === 'PUT',
    );
    expect(call).toBeDefined();
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ table_key: 'custom_7' });
  });

  it('условие по чекбоксу — список «Да/Нет», в теле запроса значение false', async () => {
    const user = userEvent.setup();
    const fetchMock = mount();

    await user.click(await screen.findByTestId('telegram-rule-add'));
    await user.type(screen.getByTestId('telegram-rule-name'), 'Готов к заселению');
    await user.click(screen.getByTestId('telegram-rule-condition-add'));
    await user.selectOptions(screen.getByTestId('telegram-rule-condition-0-column'), '14');

    const value = await screen.findByTestId('telegram-rule-condition-0-value');
    // Вид контроля значения задаёт тип столбца: чекбокс — список, а не поле ввода.
    expect(value.tagName).toBe('SELECT');
    expect(value).toHaveTextContent('Да');
    expect(value).toHaveTextContent('Нет');
    expect(value).toHaveValue('false');

    await user.click(screen.getByTestId('telegram-rule-save'));
    await waitFor(() =>
      expect(screen.queryByTestId('telegram-rule-dialog')).not.toBeInTheDocument(),
    );

    const call = fetchMock.mock.calls.find(
      (item) =>
        String(item[0]).endsWith('/api/dormitories/1/telegram-rules') && item[1]?.method === 'POST',
    );
    expect(call).toBeDefined();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      name: 'Готов к заселению',
      table_key: 'residents',
      is_enabled: true,
      conditions: [{ column_id: 14, operator: 'equals', value: false }],
    });
  });

  it('условие «заполнено» уходит без значения: контроля значения нет', async () => {
    const user = userEvent.setup();
    const fetchMock = mount();

    await user.click(await screen.findByTestId('telegram-rule-add'));
    await user.type(screen.getByTestId('telegram-rule-name'), 'Заполненный пол');
    await user.click(screen.getByTestId('telegram-rule-condition-add'));
    await user.selectOptions(screen.getByTestId('telegram-rule-condition-0-column'), '13');
    await user.selectOptions(screen.getByTestId('telegram-rule-condition-0-operator'), 'not_empty');

    // У «заполнено/не заполнено» значения нет — оператор не просит контроль.
    expect(screen.queryByTestId('telegram-rule-condition-0-value')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('telegram-rule-save'));
    await waitFor(() =>
      expect(screen.queryByTestId('telegram-rule-dialog')).not.toBeInTheDocument(),
    );

    const call = fetchMock.mock.calls.find(
      (item) =>
        String(item[0]).endsWith('/api/dormitories/1/telegram-rules') && item[1]?.method === 'POST',
    );
    expect(call).toBeDefined();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      name: 'Заполненный пол',
      table_key: 'residents',
      is_enabled: true,
      conditions: [{ column_id: 13, operator: 'not_empty', value: null }],
    });
  });

  it('отказ 422 при сохранении показывается дословно и не закрывает диалог', async () => {
    const user = userEvent.setup();
    mount({
      extra: (url, init) =>
        url.endsWith('/telegram-rules') && init?.method === 'POST'
          ? { status: 422, body: { detail: 'Укажите название правила' } }
          : null,
    });

    await user.click(await screen.findByTestId('telegram-rule-add'));
    await user.click(screen.getByTestId('telegram-rule-save'));

    // Текст отказа — из `detail` дословно: по нему человек правит правило.
    expect(await screen.findByTestId('telegram-rule-error')).toHaveTextContent(
      'Укажите название правила',
    );
    // Диалог остаётся открытым: введённое не теряется, можно исправить и повторить.
    expect(screen.getByTestId('telegram-rule-dialog')).toBeInTheDocument();
  });
});

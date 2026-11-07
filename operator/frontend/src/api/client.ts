/**
 * Клиент API кабинета оператора.
 *
 * Ручки ровно те, что отдаёт `operator-api`: вход, «кто вошёл», выход
 * (`operator/backend/app/api/auth.py`), организации платформы
 * (`operator/backend/app/api/organizations.py`), пользователи
 * (`operator/backend/app/api/users.py`), счета
 * (`operator/backend/app/api/invoices.py`), тарифы
 * (`operator/backend/app/api/tariffs.py`), решения магазина
 * (`operator/backend/app/api/solutions.py`) и реквизиты поставщика
 * (`operator/backend/app/api/company.py`). Токен не хранится в JS: сессия
 * живёт в httpOnly cookie `operator_session`, поэтому каждый запрос идёт с
 * `credentials: 'include'`.
 *
 * Путь относительный (`/api`) — так же, как у основного кабинета: nginx кабинета
 * проксирует `/api/` в `operator-api`, и cookie остаётся first-party.
 */

/** Ответ `POST /api/auth/login` и `GET /api/auth/me`: логин единственного оператора. */
export interface Operator {
  username: string;
}

/** Отказ API с кодом ответа и текстом, который сервер прислал в `detail`. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    // Cookie сессии — единственное хранилище токена: без этого браузер её не отправит.
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response));
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/**
 * Текст отказа для пользователя.
 *
 * У ошибки приложения `detail` — строка («Неверный логин или пароль»), и её
 * экран показывает дословно: это контракт. У ошибки валидации FastAPI `detail` —
 * список объектов `{type, loc, msg, input}`: берём первое `msg`, иначе
 * пользователь увидел бы «Запрос не удался (422)» вместо причины.
 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    return errorText(response.status, await response.json());
  } catch {
    return `Запрос не удался (${response.status})`;
  }
}

function errorText(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
    const validation = validationErrorsText(detail);
    if (validation !== '') {
      return validation;
    }
  }
  return `Запрос не удался (${status})`;
}

/**
 * Тексты ошибок валидации FastAPI — через `; `, без служебной приставки.
 *
 * pydantic предваряет текст валидатора: «Value error, Название не может быть
 * пустым». Кабинет показывает отказ дословно и по контракту ровно «Название не
 * может быть пустым», поэтому приставка снимается, а `loc` не печатается: текст
 * уже называет поле словами, а «body.inn:» в лицо оператору не нужно.
 */
function validationErrorsText(detail: unknown): string {
  if (!Array.isArray(detail)) {
    return '';
  }
  return detail
    .map((item) => {
      if (item === null || typeof item !== 'object') {
        return '';
      }
      const message = (item as { msg?: unknown }).msg;
      if (typeof message !== 'string') {
        return '';
      }
      return message.replace(/^Value error,\s*/i, '').trim();
    })
    .filter((message) => message !== '')
    .join('; ');
}

/** Вход по паре из конфига. Неверная пара — `ApiError` со статусом 401. */
export function login(username: string, password: string): Promise<Operator> {
  return request<Operator>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

/** Кто вошёл. Без сессии — `ApiError` со статусом 401. */
export function me(): Promise<Operator> {
  return request<Operator>('/auth/me');
}

/** Выход: сервер гасит cookie и отвечает `204`, в том числе без сессии. */
export function logout(): Promise<void> {
  return request<void>('/auth/logout', { method: 'POST' });
}

// --- Организации платформы --------------------------------------------------
// Форма ответа — та же, что у основного API: кабинет-API её не переписывает
// (`operator/backend/app/schemas.py`). Название и ИНН бывают `null` у пустой
// заготовки организации — это нормальное состояние, а не отсутствие данных.

/** Строка списка организаций. */
export interface OrganizationListItem {
  id: number;
  name: string | null;
  inn: string | null;
  /** ISO-8601 из API; показывается как дата без времени. */
  created_at: string;
}

/** Карточка организации: реквизиты и счётчики. */
export interface OrganizationDetails {
  id: number;
  name: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  address: string | null;
  created_at: string;
  /** Участники организации, владелец считается. */
  members_count: number;
  /** Общежития организации, архивные считаются. */
  dormitories_count: number;
}

/** Страница списка: элементы и общее число организаций. */
export interface OrganizationPage {
  items: OrganizationListItem[];
  total: number;
}

/**
 * Тело правки. Кабинет отправляет все пять полей всегда (`Контракт половин`),
 * а `null` в реквизите означает очистку поля. Пустое название отправляется как
 * есть: правило «название не пустое» живёт в основном API, и его отказ
 * показывается дословно.
 */
export interface OrganizationUpdate {
  name: string;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  address: string | null;
}

/** Страница организаций: свежие сверху. `limit` 1..100, `offset` ≥ 0. */
export function listOrganizations(limit: number, offset: number): Promise<OrganizationPage> {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<OrganizationPage>(`/organizations?${query.toString()}`);
}

/** Карточка организации. Неизвестный `id` — `ApiError` со статусом 404. */
export function getOrganization(id: number): Promise<OrganizationDetails> {
  return request<OrganizationDetails>(`/organizations/${id}`);
}

/** Правка организации: ответ — то, что сохранил основной API. */
export function updateOrganization(
  id: number,
  payload: OrganizationUpdate,
): Promise<OrganizationDetails> {
  return request<OrganizationDetails>(`/organizations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

// --- Пользователи платформы -------------------------------------------------
// Форма ответа — та же, что у основного API (`app/backend/app/schemas/platform_user.py`):
// кабинет-API её не переписывает (`operator/backend/app/schemas.py`). `organization_id`,
// `organization_name` и `role` бывают `null` вместе — у учётной записи без организации.
// `is_active` значит «кабинет активирован», а не «заблокирован».

/** Учётная запись платформы: строка списка, карточка и ответ правки. */
export interface PlatformUser {
  id: number;
  /** Email — он же логин учётной записи; только чтение. */
  email: string;
  full_name: string;
  is_active: boolean;
  organization_id: number | null;
  organization_name: string | null;
  /** `owner` | `admin` | `manager` | `commandant` | `member`, без организации — `null`. */
  role: string | null;
  /** ISO-8601 из API; показывается как дата без времени. */
  created_at: string;
}

/** Страница списка: элементы и общее число учётных записей. */
export interface PlatformUserPage {
  items: PlatformUser[];
  total: number;
}

/** Параметры списка: `limit` 1..100, `offset` ≥ 0, `search` — подстрока до 100 символов. */
export interface UserListQuery {
  limit: number;
  offset: number;
  search?: string;
}

/**
 * Тело правки: единственное поле — ФИО.
 *
 * Email, роль, организация и признак активности не отправляются: ручек для них
 * нет, и лишнее поле основной API отвергнет.
 */
export interface PlatformUserUpdate {
  full_name: string;
}

/**
 * Страница пользователей: свежие сверху.
 *
 * `search` уходит только непустым: пустой параметр — лишний повод для отказа,
 * а правило поиска живёт в основном API.
 */
export function listUsers({ limit, offset, search }: UserListQuery): Promise<PlatformUserPage> {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (search !== undefined && search.trim() !== '') {
    query.set('search', search.trim());
  }
  return request<PlatformUserPage>(`/users?${query.toString()}`);
}

/** Карточка пользователя. Неизвестный `id` — `ApiError` со статусом 404. */
export function getUser(id: number): Promise<PlatformUser> {
  return request<PlatformUser>(`/users/${id}`);
}

/** Правка ФИО: ответ — то, что сохранил основной API. */
export function updateUser(id: number, payload: PlatformUserUpdate): Promise<PlatformUser> {
  return request<PlatformUser>(`/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

// --- Счета платформы --------------------------------------------------------
// Форма ответа — та же, что у основного API (`app/backend/app/schemas/invoice.py`):
// кабинет её не переписывает (`operator/backend/app/schemas.py`). `status_label`
// и `amount_label` собирает сервер, экран их не пересчитывает. `can_manage`
// в платформенном контуре всегда `true` — право даёт сервисный токен, и фронт
// на это поле не ветвится.

/** Статусы счёта по контракту: одно и то же в фильтре и в ответе. */
export type InvoiceStatus = 'new' | 'paid' | 'closed' | 'cancelled';

/** Вид предмета счёта: подписка (`tariff`) или право магазина (`solution`). */
export type InvoiceItemKind = 'tariff' | 'solution';

/** Строка реестра счетов: счёт плюс организация, которой он выставлен. */
export interface PlatformInvoice {
  id: number;
  number: string;
  status: InvoiceStatus;
  /** Готовая подпись статуса из API — на экране берётся дословно. */
  status_label: string;
  item_kind: InvoiceItemKind;
  /** Сумма строкой: копейки не должны теряться на округлении. */
  amount: string;
  currency: string;
  /** Готовая подпись суммы из API («12 400 ₽ за 3 месяца»). */
  amount_label: string;
  /** Название предмета: тарифа или решения — колонка исторически одна. */
  tariff_name: string | null;
  tariff_period: string | null;
  buyer_name: string | null;
  buyer_inn: string | null;
  buyer_kpp: string | null;
  buyer_ogrn: string | null;
  buyer_address: string | null;
  /** Акт уже сформирован: по нему экран показывает ссылку на скачивание. */
  has_act: boolean;
  can_manage: boolean;
  paid_at: string | null;
  /** ISO-8601 из API; показывается как дата без времени. */
  created_at: string;
  organization_id: number;
  /** `null` у пустой заготовки организации. */
  organization_name: string | null;
}

/** Страница списка: элементы и общее число счетов по тем же условиям. */
export interface PlatformInvoicePage {
  items: PlatformInvoice[];
  total: number;
}

/**
 * Параметры списка.
 *
 * `limit` 1..100, `offset` ≥ 0, `status` — пусто либо статус счёта, `search` —
 * подстрока названия организации или ИНН, до 100 символов.
 */
export interface InvoiceListQuery {
  limit: number;
  offset: number;
  status?: InvoiceStatus | '';
  search?: string;
}

/**
 * Страница счетов всех организаций: свежие сверху.
 *
 * Пустые `status` и `search` не отправляются: фильтр необязательный, а правило
 * поиска живёт в основном API.
 */
export function listInvoices({
  limit,
  offset,
  status,
  search,
}: InvoiceListQuery): Promise<PlatformInvoicePage> {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (status !== undefined && status !== '') {
    query.set('status', status);
  }
  if (search !== undefined && search.trim() !== '') {
    query.set('search', search.trim());
  }
  return request<PlatformInvoicePage>(`/invoices?${query.toString()}`);
}

/**
 * Оплата или отмена счёта: ответ — обновлённая строка.
 *
 * Разрешённые переходы и тексты отказов — правило основного API
 * (`app/backend/app/invoice_status.py`), поэтому тело — только `status`,
 * а `detail` отказа показывается дословно.
 */
export function updateInvoiceStatus(id: number, status: InvoiceStatus): Promise<PlatformInvoice> {
  return request<PlatformInvoice>(`/invoices/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

// --- Тарифы платформы -------------------------------------------------------
// Форма ответа — та же, что у основного API (`app/backend/app/schemas/tariff.py`)
// и у кабинета (`operator/backend/app/schemas.py`): экран её не переписывает.
// `price_label` собирает сервер, клиент его не считает: формула цены одна на
// весь API (`app/backend/app/pricing.py`). `amount` — строка, чтобы копейки не
// терялись на округлении.

/** Период списания: коды, объявленные `TariffPeriod` в схеме основного API. */
export type TariffPeriod = 'month' | 'quarter' | 'half_year' | 'year' | 'once';

/**
 * Строка прайса.
 *
 * `description` и `max_members` равны `null` у тарифа без описания и без
 * ограничения мест. `position` — порядок прайса, `group_code` — код яруса:
 * строки одного яруса делят описание и предел мест.
 */
export interface Tariff {
  id: number;
  name: string;
  description: string | null;
  /** Сумма строкой: `Numeric` едет по JSON как «13200.00». */
  amount: string;
  currency: string;
  period: TariffPeriod;
  unit_label: string | null;
  position: number;
  is_visible: boolean;
  /** `null` — без ограничения мест, а не «ноль пользователей». */
  max_members: number | null;
  tooltip: string | null;
  group_code: string | null;
  /** Готовая цена от сервера: «13 200 ₽ за 3 месяца». Экран печатает её как есть. */
  price_label: string;
}

/**
 * Тело правки `PATCH /api/tariffs/{id}`.
 *
 * Меняются только присланные поля (правило основного API,
 * `app/backend/app/schemas/platform_tariff.py`). Экран правки отправляет все
 * пять полей строки — `name`, `description`, `amount`, `period`, `max_members`,
 * — а «Опубликовать» только `is_visible: true`. `null` в описании — «описания
 * нет», `null` в количестве пользователей — «без ограничения».
 */
export interface TariffPatch {
  name?: string;
  description?: string | null;
  amount?: string;
  period?: TariffPeriod;
  /** `null` — без ограничения; пустое поле формы уходит именно так. */
  max_members?: number | null;
  is_visible?: boolean;
}

/**
 * Весь прайс: включая снятые с продажи строки, порядок `position, id`.
 *
 * Пагинации нет намеренно: строк в прайсе около пятнадцати, и основной API
 * отдаёт такой же плоский список.
 */
export function listTariffs(): Promise<Tariff[]> {
  return request<Tariff[]>('/tariffs');
}

/** Правка тарифа: ответ — то, что сохранил основной API (`price_label` уже пересчитан). */
export function updateTariff(id: number, payload: TariffPatch): Promise<Tariff> {
  return request<Tariff>(`/tariffs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

/**
 * Снять тариф с продажи: `204` без тела.
 *
 * Строка не удаляется — основной API ставит `is_visible = false`, и экран
 * помечает строку сам: тела с новым состоянием в ответе нет. Повторный вызов
 * идемпотентен.
 */
export function deleteTariff(id: number): Promise<void> {
  return request<void>(`/tariffs/${id}`, { method: 'DELETE' });
}

// --- Решения магазина -------------------------------------------------------
// Форма ответа — та же, что у основного API (`app/backend/app/schemas/platform_solution.py`)
// и у кабинета (`operator/backend/app/schemas.py`): экран её не переписывает.
// `price_label` собирает сервер общей формулой цены (`app/backend/app/pricing.py`),
// клиент его не считает. `amount` — строка, чтобы копейки не терялись на округлении.

/**
 * Строка каталога решений в кабинете оператора.
 *
 * `code` — машинное имя решения и гейт платной функции (`app.solutions.has_solution`):
 * он показывается, но не правится и не создаётся. `position` — порядок витрины:
 * меньше — выше в магазине, при равных значениях выше строка с меньшим `id`.
 * `description` равно `null` у решения без описания.
 *
 * **Периода оплаты нет** (#195): у решения нет собственного срока, право
 * действует, пока действует тариф организации, поэтому `price_label` читается как
 * «500 ₽ разово» и второго срока у строки не спрашивают.
 */
export interface Solution {
  id: number;
  /** Гейт функции и `UNIQUE` в таблице: только чтение. */
  code: string;
  name: string;
  description: string | null;
  /** Сумма строкой: `Numeric` едет по JSON как «500.00». */
  amount: string;
  currency: string;
  position: number;
  is_visible: boolean;
  /** Готовая цена от сервера: «500 ₽ разово». Экран печатает её как есть. */
  price_label: string;
  /** ISO-8601 из API; показывается как дата без времени. */
  created_at: string;
  updated_at: string;
}

/**
 * Тело правки `PATCH /api/solutions/{id}`.
 *
 * Меняются только присланные поля (правило основного API,
 * `app/backend/app/schemas/platform_solution.py`). Экран правки отправляет все
 * шесть полей строки — `name`, `description`, `amount`, `currency`, `position`,
 * `is_visible`, — а «Опубликовать» только `is_visible: true`. `null` в описании —
 * «описания нет». Полей `code` и `period` в теле нет намеренно: присланные
 * основной API отсекает `422` (у решения нет своего срока).
 */
export interface SolutionPatch {
  name?: string;
  description?: string | null;
  amount?: string;
  currency?: string;
  position?: number;
  is_visible?: boolean;
}

/**
 * Весь каталог решений: включая снятые с продажи строки, порядок `position, id`.
 *
 * Пагинации нет намеренно: строк каталога единицы, и основной API отдаёт такой
 * же плоский список. Порядок массива — это порядок витрины клиента: экран его не
 * пересортировывает.
 */
export function listSolutions(): Promise<Solution[]> {
  return request<Solution[]>('/solutions');
}

/** Правка решения: ответ — то, что сохранил основной API (`price_label` уже пересчитан). */
export function updateSolution(id: number, payload: SolutionPatch): Promise<Solution> {
  return request<Solution>(`/solutions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

/**
 * Снять решение с продажи: `204` без тела.
 *
 * Строка не удаляется — основной API ставит `is_visible = false`, и экран
 * помечает строку сам: тела с новым состоянием в ответе нет. Повторный вызов
 * идемпотентен.
 */
export function deleteSolution(id: number): Promise<void> {
  return request<void>(`/solutions/${id}`, { method: 'DELETE' });
}

/**
 * Адрес PDF счёта или акта для обычной ссылки `href`.
 *
 * За файлом должен уходить переход, а не `fetch`: ответ — байты с
 * `Content-Disposition`, и имя файла собирает основной API.
 */
export function invoiceFileUrl(id: number, kind: 'invoice' | 'act'): string {
  return kind === 'act' ? `/api/invoices/${id}/act-file` : `/api/invoices/${id}/file`;
}

// --- Тариф и расширения организации -----------------------------------------
// Форма ответа — та же, что у основного API
// (`app/backend/app/schemas/platform_subscription.py`) и у кабинета
// (`operator/backend/app/schemas.py`): экран её не переписывает. `paid_until`,
// `days_left` и `is_live` считает сервер — второй формулы срока на клиенте нет,
// а «бессрочно» (`ends_at: null`) и «истёк» выводятся из `is_live`, а не из даты.
// У права `is_live` отвечает «работает ли оно сейчас по тарифу», а `expires_at`
// остался записанной историей срока и на экран не выводится.

/**
 * Записанный слот подписки: строка прайса и её срок.
 *
 * Данные — ровно то, что лежит в базе, без «виртуального переезда» наступившего
 * будущего слота: оператор видит запись. `ends_at: null` — бессрочный тариф,
 * тогда и `paid_until: null`. `price_label` собирает сервер.
 */
export interface SubscriptionTariff {
  id: number;
  name: string;
  period: TariffPeriod;
  /** `null` — без ограничения мест, а не «ноль пользователей». */
  max_members: number | null;
  /** Готовая подпись цены от сервера — экран печатает её как есть. */
  price_label: string;
  /** ISO-8601 из API; `null` — бессрочно. */
  ends_at: string | null;
  /** Последний включённый день в МСК (`YYYY-MM-DD`); `null` — бессрочно. */
  paid_until: string | null;
  is_live: boolean;
}

/** Оплаченный вперёд слот: показывается, но не правится и не снимается. */
export interface NextSubscription {
  tariff: SubscriptionTariff;
  ends_at: string | null;
  paid_until: string | null;
}

/** Право организации на расширение — включая истёкшие (`is_live: false`). */
export interface SubscriptionRight {
  /** Машинный код решения и гейт платной функции; уходит в путь снятия. */
  code: string;
  name: string;
  /** Записанный срок права — история оплаченных сроков, на экран не выводится. */
  expires_at: string | null;
  /**
   * Последний включённый день **права сейчас** в МСК; `null` — тариф бессрочный.
   *
   * У неработающего права здесь записанный срок из истории, поэтому подпись
   * строится по `is_live`, а не по этой дате.
   */
  paid_until: string | null;
  /** Работает ли право **сейчас**: куплено и у организации действующий тариф. */
  is_live: boolean;
}

/** Состояние подписки: один и тот же объект у всех четырёх ручек. */
export interface SubscriptionState {
  /** Записанный текущий слот; `null` — «Тариф не назначен». */
  tariff: SubscriptionTariff | null;
  /** Остаток дней у действующего слота; у истёкшего — `0`. */
  days_left: number;
  next: NextSubscription | null;
  /** Докупленные места сверх тарифа. */
  extra_seats: number;
  /** Действующий предел мест: `max_members` плюс докупленные; `null` — без предела. */
  member_limit: number | null;
  /** Все права организации в порядке витрины, включая истёкшие. */
  solutions: SubscriptionRight[];
}

/**
 * Тело правки срока: единственное поле — последний включённый день.
 *
 * Формат `YYYY-MM-DD` проверяет основной API, и его `422` с русским текстом
 * показывается дословно: собственной проверки даты на клиенте нет.
 */
export interface SubscriptionUpdate {
  paid_until: string;
}

/**
 * Тариф и расширения организации.
 *
 * Неизвестный `id` — `ApiError` со статусом 404 с текстом основного API.
 */
export function getSubscription(organizationId: number): Promise<SubscriptionState> {
  return request<SubscriptionState>(`/organizations/${organizationId}/subscription`);
}

/**
 * Новый срок тарифа: ответ — новое состояние целиком.
 *
 * Экран показывает дату из ответа, а не из поля ввода: расхождение здесь —
 * дефект, а не повод перезапросить состояние.
 */
export function updateSubscription(
  organizationId: number,
  paidUntil: string,
): Promise<SubscriptionState> {
  const payload: SubscriptionUpdate = { paid_until: paidUntil };
  return request<SubscriptionState>(`/organizations/${organizationId}/subscription`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

/**
 * Снять активность текущего тарифа: без тела, ответ — новое состояние.
 *
 * `204` в контуре не появляется, поэтому экран не перезапрашивает чтение.
 * Повторное снятие — тоже `200`, а слот без тарифа — `409 «Тариф не назначен»`
 * дословно. Оплаченный вперёд слот не меняется.
 */
export function deactivateSubscription(organizationId: number): Promise<SubscriptionState> {
  return request<SubscriptionState>(`/organizations/${organizationId}/subscription/deactivate`, {
    method: 'POST',
  });
}

/**
 * Снять активность права на решение: без тела, ответ — новое состояние.
 *
 * `code` — машинный код из ответа чтения. Неизвестный код — `404 «Расширение не
 * найдено»` дословно; повторное снятие — `200`.
 */
export function deactivateOrganizationSolution(
  organizationId: number,
  code: string,
): Promise<SubscriptionState> {
  return request<SubscriptionState>(
    `/organizations/${organizationId}/solutions/${encodeURIComponent(code)}/deactivate`,
    { method: 'POST' },
  );
}

// --- Реквизиты поставщика ---------------------------------------------------
// Форма ответа — та же, что у основного API (`app/backend/app/schemas/company_details.py`)
// и у кабинета (`operator/backend/app/schemas.py`): экран её не переписывает.
// Все поля присутствуют всегда, пустое значение приходит как `null` и означает
// «поле не заполнено» — `null` и пустая строка для реквизитов одно и то же.
// Строка одна (`id: 1`): поставщик в проекте один, и заводить её из кабинета
// нельзя — она засеяна миграцией основного API.

/** Реквизиты поставщика: одиннадцать правимых полей плюс `id` и `updated_at`. */
export interface CompanyDetails {
  id: number;
  name: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  address: string | null;
  bank_name: string | null;
  bank_bic: string | null;
  bank_account: string | null;
  corr_account: string | null;
  signatory: string | null;
  /** Строка про НДС в печатных формах: пусто — строки в документе нет. */
  vat_note: string | null;
  /** ISO-8601 из API; `null`, пока строку не засеяли. */
  updated_at: string | null;
}

/**
 * Тело правки `PATCH /api/company-details`.
 *
 * Экран отправляет все одиннадцать полей, как требует контракт: пустое поле
 * уходит как `null`, и это и есть очистка. Формат ИНН, КПП, ОГРН, БИК и счетов,
 * длины колонок — правило основного API, поэтому проверок здесь нет: его `422`
 * показывается дословно.
 */
export interface CompanyDetailsUpdate {
  name: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  address: string | null;
  bank_name: string | null;
  bank_bic: string | null;
  bank_account: string | null;
  corr_account: string | null;
  signatory: string | null;
  vat_note: string | null;
}

/**
 * Реквизиты поставщика.
 *
 * Пустая база — тоже успех: основной API отвечает `200` со всеми `null`, и
 * экран показывает пустую форму. `404 «Реквизиты поставщика не заведены»` —
 * не засеянная строка, а не потерянный ресурс.
 */
export function getCompanyDetails(): Promise<CompanyDetails> {
  return request<CompanyDetails>('/company-details');
}

/** Правка реквизитов: ответ — то, что сохранил основной API. */
export function updateCompanyDetails(payload: CompanyDetailsUpdate): Promise<CompanyDetails> {
  return request<CompanyDetails>('/company-details', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import type { ExtraSeats, OrganizationTariff, Tariff, TariffPeriod } from '../api/client';
import { useSession } from '../auth/SessionProvider';
import { LicenseCalculator } from '../components/LicenseCalculator';
import type { LicenseOption, LicenseOrder } from '../components/LicenseCalculator';
import { SiteActions } from '../components/SiteActions';
import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/landing/SiteFooter';
import { siteNav } from '../components/siteNav';
import { formatTariffDate } from '../components/tariffText';
import { useAuthDialog } from '../components/useAuthDialog';
import { PurchaseConfirmDialog } from '../components/PurchaseConfirmDialog';

const GENERIC_ERROR = 'Не удалось загрузить тарифы. Проверьте соединение и попробуйте ещё раз.';
const PURCHASE_ERROR = 'Не удалось выставить счёт. Проверьте соединение и попробуйте ещё раз.';

/**
 * Сроки словами: сервер держит код в `period`, а подпись для кнопки — данные
 * страницы. Набор тот же, что `TariffPeriod`: у проданных ранее строк бывают
 * `quarter`, `month` и `once`.
 */
const PERIOD_LABELS: Record<TariffPeriod, string> = {
  month: '1 месяц',
  quarter: '3 месяца',
  half_year: '6 месяцев',
  year: '12 месяцев',
  once: 'разово',
};

/**
 * Меню шапки страницы тарифов: тот же общий публичный список, что на главной и
 * на странице документа, — «Тарифы» в нём на своём месте.
 */
const NAV = siteNav({ onHome: false });

/** Текст ошибки: сервер объясняет причину точнее общего «не получилось». */
function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : GENERIC_ERROR;
}

/** Текст отказа покупки: 401 — конец сессии, 409 и остальное объясняет сервер. */
function purchaseErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? 'Сессия завершилась. Войдите в аккаунт снова.' : error.message;
  }
  return PURCHASE_ERROR;
}

/**
 * Строки прайса → варианты калькулятора.
 *
 * Срок — ключ варианта: сервер уже отдаёт по строке на срок, а калькулятор
 * выбирает лицензию именно сроком. Повтор срока (если в прайсе осталась вторая
 * строка того же периода) отбрасывается: переключатель не показывает две
 * одинаковые кнопки, а берёт первую — её же сервер и поставил выше.
 */
function licenseOptions(tariffs: Tariff[]): LicenseOption[] {
  const seen = new Set<TariffPeriod>();
  const options: LicenseOption[] = [];
  for (const tariff of tariffs) {
    if (seen.has(tariff.period)) continue;
    seen.add(tariff.period);
    options.push({
      id: tariff.id,
      period: tariff.period,
      label: PERIOD_LABELS[tariff.period],
      name: tariff.name,
      amount: tariff.amount,
      priceLabel: tariff.price_label,
      includedMembers: tariff.max_members,
    });
  }
  return options;
}

/**
 * Публичная страница тарифов: прайс читается из базы анонимными ручками.
 *
 * Страница доступна без сессии — как лендинг. `SessionProvider` всё равно
 * сходит на `/api/me` и получит 401: для анонима это нормальное состояние, а не
 * ошибка страницы. Скрытые тарифы сюда не приходят вовсе: их отсекает серверная
 * ручка, а не проверка на клиенте.
 *
 * Две лицензии (6 и 12 месяцев) и ступени скидки за дополнительные места — тоже
 * ответы сервера: `GET /api/tariffs` и `GET /api/tariffs/extra-seats`. Цену
 * места со скидкой считает `app/seats.py`, экран умножает готовое число на
 * количество и складывает с ценой лицензии; в теле покупки уходят только
 * `tariff_id`, `seats` и отметка оферты. `404` ручки мест — это состояние
 * «дополнительные сотрудники не продаются», а не сбой страницы: счётчик просто
 * не показывается.
 *
 * Если тариф у организации уже есть, страница называет его над калькулятором и
 * заранее выбирает его срок: срок и дни считает сервер (`/api/tariffs/current`),
 * страница показывает `ends_at` как есть и не вычитает дни из даты сама.
 */
export function Pricing(): JSX.Element {
  const [licenses, setLicenses] = useState<LicenseOption[]>([]);
  const [extraSeats, setExtraSeats] = useState<ExtraSeats | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  // Счётчик повторов: изменение значения перезапускает загрузку.
  const [attempt, setAttempt] = useState(0);
  const [buying, setBuying] = useState(false);
  const [buyError, setBuyError] = useState('');
  // Заказ из калькулятора: пока он задан, открыто окно подтверждения.
  const [pending, setPending] = useState<LicenseOrder | null>(null);
  // Подписка организации: по ней страница называет действующую лицензию.
  const [subscription, setSubscription] = useState<OrganizationTariff | null>(null);
  const { openLogin, openRegister, dialogElement } = useAuthDialog();
  const { status: sessionStatus } = useSession();
  const navigate = useNavigate();

  /**
   * «Посмотреть заказ» открывает окно подтверждения: счёт выставляется не по
   * клику в калькуляторе, а по кнопке в окне, после отметки оферты.
   *
   * Анониму окно не показывается — кнопка открывает регистрацию: счёт
   * выставляется только вошедшему. Вошедшего после покупки ведёт в раздел
   * «Документы» — именно там виден выставленный счёт.
   *
   * Занятые слоты покупку не гасят: сервер сам решает, куда встанет оплата — в
   * текущий период или в будущий, — а когда заняты оба, он отвечает `409`
   * «Тариф уже оплачен на будущий период», и окно показывает этот текст как есть.
   * Закрытый пробный период тоже не блокирует: `403` обрабатывает `client.ts`
   * (`notifyTrialExpired`).
   */
  function startPurchase(order: LicenseOrder): void {
    if (sessionStatus !== 'authenticated') {
      openRegister();
      return;
    }
    if (buying) return;
    setBuyError('');
    setPending(order);
  }

  /** Подтверждение в окне: только здесь уходит запрос, уже с отметкой оферты. */
  async function confirmPurchase(): Promise<void> {
    if (buying || pending === null || pending.tariff.id === null) return;
    setBuying(true);
    setBuyError('');
    try {
      await api.purchaseInvoice({
        tariff_id: pending.tariff.id,
        // Ноль мест — это покупка только лицензии: поля `seats` в теле нет.
        ...(pending.seats > 0 ? { seats: pending.seats } : {}),
        offer_accepted: true,
      });
      navigate('/cabinet/documents', { state: { purchased: true } });
    } catch (caught: unknown) {
      setBuyError(purchaseErrorMessage(caught));
      setBuying(false);
    }
  }

  /** «Отмена», крестик и Esc: окно закрывается, счёт не выставляется. */
  function cancelPurchase(): void {
    if (buying) return;
    setPending(null);
    setBuyError('');
  }

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void Promise.all([
      api.tariffs(controller.signal),
      // `404` ступеней — места не продаются; это состояние экрана, а не сбой
      // страницы, поэтому отказ тут не роняет загрузку прайса.
      api.extraSeats(controller.signal).catch(() => null),
    ])
      .then(([price, seats]) => {
        if (controller.signal.aborted) return;
        setLicenses(licenseOptions(price));
        setExtraSeats(seats);
        setStatus('ready');
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(caught));
        setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  /**
   * Действующая лицензия организации — чтобы назвать её над калькулятором и
   * заранее выбрать её срок.
   *
   * Аноним ничего не покупал, и лишний запрос ему ни к чему. У вошедшего без
   * организации ручка отвечает `404`, а не «нет тарифа», — и это тоже просто
   * «покупать есть что»: страница покупки из-за отказа ручки не ломается.
   */
  useEffect(() => {
    if (sessionStatus !== 'authenticated') {
      setSubscription(null);
      return;
    }
    const controller = new AbortController();
    void api
      .currentTariff(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setSubscription(data);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setSubscription(null);
      });
    return () => controller.abort();
  }, [sessionStatus]);

  return (
    <div className="app" data-testid="pricing">
      <a className="skip-link" href="#main">
        К основному содержанию
      </a>

      <SiteHeader
        nav={NAV}
        actions={<SiteActions onLogin={openLogin} onRegister={openRegister} />}
      />

      <main id="main">
        <section className="section section--first" aria-labelledby="pricing-title">
          <div className="container">
            <div className="section__head section__head--center">
              <p className="eyebrow">Тарифы</p>
              <h1 id="pricing-title">Сколько стоит «Домовой»</h1>
              <p>
                Две лицензии — на 6 и на 12 месяцев. Если сотрудников больше, чем включено, докупите
                места: скидка растёт за каждый полный десяток.
              </p>
            </div>

            {status === 'loading' && (
              <p className="pricing__note" role="status" data-testid="pricing-loading">
                Загружаем тарифы…
              </p>
            )}

            {status === 'error' && (
              <div className="pricing__error" role="alert" data-testid="pricing-error">
                <p>{error}</p>
                <button
                  className="btn btn--outline btn--sm"
                  type="button"
                  data-testid="pricing-retry"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Повторить
                </button>
              </div>
            )}

            {status === 'ready' && licenses.length === 0 && (
              <p className="pricing__note" data-testid="pricing-empty">
                Тарифы ещё не опубликованы
              </p>
            )}

            {status === 'ready' && subscription?.tariff && (
              <p className="pricing__note" data-testid="pricing-subscription">
                Действующая лицензия: «{subscription.tariff.name}»
                {subscription.ends_at
                  ? `, оплачена до ${formatTariffDate(subscription.ends_at)}`
                  : ''}
              </p>
            )}

            {status === 'ready' && licenses.length > 0 && (
              <LicenseCalculator
                licenses={licenses}
                bands={extraSeats?.bands ?? null}
                maxQuantity={extraSeats?.max_quantity ?? 0}
                initialPeriod={subscription?.tariff?.period}
                onBuy={startPurchase}
              />
            )}

            {pending !== null && (
              <PurchaseConfirmDialog
                order={pending}
                submitting={buying}
                error={buyError}
                onCancel={cancelPurchase}
                onConfirm={() => void confirmPurchase()}
              />
            )}
          </div>
        </section>
      </main>

      <SiteFooter />

      {dialogElement}
    </div>
  );
}

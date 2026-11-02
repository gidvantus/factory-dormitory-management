import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import type { OrganizationTariff, Tariff } from '../api/client';
import { useSession } from '../auth/SessionProvider';
import { SiteActions } from '../components/SiteActions';
import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/landing/SiteFooter';
import { siteNav } from '../components/siteNav';
import { useAuthDialog } from '../components/useAuthDialog';
import { PricingPlans } from '../components/PricingPlans';
import { PurchaseConfirmDialog } from '../components/PurchaseConfirmDialog';

const GENERIC_ERROR = 'Не удалось загрузить тарифы. Проверьте соединение и попробуйте ещё раз.';
const PURCHASE_ERROR = 'Не удалось выставить счёт. Проверьте соединение и попробуйте ещё раз.';

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
 * Публичная страница тарифов: прайс читается из базы анонимной ручкой.
 *
 * Страница доступна без сессии — как лендинг. `SessionProvider` всё равно
 * сходит на `/api/me` и получит 401: для анонима это нормальное состояние, а не
 * ошибка страницы. Скрытые тарифы сюда не приходят вовсе: их отсекает серверная
 * ручка, а не проверка на клиенте.
 *
 * Шапка и подвал — те же, что на главной, чтобы переход на прайс не выглядел
 * уходом с сайта. Вход и регистрация открываются окном на самой странице: уводить
 * человека на главную ради формы незачем. Единственное отличие меню — пункт
 * «Тарифы» здесь лишний: человек уже на прайсе.
 *
 * Если тариф у организации уже есть, список об этом говорит сам: купленная плашка
 * помечена подписью «Куплен», показывает «Оплачен до <дата>» и предлагает
 * «Продлить» — продление занимает следующий период, а не текущий. Отдельного
 * блока с рассказом про купленный тариф на странице нет — он дублировал бы
 * список.
 *
 * Срок и дни считает сервер (`/api/tariffs/current`): страница показывает
 * `ends_at`, `next` и `days_left` как есть и не вычитает дни из даты сама.
 */
export function Pricing(): JSX.Element {
  const [tariffs, setTariffs] = useState<Tariff[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  // Счётчик повторов: изменение значения перезапускает загрузку.
  const [attempt, setAttempt] = useState(0);
  const [buying, setBuying] = useState(false);
  const [buyError, setBuyError] = useState('');
  // Тариф, по которому нажали «Купить»: пока он задан, открыто окно подтверждения.
  const [pending, setPending] = useState<Tariff | null>(null);
  // Подписка организации: пока её нет, покупка заполнит текущий слот; после
  // привязки список помечает купленное и предлагает продление.
  const [subscription, setSubscription] = useState<OrganizationTariff | null>(null);
  const { openLogin, openRegister, dialogElement } = useAuthDialog();
  const { status: sessionStatus } = useSession();
  const navigate = useNavigate();

  /**
   * «Купить» открывает окно подтверждения: счёт выставляется не по клику в
   * карточке, а по кнопке в окне, после отметки оферты.
   *
   * Анониму окно не показывается — кнопка по-прежнему открывает регистрацию:
   * счёт выставляется только вошедшему, а форма на самой странице короче похода
   * на главную. Вошедшего после покупки ведёт в раздел «Документы» — именно там
   * виден выставленный счёт.
   *
   * Занятые слоты покупку не гасят: сервер сам решает, куда встанет оплата — в
   * текущий период или в будущий, — а когда заняты оба, он отвечает `409`
   * «Тариф уже оплачен на будущий период», и окно показывает этот текст как есть.
   * Закрытый пробный период тоже не блокирует: `403` обрабатывает `client.ts`
   * (`notifyTrialExpired`).
   */
  function startPurchase(tariff: Tariff): void {
    if (sessionStatus !== 'authenticated') {
      openRegister();
      return;
    }
    if (buying) return;
    setBuyError('');
    setPending(tariff);
  }

  /** Подтверждение в окне: только здесь уходит запрос, уже с отметкой оферты. */
  async function confirmPurchase(): Promise<void> {
    if (buying || pending === null) return;
    setBuying(true);
    setBuyError('');
    try {
      await api.purchaseInvoice({ tariff_id: pending.id, offer_accepted: true });
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
    void api
      .tariffs(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setTariffs(value);
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
   * Подписка организации — чтобы пометить купленное в самом списке и показать
   * срок оплаты.
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
              <p>Платите за то, что ведёте: без установки, доплат за отчёты и скрытых условий.</p>
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

            {status === 'ready' && tariffs.length === 0 && (
              <p className="pricing__note" data-testid="pricing-empty">
                Тарифы ещё не опубликованы
              </p>
            )}

            {status === 'ready' && tariffs.length > 0 && (
              <PricingPlans
                tariffs={tariffs}
                subscription={subscription}
                buying={buying}
                onBuy={startPurchase}
              />
            )}

            {pending !== null && (
              <PurchaseConfirmDialog
                tariff={pending}
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

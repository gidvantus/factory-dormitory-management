import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import type { Tariff } from '../api/client';
import { useSession } from '../auth/SessionProvider';
import { SiteActions } from '../components/SiteActions';
import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/landing/SiteFooter';
import { siteNav } from '../components/siteNav';
import { useAuthDialog } from '../components/useAuthDialog';
import { PricingPlans } from '../components/PricingPlans';

const GENERIC_ERROR = 'Не удалось загрузить тарифы. Проверьте соединение и попробуйте ещё раз.';
const PURCHASE_ERROR = 'Не удалось выставить счёт. Проверьте соединение и попробуйте ещё раз.';

/**
 * Меню шапки страницы тарифов: те же разделы, что на главной, но «Тарифы» здесь
 * лишние — пользователь уже на прайсе.
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
 * помечена подписью «Куплен», а кнопки покупки погашены. Отдельного блока с
 * рассказом про купленный тариф на странице нет — он дублировал бы список.
 */
export function Pricing(): JSX.Element {
  const [tariffs, setTariffs] = useState<Tariff[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  // Счётчик повторов: изменение значения перезапускает загрузку.
  const [attempt, setAttempt] = useState(0);
  const [buying, setBuying] = useState(false);
  const [buyError, setBuyError] = useState('');
  // Тариф организации: пока он пуст, покупка доступна; после привязки список
  // только помечает купленное, а кнопки гаснут.
  const [ownedTariffId, setOwnedTariffId] = useState<number | null>(null);
  const { openLogin, openRegister, dialogElement } = useAuthDialog();
  const { status: sessionStatus } = useSession();
  const navigate = useNavigate();

  /**
   * «Купить» заводит организации счёт за выбранный тариф.
   *
   * Анониму кнопка по-прежнему открывает регистрацию: счёт выставляется только
   * вошедшему, а форма на самой странице короче похода на главную. Вошедшего
   * ведёт в раздел «Документы» — именно там виден выставленный счёт.
   *
   * Закрытый пробный период покупку не блокирует: 403 «пробный период
   * закончился» обрабатывает `client.ts` (`notifyTrialExpired`), а текст отказа
   * от сервера показывается на странице как есть.
   */
  async function buyTariff(tariffId: number): Promise<void> {
    if (sessionStatus !== 'authenticated') {
      openRegister();
      return;
    }
    if (buying) return;
    setBuying(true);
    setBuyError('');
    try {
      await api.purchaseInvoice({ tariff_id: tariffId });
      navigate('/cabinet/documents', { state: { purchased: true } });
    } catch (caught: unknown) {
      setBuyError(purchaseErrorMessage(caught));
      setBuying(false);
    }
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
   * Купленный тариф организации — чтобы пометить его в самом списке.
   *
   * Аноним ничего не покупал, и лишний запрос ему ни к чему. У вошедшего без
   * организации ручка отвечает `404`, а не «нет тарифа», — и это тоже просто
   * «покупать есть что»: страница покупки из-за отказа ручки не ломается.
   */
  useEffect(() => {
    if (sessionStatus !== 'authenticated') {
      setOwnedTariffId(null);
      return;
    }
    const controller = new AbortController();
    void api
      .currentTariff(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setOwnedTariffId(data.tariff ? data.tariff.id : null);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setOwnedTariffId(null);
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
        <section className="section" aria-labelledby="pricing-title">
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
                ownedTariffId={ownedTariffId}
                buying={buying}
                onBuy={(id) => void buyTariff(id)}
              />
            )}

            {buyError && (
              <p className="pricing__error" role="alert" data-testid="pricing-buy-error">
                {buyError}
              </p>
            )}
          </div>
        </section>
      </main>

      <SiteFooter />

      {dialogElement}
    </div>
  );
}

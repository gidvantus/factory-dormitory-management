import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import type { Tariff } from '../api/client';
import { PricingPlans } from '../components/PricingPlans';
import styles from './Workspace.module.css';
import tariffStyles from './Tariffs.module.css';

const LOAD_ERROR = 'Не удалось загрузить тарифы. Проверьте соединение и попробуйте ещё раз.';
const PURCHASE_ERROR = 'Не удалось выставить счёт. Проверьте соединение и попробуйте ещё раз.';

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? 'Сессия завершилась. Войдите в аккаунт снова.' : error.message;
  }
  return fallback;
}

/** Каталог в кабинете: те же тарифы и покупка, что на публичном прайсе. */
export function Tariffs(): JSX.Element {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tariffs, setTariffs] = useState<Tariff[]>([]);
  const [current, setCurrent] = useState<Tariff | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [buying, setBuying] = useState(false);
  const [buyError, setBuyError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    // Покупка доступна только после проверки текущего тарифа организации.
    void Promise.all([api.tariffs(controller.signal), api.currentTariff(controller.signal)])
      .then(([catalog, data]) => {
        if (controller.signal.aborted) return;
        const assigned = data.tariff;
        // Купленный тариф остаётся виден, даже если его сняли с публичной продажи.
        const plans = catalog.map((plan) => (plan.id === assigned?.id ? assigned : plan));
        if (assigned && !plans.some((plan) => plan.id === assigned.id)) plans.push(assigned);
        setTariffs(plans);
        setCurrent(assigned);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(errorMessage(error, LOAD_ERROR));
        setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  async function buyTariff(tariffId: number): Promise<void> {
    if (buying || current || status !== 'ready') return;
    setBuying(true);
    setBuyError('');
    try {
      await api.purchaseInvoice(tariffId);
      navigate('/cabinet/documents', { state: { purchased: true } });
    } catch (error: unknown) {
      setBuyError(errorMessage(error, PURCHASE_ERROR));
      setBuying(false);
    }
  }

  return (
    <section aria-labelledby="tariffs-title" data-testid="tariffs-page">
      <div className={styles['page-heading']}>
        <div>
          <p className={styles.eyebrow}>Рабочее пространство</p>
          <h1 id="tariffs-title" tabIndex={-1}>
            Тарифы
          </h1>
          <p className={styles.subtitle}>
            {status === 'ready' && current
              ? `У вашей организации подключён тариф «${current.name}». Он отмечен в списке.`
              : 'Выберите тариф для вашей организации. Счёт на оплату появится в разделе «Документы».'}
          </p>
        </div>
      </div>

      {status === 'loading' && (
        <p className={styles['view-note']} role="status" data-testid="tariffs-loading">
          Загружаем тарифы…
        </p>
      )}

      {status === 'error' && (
        <div className={styles['organization-error']} role="alert" data-testid="tariffs-error">
          <p>{loadError}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Повторить
          </button>
        </div>
      )}

      {status === 'ready' && tariffs.length > 0 && (
        <PricingPlans
          layout="workspace"
          tariffs={tariffs}
          ownedTariffId={current?.id ?? null}
          buying={buying}
          onBuy={(id) => void buyTariff(id)}
        />
      )}

      {status === 'ready' && tariffs.length === 0 && (
        <p className={styles['view-note']} data-testid="tariffs-empty">
          Тарифы ещё не опубликованы
        </p>
      )}

      {buyError && (
        <p className={tariffStyles.purchaseError} role="alert" data-testid="tariffs-buy-error">
          {buyError}
        </p>
      )}
    </section>
  );
}

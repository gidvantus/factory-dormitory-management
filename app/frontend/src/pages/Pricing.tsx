import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import type { Tariff } from '../api/client';
import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/landing/SiteFooter';

const GENERIC_ERROR = 'Не удалось загрузить тарифы. Проверьте соединение и попробуйте ещё раз.';

/** Текст ошибки: сервер объясняет причину точнее общего «не получилось». */
function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : GENERIC_ERROR;
}

/**
 * Публичная страница тарифов: прайс читается из базы анонимной ручкой.
 *
 * Страница доступна без сессии — как лендинг. `SessionProvider` всё равно
 * сходит на `/api/me` и получит 401: для анонима это нормальное состояние, а не
 * ошибка страницы. Скрытые тарифы сюда не приходят вовсе: их отсекает серверная
 * ручка, а не проверка на клиенте.
 */
export function Pricing(): JSX.Element {
  const [tariffs, setTariffs] = useState<Tariff[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  // Счётчик повторов: изменение значения перезапускает загрузку.
  const [attempt, setAttempt] = useState(0);

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

  return (
    <div className="app" data-testid="pricing">
      <a className="skip-link" href="#main">
        К основному содержанию
      </a>

      <SiteHeader
        actions={
          <Link className="btn btn--outline btn--sm" to="/login" data-testid="pricing-login">
            Войти
          </Link>
        }
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
              <ul className="pricing__grid">
                {tariffs.map((tariff) => (
                  <li className="card pricing__card" key={tariff.id} data-testid="tariff-card">
                    <h3 data-testid="tariff-name">{tariff.name}</h3>
                    <p className="pricing__description" data-testid="tariff-description">
                      {tariff.description}
                    </p>
                    <p className="pricing__price" data-testid="tariff-price">
                      {tariff.price_label}
                    </p>
                    <Link
                      className="btn btn--primary btn--block"
                      to="/register"
                      data-testid="tariff-start"
                    >
                      Начать
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

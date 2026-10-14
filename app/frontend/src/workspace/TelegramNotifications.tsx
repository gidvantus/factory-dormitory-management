import { useEffect, useState } from 'react';

import { api } from '../api/client';
import type { TelegramConnectResult, TelegramStatus } from '../api/client';
import styles from './Workspace.module.css';

/**
 * Как часто переспрашивать статус, пока чат не подключён.
 *
 * Человек в это время уходит в Telegram и отправляет боту код: без опроса
 * карточка осталась бы «не подключено» до перезагрузки страницы. Пять секунд —
 * компромисс между отзывчивостью и лишними запросами; опрос прекращается, как
 * только пришло «подключено», и снимается при уходе со страницы.
 */
const POLL_INTERVAL_MS = 5000;

/** Общий текст ошибки: технических подробностей пользователю не показываем. */
export const TELEGRAM_ERROR_TEXT = 'Не удалось подключить Telegram.';
export const TELEGRAM_DISCONNECT_ERROR_TEXT = 'Не удалось отключить Telegram.';
export const TELEGRAM_TEST_ERROR_TEXT = 'Не удалось отправить тестовое уведомление.';
export const TELEGRAM_TEST_SENT_TEXT = 'Тестовое уведомление отправлено.';

/**
 * Карточка «Уведомления в Telegram» на странице «Личные данные».
 *
 * Три состояния: подключено, не подключено и «код выдан, ждём `/start` в
 * Telegram». Имя бота и ссылку собирает сервер — фронт их не знает, поэтому
 * карточка только показывает то, что пришло в ответе.
 *
 * Отдельный компонент, а не часть `PersonalData`: у него своя загрузка, свои
 * ошибки и свой опрос, и всё это не должно влиять на остальную страницу.
 */
export function TelegramNotifications(): JSX.Element {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<TelegramConnectResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);

  const connected = status?.connected === true;
  // Список подписок сервер присылает всегда; проверка на массив стоит на случай
  // неожиданного ответа — из-за одного поля карточка не должна ронять страницу.
  const subscriptions = Array.isArray(status?.subscriptions) ? status.subscriptions : [];

  useEffect(() => {
    const controller = new AbortController();
    void api
      .telegramStatus(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setStatus(value);
        setLoaded(true);
        setError('');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLoaded(true);
        setError(TELEGRAM_ERROR_TEXT);
      });
    return () => controller.abort();
  }, []);

  // Пока чат не подключён, статус переспрашивается: человек в это время
  // отправляет боту `/start`, и карточка должна переключиться сама.
  useEffect(() => {
    if (connected) return undefined;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void api
        .telegramStatus(controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setStatus(value);
        })
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [connected]);

  async function startConnect(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    setCopied(false);
    try {
      setPending(await api.connectTelegram());
    } catch {
      setError(TELEGRAM_ERROR_TEXT);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.disconnectTelegram();
      setPending(null);
      setStatus(await api.telegramStatus());
    } catch {
      setError(TELEGRAM_DISCONNECT_ERROR_TEXT);
    } finally {
      setBusy(false);
    }
  }

  async function toggleSubscription(kind: string, isEnabled: boolean): Promise<void> {
    setError('');
    try {
      const subscriptions = await api.setTelegramSubscription(kind, isEnabled);
      setStatus((current) => (current ? { ...current, subscriptions } : current));
    } catch {
      setError(TELEGRAM_ERROR_TEXT);
    }
  }

  async function sendTestMessage(): Promise<void> {
    setError('');
    setNotice('');
    try {
      await api.sendTelegramTestMessage();
      setNotice(TELEGRAM_TEST_SENT_TEXT);
    } catch {
      setError(TELEGRAM_TEST_ERROR_TEXT);
    }
  }

  async function copyCode(): Promise<void> {
    if (!pending || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(pending.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      className={`${styles['profile-card']} ${styles['telegram-card']}`}
      aria-labelledby="telegram-card-title"
      data-testid="telegram-card"
    >
      <div className={styles['profile-intro']}>
        <div>
          <h2 id="telegram-card-title">Уведомления в Telegram</h2>
          <p>Сообщения о событиях, которые вас касаются.</p>
        </div>
      </div>

      <div className={styles['telegram-body']}>
        {!loaded && (
          <p className={styles['view-note']} role="status" data-testid="telegram-loading">
            Загружаем настройки Telegram…
          </p>
        )}

        {loaded && (
          <>
            <p className={styles['telegram-status']} data-testid="telegram-status">
              {connected
                ? `Подключено${status?.username ? `: @${status.username}` : ''}`
                : 'Не подключено'}
            </p>

            {!connected && !pending && (
              <div className={styles['telegram-actions']}>
                <button
                  className="btn btn--primary"
                  type="button"
                  data-testid="telegram-connect-button"
                  onClick={() => void startConnect()}
                  disabled={busy}
                >
                  Подключить Telegram
                </button>
              </div>
            )}

            {!connected && pending && (
              <div className={styles['telegram-link']}>
                <p>
                  Отправьте боту команду <code>/start</code> с этим кодом:
                  <code data-testid="telegram-code">{pending.code}</code>
                </p>
                <a
                  className="btn btn--primary"
                  data-testid="telegram-deep-link"
                  href={pending.deep_link}
                  target="_blank"
                  rel="noreferrer"
                >
                  Открыть в Telegram
                </a>
                <button
                  className="btn"
                  type="button"
                  data-testid="telegram-copy-button"
                  onClick={() => void copyCode()}
                >
                  Скопировать код
                </button>
                {copied && (
                  <span className={styles['view-note']} role="status" data-testid="telegram-copied">
                    Код скопирован.
                  </span>
                )}
              </div>
            )}

            {connected && (
              <div className={styles['telegram-actions']}>
                <button
                  className="btn"
                  type="button"
                  data-testid="telegram-disconnect-button"
                  onClick={() => void disconnect()}
                  disabled={busy}
                >
                  Отключить
                </button>
                <button
                  className="btn btn--primary"
                  type="button"
                  data-testid="telegram-test-button"
                  onClick={() => void sendTestMessage()}
                  disabled={busy}
                >
                  Прислать тестовое уведомление
                </button>
              </div>
            )}

            {subscriptions.length > 0 && (
              <ul className={styles['telegram-subscriptions']}>
                {subscriptions.map((subscription) => (
                  <li key={subscription.kind}>
                    <label>
                      <input
                        type="checkbox"
                        data-testid={`telegram-subscription-${subscription.kind}`}
                        checked={subscription.is_enabled}
                        onChange={(event) =>
                          void toggleSubscription(subscription.kind, event.target.checked)
                        }
                      />
                      {subscription.title}
                    </label>
                  </li>
                ))}
              </ul>
            )}

            {error && (
              <p className="alert alert--error" role="alert" data-testid="telegram-error">
                {error}
              </p>
            )}
            {notice && (
              <p className="alert alert--ok" role="status" data-testid="telegram-test-sent">
                {notice}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

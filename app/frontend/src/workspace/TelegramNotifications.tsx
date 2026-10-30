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

/**
 * Как часто пересчитывать срок действия выданного кода.
 *
 * Секунда — чтобы «Код истёк» появлялся без перезагрузки страницы, но не
 * чаще: точнее минуты карточка срок не показывает. Один интервал на компонент,
 * живёт только пока выдан код, снимается при размонтировании.
 */
const EXPIRY_TICK_MS = 1000;

/** Общий текст ошибки: технических подробностей пользователю не показываем. */
export const TELEGRAM_ERROR_TEXT = 'Не удалось подключить Telegram.';
export const TELEGRAM_DISCONNECT_ERROR_TEXT = 'Не удалось отключить Telegram.';
export const TELEGRAM_TEST_ERROR_TEXT = 'Не удалось отправить тестовое уведомление.';
export const TELEGRAM_TEST_SENT_TEXT = 'Тестовое уведомление отправлено.';
export const TELEGRAM_CODE_EXPIRED_TEXT = 'Код истёк — получите новый.';

/**
 * Время окончания кода в локальном часовом поясе: `HH:MM`.
 *
 * `expires_at` приходит ISO-8601 с UTC-смещением, а человеку нужно время своих
 * часов — иначе «до 14:36» соврёт на часовой пояс стенда.
 */
function formatExpiry(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );
}

/**
 * Карточка «Уведомления в Telegram» на странице «Личные данные».
 *
 * Состояния: подключено, не подключено и «код выдан, ждём `/start` в Telegram».
 * В последнем карточка рассказывает, что сделать в чужом приложении: четыре
 * шага с именем бота из ответа сервера, полоса кода, срок действия и кнопки
 * «Открыть в Telegram» / «Получить новый код».
 *
 * Имя бота и ссылку собирает сервер — фронт их не знает, поэтому карточка
 * только показывает то, что пришло в ответе. Тексты, которые бот пишет в чате,
 * здесь не повторяются: их владелец — бэкенд.
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
  const [now, setNow] = useState(() => Date.now());

  const connected = status?.connected === true;
  // Список подписок сервер присылает всегда; проверка на массив стоит на случай
  // неожиданного ответа — из-за одного поля карточка не должна ронять страницу.
  const subscriptions = Array.isArray(status?.subscriptions) ? status.subscriptions : [];
  // Пробелы и ведущую «@» сервер не присылает, но чип должен читаться одинаково
  // при любом ответе: лишняя «@» дала бы «@@бот».
  const botUsername = (status?.bot_username ?? '').trim().replace(/^@/, '');

  // «До 14:36» имеет смысл только когда сервер прислал разбираемую дату.
  const expiresAt = pending ? Date.parse(pending.expires_at) : Number.NaN;
  const hasExpiresAt = Number.isFinite(expiresAt);
  const expired = hasExpiresAt && now > expiresAt;

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

  // Срок действия кода. Интервал нужен только пока карточка ждёт `/start`:
  // при уходе из состояния `pending` и при размонтировании он снимается, иначе
  // карточка тикала бы вхолостую и держала вит-тест.
  useEffect(() => {
    if (!pending) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), EXPIRY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [pending]);

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

  // Два действия под шагами. Порядок в разметке становится порядком на экране,
  // когда на узком экране `telegram-actions` встаёт в столбик, поэтому главное
  // действие идёт первым: пока код действует — «Открыть в Telegram», после
  // истечения — «Получить новый код» (макет #111, кадр «Код истёк»). Мёртвый код
  // отправить не предлагаем: неактивные «Скопировать код» и ссылку заменил
  // активный выпуск нового.
  const deepLinkAction = pending ? (
    <a
      className={expired ? 'btn btn--ghost' : 'btn btn--primary'}
      data-testid="telegram-deep-link"
      href={pending.deep_link}
      target="_blank"
      rel="noreferrer"
      aria-disabled={expired ? true : undefined}
      onClick={expired ? (event) => event.preventDefault() : undefined}
    >
      Открыть в Telegram
    </a>
  ) : null;
  const renewAction = (
    <button
      className={expired ? 'btn btn--primary' : 'btn btn--ghost'}
      type="button"
      data-testid="telegram-renew-button"
      onClick={() => void startConnect()}
      disabled={busy}
    >
      Получить новый код
    </button>
  );

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
              <div className={styles['telegram-pending']}>
                {/* Шаги — основной путь: человек уходит в Telegram и делает это
                    руками. Ссылка ниже только избавляет от ручного ввода. */}
                <ol className={styles['telegram-steps']} data-testid="telegram-steps">
                  <li>Откройте Telegram.</li>
                  <li>
                    {botUsername ? (
                      <>
                        В строке поиска найдите{' '}
                        <code
                          className={styles['telegram-chip']}
                          data-testid="telegram-bot-username"
                        >
                          @{botUsername}
                        </code>{' '}
                        и откройте этого бота.
                      </>
                    ) : (
                      <>В строке поиска найдите бота по ссылке ниже и откройте его.</>
                    )}
                  </li>
                  <li>Нажмите «Start» (в русском интерфейсе — «Запустить»).</li>
                  <li>
                    Отправьте сообщение <code className={styles['telegram-chip']}>/start</code> и
                    код из полосы ниже — одной строкой.
                  </li>
                </ol>

                <div
                  className={`${styles['telegram-code-strip']} ${
                    expired ? styles['telegram-code-strip-expired'] : ''
                  }`}
                >
                  <div className={styles['telegram-code-row']}>
                    <code className={styles['telegram-code']} data-testid="telegram-code">
                      {pending.code}
                    </code>
                    <button
                      className="btn btn--ghost btn--compact"
                      type="button"
                      data-testid="telegram-copy-button"
                      onClick={() => void copyCode()}
                      disabled={expired}
                    >
                      Скопировать код
                    </button>
                  </div>
                  {hasExpiresAt && (
                    <p className={styles['telegram-code-note']} data-testid="telegram-code-expiry">
                      {expired ? (
                        TELEGRAM_CODE_EXPIRED_TEXT
                      ) : (
                        <>
                          Код действует до <strong>{formatExpiry(pending.expires_at)}</strong>
                        </>
                      )}
                    </p>
                  )}
                  {copied && (
                    <span
                      className={styles['view-note']}
                      role="status"
                      data-testid="telegram-copied"
                    >
                      Код скопирован.
                    </span>
                  )}
                </div>

                <p className={styles['telegram-hint']}>
                  Если ссылка открывается, проще нажать кнопку — код подставится сам.
                </p>

                <div className={styles['telegram-actions']}>
                  {expired ? (
                    <>
                      {renewAction}
                      {deepLinkAction}
                    </>
                  ) : (
                    <>
                      {deepLinkAction}
                      {renewAction}
                    </>
                  )}
                </div>
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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { invitationDesigns, invitationHtml } from './templates';
import type { InvitationDesign } from './templates';
import styles from './invitation-preview.module.css';

const favoriteKey = 'domovoy-invitation-favorite';

function Icon({
  name,
}: {
  name: 'home' | 'desktop' | 'mobile' | 'check' | 'grid' | 'arrow';
}): JSX.Element {
  const paths = {
    home: (
      <>
        <path d="m4 10 8-7 8 7" />
        <path d="M6.5 9v11h11V9M10 20v-6h4v6" />
      </>
    ),
    desktop: (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8m-4-4v4" />
      </>
    ),
    mobile: (
      <>
        <rect x="6" y="2" width="12" height="20" rx="2.5" />
        <path d="M10 5h4m-3 14h2" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14m-5-5 5 5-5 5" />
      </>
    ),
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function Miniature({ design }: { design: InvitationDesign }): JSX.Element {
  return (
    <span
      className={`${styles.miniature} ${styles[`miniature${design.id}`]}`}
      style={
        {
          '--mini-accent': design.accent,
          '--mini-paper': design.paper,
          '--mini-ink': design.ink,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <span className={styles.miniBrand} />
      <span className={styles.miniHero}>
        <span />
        <span />
      </span>
      <span className={styles.miniLines}>
        <i />
        <i />
        <i />
      </span>
      <span className={styles.miniButton} />
      <span className={styles.miniFooter} />
    </span>
  );
}

function EmailFrame({
  design,
  onDemo,
}: {
  design: InvitationDesign;
  onDemo: () => void;
}): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(1200);

  useEffect(() => {
    const element = frame.current;
    let observer: ResizeObserver | undefined;
    let cleanupClick: (() => void) | undefined;
    const connect = (): void => {
      observer?.disconnect();
      cleanupClick?.();
      const doc = element?.contentDocument;
      const content = doc?.getElementById('email-root');
      if (!doc || !content) return;
      const measure = (): void => setHeight(Math.ceil(content.getBoundingClientRect().height));
      measure();
      observer = new ResizeObserver(measure);
      observer.observe(content);
      const handleClick = (event: MouseEvent): void => {
        const target = event.target;
        if (target instanceof doc.defaultView!.Element && target.closest('a')) {
          event.preventDefault();
          onDemo();
        }
      };
      doc.addEventListener('click', handleClick);
      cleanupClick = () => doc.removeEventListener('click', handleClick);
    };
    element?.addEventListener('load', connect);
    connect();
    return () => {
      element?.removeEventListener('load', connect);
      observer?.disconnect();
      cleanupClick?.();
    };
  }, [design.id, onDemo]);

  return (
    <iframe
      ref={frame}
      className={styles.emailFrame}
      title={`Письмо №${design.id}: ${design.name}`}
      srcDoc={invitationHtml(design.id)}
      sandbox="allow-same-origin"
      style={{ height }}
    />
  );
}

function readFavorite(): number | null {
  try {
    const stored = Number(localStorage.getItem(favoriteKey));
    return invitationDesigns.some((design) => design.id === stored) ? stored : null;
  } catch {
    return null;
  }
}

export function InvitationPreview(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const variant = Number(params.get('variant')) || 1;
  const selected =
    invitationDesigns.find((design) => design.id === variant) ?? invitationDesigns[0];
  const [mobile, setMobile] = useState(false);
  const [compare, setCompare] = useState(false);
  const [favorite, setFavorite] = useState<number | null>(readFavorite);
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    document.title = '5 вариантов письма-приглашения — Домовой';
    return () => clearTimeout(noticeTimer.current);
  }, []);

  const showDemo = useCallback((): void => {
    clearTimeout(noticeTimer.current);
    setNotice(
      'Это пример письма. В настоящем приглашении ссылка откроет создание пароля и активацию кабинета.',
    );
    noticeTimer.current = setTimeout(() => setNotice(''), 7000);
  }, []);

  function choose(id: number): void {
    const next = favorite === id ? null : id;
    setFavorite(next);
    try {
      if (next === null) localStorage.removeItem(favoriteKey);
      else localStorage.setItem(favoriteKey, String(next));
    } catch {
      // Выбор продолжает работать в текущем окне, если хранилище недоступно.
    }
  }

  function select(id: number): void {
    setParams({ variant: String(id) }, { replace: true });
    setCompare(false);
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          <span className={styles.brandMark}>
            <Icon name="home" />
          </span>
          Домовой
        </Link>
        <span className={styles.headerDivider} />
        <span className={styles.headerLabel}>Примерочная писем</span>
        <span className={styles.testBadge}>
          <span />
          Тестовая страница
        </span>
      </header>

      <main className={styles.main}>
        <div className={styles.intro}>
          <div>
            <p className={styles.breadcrumb}>
              Дизайн для «Домового»<span>/</span>Приглашение сотрудника
            </p>
            <h1>
              Хорошая работа начинается
              <br className={styles.titleBreak} /> с приглашения.
            </h1>
            <p className={styles.lead}>
              Пять вариантов одного письма. Посмотрите, как каждый встречает нового участника вашей
              команды.
            </p>
          </div>
          <div className={styles.introNote}>
            <span className={styles.envelope} aria-hidden="true">
              ✉
            </span>
            <p>
              Одно приглашение.
              <br />
              <strong>Пять первых впечатлений.</strong>
            </p>
          </div>
        </div>

        <div className={styles.workspace}>
          <aside className={styles.sidebar} aria-label="Варианты оформления">
            <div className={styles.sidebarTitle}>
              <h2>Варианты письма</h2>
              <span>5</span>
            </div>
            <nav className={styles.variantList}>
              {invitationDesigns.map((design) => (
                <button
                  key={design.id}
                  type="button"
                  className={`btn btn--quiet ${styles.variant}`}
                  aria-pressed={selected.id === design.id && !compare}
                  onClick={() => select(design.id)}
                >
                  <Miniature design={design} />
                  <span className={styles.variantText}>
                    <span className={styles.variantNumber}>
                      Вариант {design.id}
                      {favorite === design.id && (
                        <span className={styles.favoriteDot} aria-label="Выбранный вариант">
                          <Icon name="check" />
                        </span>
                      )}
                    </span>
                    <strong>{design.name}</strong>
                    <span className={styles.variantNote}>{design.note}</span>
                  </span>
                </button>
              ))}
            </nav>
            <button
              type="button"
              className={`btn btn--choice btn--compact ${styles.compareButton}`}
              aria-pressed={compare}
              onClick={() => setCompare(!compare)}
            >
              <Icon name="grid" />
              {compare ? 'Вернуться к письму' : 'Все пять на одной странице'}
            </button>
            <p className={styles.sidebarHint}>
              В письмах одни и те же данные,
              <br />
              чтобы сравнивать оформление.
            </p>
            {favorite !== null && (
              <div className={styles.savedChoice} role="status">
                <Icon name="check" />
                <span>
                  Ваш выбор — вариант {favorite}
                  <small>Сохранён в этом браузере</small>
                </span>
              </div>
            )}
          </aside>

          <section
            className={styles.stage}
            aria-label={compare ? 'Сравнение пяти писем' : 'Предпросмотр выбранного письма'}
          >
            <div className={styles.stageToolbar}>
              <div>
                <span className={styles.currentNumber}>
                  {compare ? '5 вариантов' : `Вариант ${selected.id} / 5`}
                </span>
                <h2>{compare ? 'Сравните первые впечатления' : selected.name}</h2>
              </div>
              {!compare && (
                <div className={styles.deviceSwitch} role="group" aria-label="Ширина письма">
                  <button
                    type="button"
                    className="btn btn--segment btn--compact"
                    aria-pressed={!mobile}
                    onClick={() => setMobile(false)}
                    title="Письмо на компьютере"
                  >
                    <Icon name="desktop" />
                    <span>Компьютер</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--segment btn--compact"
                    aria-pressed={mobile}
                    onClick={() => setMobile(true)}
                    title="Письмо на телефоне, 375 пикселей"
                  >
                    <Icon name="mobile" />
                    <span>Телефон</span>
                  </button>
                </div>
              )}
            </div>
            <p className={styles.designDescription}>
              {compare
                ? 'Каждое письмо показано целиком. Отметьте понравившийся вариант или откройте его отдельно.'
                : selected.description}
            </p>

            {compare ? (
              <div className={styles.comparison}>
                {invitationDesigns.map((design) => (
                  <article key={design.id} className={styles.comparisonItem}>
                    <div className={styles.comparisonHeading}>
                      <h3>
                        <span>{design.id}</span>
                        {design.name}
                      </h3>
                      <button
                        type="button"
                        className="btn btn--quiet btn--compact"
                        onClick={() => select(design.id)}
                      >
                        Открыть
                        <Icon name="arrow" />
                      </button>
                    </div>
                    <div className={styles.emailPaper}>
                      <EmailFrame design={design} onDemo={showDemo} />
                    </div>
                    <button
                      type="button"
                      className={`btn btn--compact ${favorite === design.id ? 'btn--primary' : 'btn--ink'} ${styles.chooseButton}`}
                      aria-pressed={favorite === design.id}
                      onClick={() => choose(design.id)}
                    >
                      <Icon name="check" />
                      {favorite === design.id
                        ? 'Этот вариант выбран'
                        : `Выбрать вариант ${design.id}`}
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <>
                <div className={styles.mailbox}>
                  <div className={styles.mailMeta}>
                    <span className={styles.senderAvatar}>
                      <Icon name="home" />
                    </span>
                    <div>
                      <p>
                        <strong>Команда «Домового»</strong>
                        <span>сегодня, 10:00</span>
                      </p>
                      <p>
                        Кому: Дмитрий Кириллов{' '}
                        <span className={styles.recipientEmail}>&lt;dmitry@example.com&gt;</span>
                      </p>
                      <h3>Вас пригласили в {`ООО «Северный ресурс»`}</h3>
                    </div>
                    <span className={styles.mailDot} />
                  </div>
                  <div className={`${styles.mailCanvas} ${mobile ? styles.mobileCanvas : ''}`}>
                    <div className={`${styles.emailPaper} ${mobile ? styles.mobilePaper : ''}`}>
                      <EmailFrame design={selected} onDemo={showDemo} />
                    </div>
                  </div>
                </div>
                <div className={styles.selectionBar}>
                  <div>
                    <strong>Нравится это приглашение?</strong>
                    <p>Отметьте вариант, чтобы вернуться к нему позже.</p>
                  </div>
                  <button
                    type="button"
                    className={`btn btn--compact ${favorite === selected.id ? 'btn--primary' : 'btn--ink'} ${styles.chooseButton}`}
                    aria-pressed={favorite === selected.id}
                    onClick={() => choose(selected.id)}
                  >
                    <Icon name="check" />
                    {favorite === selected.id
                      ? `Вариант ${selected.id} выбран`
                      : `Выбрать вариант ${selected.id}`}
                  </button>
                </div>
                <div className={styles.nextDesign}>
                  <span>{selected.id} из 5 вариантов</span>
                  <button
                    type="button"
                    className="btn btn--quiet btn--compact"
                    onClick={() => {
                      select(selected.id === 5 ? 1 : selected.id + 1);
                      document
                        .querySelector(`.${styles.stage}`)
                        ?.scrollIntoView({ behavior: 'instant', block: 'start' });
                    }}
                  >
                    Следующий вариант
                    <Icon name="arrow" />
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
        <footer className={styles.pageFooter}>
          <span>Домовой · Дизайн письма-приглашения</span>
          <span>Демонстрационные данные. Письма не отправляются.</span>
        </footer>
      </main>
      {notice && (
        <div className={styles.notice} role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="btn btn--ink btn--compact"
            aria-label="Закрыть сообщение"
            onClick={() => setNotice('')}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

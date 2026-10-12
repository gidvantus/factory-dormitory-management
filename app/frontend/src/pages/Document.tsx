import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import type { Document as PublicDocument } from '../api/client';
import { SiteHeader } from '../components/SiteHeader';
import { SiteFooter } from '../components/landing/SiteFooter';

const GENERIC_ERROR = 'Не удалось загрузить документ, попробуйте ещё раз';

/**
 * Текст документа в абзацы.
 *
 * Разделитель — пустая строка; лишние пустые строки в тексте схлопываются, чтобы
 * случайный второй перевод строки не превращался в пустой абзац. Разметки здесь
 * нет и быть не должно: текст показывается как plain text, `dangerouslySetInnerHTML`
 * в проекте не используется.
 */
function paragraphsOf(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * Публичная страница документа: `/documents/<код>`.
 *
 * Доступна анонимному посетителю — роут стоит вне `RequireAuth`, как `/pricing`.
 * `SessionProvider` всё равно сходит на `/api/me` и получит 401: для анонима это
 * нормальное состояние, а не ошибка страницы. Текст документа лежит в базе, и
 * правка строки SQL-запросом видна без пересборки фронта.
 */
export function Document(): JSX.Element {
  const { code } = useParams<{ code: string }>();
  const [document, setDocument] = useState<PublicDocument | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setDocument(null);

    if (!code) {
      setStatus('missing');
      return () => controller.abort();
    }

    void api
      .document(code, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setDocument(value);
        setStatus('ready');
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setStatus(caught instanceof ApiError && caught.status === 404 ? 'missing' : 'error');
      });

    return () => controller.abort();
  }, [code]);

  useEffect(() => {
    if (!document) return;
    const previousTitle = window.document.title;
    window.document.title = `${document.title} — Домовой`;
    return () => {
      window.document.title = previousTitle;
    };
  }, [document]);

  return (
    <div className="app" data-testid="document-page">
      <a className="skip-link" href="#main">
        К основному содержанию
      </a>

      <SiteHeader />

      <main className="container document" id="main">
        {status === 'loading' && (
          <p className="document__note" role="status" data-testid="document-loading">
            Загружаем документ…
          </p>
        )}

        {status === 'missing' && (
          <div className="document__note" data-testid="document-missing">
            <h1>Документ не найден</h1>
            <p>Такого документа у Домового нет. Вернитесь на главную и начните оттуда.</p>
            <p>
              <Link className="btn btn--primary" to="/" data-testid="document-home">
                На главную
              </Link>
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="document__note" role="alert" data-testid="document-error">
            <h1>Документ не открылся</h1>
            <p>{GENERIC_ERROR}</p>
          </div>
        )}

        {status === 'ready' && document && (
          <article className="document__body">
            <h1 data-testid="document-title">{document.title}</h1>
            {paragraphsOf(document.body).map((paragraph, index) => (
              <p key={index} data-testid="document-paragraph">
                {paragraph}
              </p>
            ))}
          </article>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}

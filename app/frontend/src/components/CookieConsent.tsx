import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { isConsentGiven, rememberConsent } from '../consent/storage';

const CONSENT_TEXT =
  'Мы используем cookie и локальное хранилище браузера: обязательный сеансовый cookie для входа в систему и настройки интерфейса. Без него вход невозможен. Продолжая работу, вы соглашаетесь с обработкой этих данных.';

/**
 * Немодальная плашка согласия на cookie. Это предупреждение, а не диалог:
 * `role="dialog"`, `aria-modal` и перехват фокуса здесь сознательно не
 * используются — иначе на экране оказалось бы второе окно и тесты кабинета,
 * ищущие `getByRole('dialog')`, сломались бы. Закрыть плашку, не приняв,
 * нельзя: крестика и кликабельного фона у неё нет.
 */
export function CookieConsent(): JSX.Element | null {
  const [given, setGiven] = useState(() => isConsentGiven());
  const bannerRef = useRef<HTMLElement>(null);

  /*
   * Высоту плашки знает только браузер: текст переносится по-разному на разной
   * ширине, а на узком экране плашка ещё и встаёт в колонку. Отдаём измеренную
   * высоту каркасу кабинета переменной `--cookie-consent-height` — боковое меню
   * оставляет под плашку ровно столько места. Без этого фиксированная плашка
   * накрывает «Личные данные» и кнопку «Выйти»: до них не доходят ни клик,
   * ни Tab. Замер идёт до отрисовки, чтобы меню не дёргалось, и снимается
   * вместе с плашкой — приняв согласие, меню возвращается вниз.
   */
  useLayoutEffect(() => {
    const element = bannerRef.current;
    const clear = (): void => {
      document.documentElement.style.removeProperty('--cookie-consent-height');
    };
    if (given || element === null) return clear;

    const publish = (): void => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--cookie-consent-height', `${height}px`);
    };
    publish();
    if (typeof ResizeObserver === 'undefined') return clear;

    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      clear();
    };
  }, [given]);

  if (given) {
    return null;
  }

  const handleAccept = (): void => {
    rememberConsent();
    setGiven(true);
  };

  return (
    <aside
      className="cookie-consent"
      role="region"
      aria-label="Согласие на использование cookie"
      data-testid="cookie-consent"
      ref={bannerRef}
    >
      <p className="cookie-consent__text" data-testid="cookie-consent-text">
        {CONSENT_TEXT}
      </p>
      <div className="cookie-consent__actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          data-testid="cookie-consent-accept"
          onClick={handleAccept}
        >
          Принять
        </button>
        <Link
          className="cookie-consent__link"
          to="/documents/privacy-policy"
          data-testid="cookie-consent-policy"
        >
          Политика конфиденциальности
        </Link>
      </div>
    </aside>
  );
}

import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import { CONSENT_COOKIE } from '../consent/storage';

// jsdom не реализует прокрутку: без заглушки переход по якорю на главной падал бы
// с «scrollIntoView is not a function». Сама прокрутка проверяется на стенде в E2E.
Element.prototype.scrollIntoView = (): void => undefined;

afterEach(() => {
  cleanup();
  // Согласие на cookie живёт в документе и переживает размонтирование:
  // без очистки тест, нажавший «Принять», повлиял бы на следующий тест.
  document.cookie = `${CONSENT_COOKIE}=; path=/; max-age=0`;
});

import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom не реализует прокрутку: без заглушки переход по якорю на главной падал бы
// с «scrollIntoView is not a function». Сама прокрутка проверяется на стенде в E2E.
Element.prototype.scrollIntoView = (): void => undefined;

afterEach(() => {
  cleanup();
});

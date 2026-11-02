import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  // Подменённый fetch и мок-модули живут дольше одного теста: без сброса
  // следующий тест унаследовал бы чужие ответы и результат не был бы герметичным.
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

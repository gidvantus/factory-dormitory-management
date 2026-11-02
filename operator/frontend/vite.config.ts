import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    // Порт стенда основного кабинета — 5173, поэтому dev кабинета оператора
    // поднимается рядом, а не поверх него.
    port: 5174,
    // В dev-режиме фронт тоже ходит на относительный /api — иначе cookie станет
    // third-party и браузер её отбросит. Значение по умолчанию — порт
    // `operator-api` из `.env.example`; на своём стенде он переопределяется
    // переменной окружения, а не правкой кода.
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8002',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

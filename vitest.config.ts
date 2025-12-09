import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./tests/setup/electron-mock.ts'],
    testTimeout: 30000,
    hookTimeout: 10000,
  },
});

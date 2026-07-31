import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@compass/eslint-plugin',
    environment: 'node',
    include: ['tests/**/*.test.js'],
    passWithNoTests: false,
  },
});

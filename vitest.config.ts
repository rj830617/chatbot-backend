import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Integration tests share one Postgres + Firestore emulator.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://chat:chat@localhost:5432/chat?schema=public',
      FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ?? 'chat-backend-dev',
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080',
    },
  },
});

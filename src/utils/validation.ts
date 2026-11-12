import { z } from 'zod';

/** Users and chats are keyed by UUIDs in PostgreSQL. */
export const uuid = z.string().uuid();

/** Firestore auto-generated document IDs (20 chars), but accept any safe ID. */
export const firestoreId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid id');

export const chatIdParams = z.object({ chatId: uuid });
export const userIdParams = z.object({ userId: uuid });
export const messageParams = z.object({ chatId: uuid, messageId: firestoreId });

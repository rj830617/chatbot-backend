import { z } from 'zod';
import { firestoreId, uuid } from '../../utils/validation';

export const MAX_MESSAGE_LENGTH = 4000;
const text = z.string().trim().min(1, 'text must not be empty').max(MAX_MESSAGE_LENGTH);

export const sendMessageBody = z.object({
  senderId: uuid,
  text,
});

export const listMessagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: firestoreId.optional(),
  /** Optional: when provided, the caller must be a member of the chat. */
  userId: uuid.optional(),
});

export const markReadBody = z.object({ userId: uuid });

export const lastSeenBody = z.object({
  userId: uuid,
  messageId: firestoreId,
});

export const editMessageBody = z.object({ userId: uuid, text });

export const deleteMessageBody = z.object({ userId: uuid });

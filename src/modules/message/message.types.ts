import type { Timestamp } from 'firebase-admin/firestore';

/** Shape of chats/{chatId}/messages/{messageId} in Firestore. */
export interface MessageDoc {
  senderId: string;
  text: string;
  createdAt: Timestamp;
  editedAt: Timestamp | null;
  deleted: boolean;
  deletedAt: Timestamp | null;
  /** Read receipts: userId -> time the user first read the message. */
  readBy: Record<string, Timestamp>;
}

/** Shape of chats/{chatId}/members/{userId} in Firestore. */
export interface MemberStateDoc {
  lastSeenMessageId: string;
  /** createdAt of the last seen message; used to stop last seen moving backwards. */
  lastSeenAt: Timestamp;
  updatedAt: Timestamp;
}

export interface MessageDto {
  id: string;
  chatId: string;
  senderId: string;
  text: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  readBy: Record<string, string>;
}

export interface LastSeenDto {
  userId: string;
  lastSeenMessageId: string;
  lastSeenAt: string;
  updatedAt: string;
}

import {
  FieldPath,
  FieldValue,
  type Timestamp,
  type CollectionReference,
  type DocumentReference,
  type DocumentSnapshot,
} from 'firebase-admin/firestore';
import { firestore } from '../../config/firebase';
import { AppError } from '../../utils/AppError';
import type { LastSeenDto, MemberStateDoc, MessageDoc, MessageDto } from './message.types';

// ---------------------------------------------------------------------------
// Firestore references
// ---------------------------------------------------------------------------

function messagesCol(chatId: string): CollectionReference<MessageDoc> {
  return firestore.collection('chats').doc(chatId).collection('messages') as CollectionReference<MessageDoc>;
}

function memberStateRef(chatId: string, userId: string): DocumentReference<MemberStateDoc> {
  return firestore
    .collection('chats')
    .doc(chatId)
    .collection('members')
    .doc(userId) as DocumentReference<MemberStateDoc>;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function iso(ts: Timestamp): string {
  return ts.toDate().toISOString();
}

export function toMessageDto(chatId: string, id: string, doc: MessageDoc): MessageDto {
  const readBy: Record<string, string> = {};
  for (const [userId, ts] of Object.entries(doc.readBy ?? {})) readBy[userId] = iso(ts);
  return {
    id,
    chatId,
    senderId: doc.senderId,
    text: doc.text,
    createdAt: iso(doc.createdAt),
    editedAt: doc.editedAt ? iso(doc.editedAt) : null,
    deleted: doc.deleted,
    readBy,
  };
}

function toLastSeenDto(userId: string, doc: MemberStateDoc): LastSeenDto {
  return {
    userId,
    lastSeenMessageId: doc.lastSeenMessageId,
    lastSeenAt: iso(doc.lastSeenAt),
    updatedAt: iso(doc.updatedAt),
  };
}

function requireMessage(snap: DocumentSnapshot<MessageDoc>, chatId: string): MessageDoc {
  const data = snap.data();
  if (!snap.exists || !data) throw AppError.notFound(`Message ${snap.id} not found in chat ${chatId}`);
  return data;
}

/** Compare two Firestore timestamps with full (nanosecond) precision. */
export function compareTimestamps(a: Timestamp, b: Timestamp): number {
  return a.seconds !== b.seconds ? a.seconds - b.seconds : a.nanoseconds - b.nanoseconds;
}

/**
 * Last seen only moves forward. Message A is "later" than B when it was created
 * later, with the document ID as a tiebreaker (same ordering as listMessages).
 */
export function isNewerPosition(
  candidate: { createdAt: Timestamp; messageId: string },
  current: { createdAt: Timestamp; messageId: string },
): boolean {
  const cmp = compareTimestamps(candidate.createdAt, current.createdAt);
  if (cmp !== 0) return cmp > 0;
  return candidate.messageId > current.messageId;
}

// ---------------------------------------------------------------------------
// API 2: send message
// ---------------------------------------------------------------------------

export async function sendMessage(chatId: string, senderId: string, text: string): Promise<MessageDto> {
  const ref = messagesCol(chatId).doc();
  // serverTimestamp() gives one authoritative clock for ordering, regardless of client clocks.
  // The sender has implicitly read their own message.
  await ref.set({
    senderId,
    text,
    createdAt: FieldValue.serverTimestamp() as unknown as Timestamp,
    editedAt: null,
    deleted: false,
    deletedAt: null,
    readBy: { [senderId]: FieldValue.serverTimestamp() as unknown as Timestamp },
  });
  const snap = await ref.get();
  return toMessageDto(chatId, ref.id, requireMessage(snap, chatId));
}

// ---------------------------------------------------------------------------
// API 3: list messages (ordered by timestamp, cursor pagination)
// ---------------------------------------------------------------------------

export interface MessagePage {
  messages: MessageDto[];
  /** Pass as `before` to fetch the next (older) page; null when there are no more. */
  nextCursor: string | null;
}

export async function listMessages(chatId: string, limit: number, before?: string): Promise<MessagePage> {
  let query = messagesCol(chatId).orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');

  if (before) {
    const cursorSnap = await messagesCol(chatId).doc(before).get();
    if (!cursorSnap.exists) throw AppError.notFound(`Cursor message ${before} not found in chat ${chatId}`);
    query = query.startAfter(cursorSnap);
  }

  // Fetch one extra document to know whether an older page exists.
  const snap = await query.limit(limit + 1).get();
  const docs = snap.docs.slice(0, limit);
  const hasMore = snap.docs.length > limit;
  const oldest = docs[docs.length - 1];

  return {
    // Newest-first from Firestore; return oldest -> newest (chronological).
    messages: docs.map((d) => toMessageDto(chatId, d.id, d.data())).reverse(),
    nextCursor: hasMore && oldest ? oldest.id : null,
  };
}

// ---------------------------------------------------------------------------
// API 4: mark message read (read receipt)
// ---------------------------------------------------------------------------

export interface ReadReceiptDto {
  messageId: string;
  userId: string;
  readAt: string;
  /** false when the user had already read the message (first read time is kept). */
  updated: boolean;
}

export async function markMessageRead(
  chatId: string,
  messageId: string,
  userId: string,
): Promise<ReadReceiptDto> {
  const ref = messagesCol(chatId).doc(messageId);

  const updated = await firestore.runTransaction(async (tx) => {
    const message = requireMessage(await tx.get(ref), chatId);
    if (message.readBy?.[userId]) return false; // idempotent: keep the first read time
    tx.update(ref, new FieldPath('readBy', userId), FieldValue.serverTimestamp());
    return true;
  });

  const message = requireMessage(await ref.get(), chatId);
  const readAt = message.readBy[userId];
  if (!readAt) throw new Error('Read receipt was not persisted');
  return { messageId, userId, readAt: iso(readAt), updated };
}

// ---------------------------------------------------------------------------
// API 5: update last seen message
// ---------------------------------------------------------------------------

export interface LastSeenResult extends LastSeenDto {
  /** false when the request pointed at an older message than the stored one. */
  updated: boolean;
}

export async function updateLastSeen(
  chatId: string,
  userId: string,
  messageId: string,
): Promise<LastSeenResult> {
  const msgRef = messagesCol(chatId).doc(messageId);
  const stateRef = memberStateRef(chatId, userId);

  const updated = await firestore.runTransaction(async (tx) => {
    // All reads must happen before writes in a Firestore transaction.
    const [msgSnap, stateSnap] = await Promise.all([tx.get(msgRef), tx.get(stateRef)]);
    const message = requireMessage(msgSnap, chatId);
    const current = stateSnap.data();

    if (
      current &&
      !isNewerPosition(
        { createdAt: message.createdAt, messageId },
        { createdAt: current.lastSeenAt, messageId: current.lastSeenMessageId },
      )
    ) {
      return false;
    }

    tx.set(stateRef, {
      lastSeenMessageId: messageId,
      lastSeenAt: message.createdAt,
      updatedAt: FieldValue.serverTimestamp() as unknown as Timestamp,
    });
    return true;
  });

  const state = (await stateRef.get()).data();
  if (!state) throw new Error('Last seen state was not persisted');
  return { ...toLastSeenDto(userId, state), updated };
}

export async function getLastSeenForChat(chatId: string): Promise<LastSeenDto[]> {
  const snap = await firestore.collection('chats').doc(chatId).collection('members').get();
  return snap.docs.map((d) => toLastSeenDto(d.id, d.data() as MemberStateDoc));
}

// ---------------------------------------------------------------------------
// Bonus: edit / delete
// ---------------------------------------------------------------------------

export async function editMessage(
  chatId: string,
  messageId: string,
  userId: string,
  text: string,
): Promise<MessageDto> {
  const ref = messagesCol(chatId).doc(messageId);
  await firestore.runTransaction(async (tx) => {
    const message = requireMessage(await tx.get(ref), chatId);
    if (message.senderId !== userId) throw AppError.forbidden('Only the sender can edit this message');
    if (message.deleted) throw AppError.conflict('Cannot edit a deleted message');
    tx.update(ref, { text, editedAt: FieldValue.serverTimestamp() });
  });
  return toMessageDto(chatId, messageId, requireMessage(await ref.get(), chatId));
}

/** Soft delete: keeps the document so ordering, cursors and receipts stay valid. */
export async function deleteMessage(chatId: string, messageId: string, userId: string): Promise<MessageDto> {
  const ref = messagesCol(chatId).doc(messageId);
  await firestore.runTransaction(async (tx) => {
    const message = requireMessage(await tx.get(ref), chatId);
    if (message.senderId !== userId) throw AppError.forbidden('Only the sender can delete this message');
    if (message.deleted) return;
    tx.update(ref, { text: '', deleted: true, deletedAt: FieldValue.serverTimestamp() });
  });
  return toMessageDto(chatId, messageId, requireMessage(await ref.get(), chatId));
}

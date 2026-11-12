import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { directKeyFor } from '../src/modules/chat/chat.service';
import { compareTimestamps, isNewerPosition } from '../src/modules/message/message.service';
import { listMessagesQuery, sendMessageBody } from '../src/modules/message/message.schemas';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('directKeyFor', () => {
  it('is independent of argument order', () => {
    expect(directKeyFor(A, B)).toBe(directKeyFor(B, A));
    expect(directKeyFor(B, A)).toBe(`${A}:${B}`);
  });
});

describe('last seen ordering', () => {
  const t1 = new Timestamp(100, 500);
  const t2 = new Timestamp(100, 501);
  const t3 = new Timestamp(101, 0);

  it('compares timestamps with nanosecond precision', () => {
    expect(compareTimestamps(t1, t2)).toBeLessThan(0);
    expect(compareTimestamps(t3, t2)).toBeGreaterThan(0);
    expect(compareTimestamps(t1, new Timestamp(100, 500))).toBe(0);
  });

  it('only accepts strictly newer positions', () => {
    expect(isNewerPosition({ createdAt: t2, messageId: 'a' }, { createdAt: t1, messageId: 'z' })).toBe(true);
    expect(isNewerPosition({ createdAt: t1, messageId: 'z' }, { createdAt: t2, messageId: 'a' })).toBe(false);
    // Same timestamp: document ID breaks the tie.
    expect(isNewerPosition({ createdAt: t1, messageId: 'b' }, { createdAt: t1, messageId: 'a' })).toBe(true);
    // Same message is not "newer".
    expect(isNewerPosition({ createdAt: t1, messageId: 'a' }, { createdAt: t1, messageId: 'a' })).toBe(false);
  });
});

describe('schemas', () => {
  it('defaults and caps the message page size', () => {
    expect(listMessagesQuery.parse({}).limit).toBe(50);
    expect(listMessagesQuery.parse({ limit: '10' }).limit).toBe(10);
    expect(listMessagesQuery.safeParse({ limit: '1000' }).success).toBe(false);
    expect(listMessagesQuery.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('rejects blank messages and non-UUID senders', () => {
    expect(sendMessageBody.safeParse({ senderId: A, text: '   ' }).success).toBe(false);
    expect(sendMessageBody.safeParse({ senderId: 'bob', text: 'hi' }).success).toBe(false);
    expect(sendMessageBody.parse({ senderId: A, text: '  hi  ' }).text).toBe('hi');
  });
});

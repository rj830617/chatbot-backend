/**
 * Integration tests: run against a real PostgreSQL and the Firestore emulator.
 *   docker compose up -d && npx prisma migrate deploy
 *   npm run emulator            (in another terminal)
 *   npm test
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';

const app = createApp();

interface UserDto {
  id: string;
  name: string;
}
interface MessageDto {
  id: string;
  senderId: string;
  text: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  readBy: Record<string, string>;
}

async function createUser(name: string): Promise<UserDto> {
  const res = await request(app).post('/user').send({ name }).expect(201);
  return (res.body as { data: UserDto }).data;
}

async function createChat(a: string, b: string): Promise<string> {
  const res = await request(app).post('/chat/create').send({ userAId: a, userBId: b });
  expect([200, 201]).toContain(res.status);
  return (res.body as { data: { chatId: string } }).data.chatId;
}

async function send(chatId: string, senderId: string, text: string): Promise<MessageDto> {
  const res = await request(app).post(`/chat/${chatId}/message/send`).send({ senderId, text }).expect(201);
  return (res.body as { data: MessageDto }).data;
}

async function clearFirestore(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const project = process.env.FIREBASE_PROJECT_ID;
  await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, {
    method: 'DELETE',
  });
}

let alice: UserDto;
let bob: UserDto;
let carol: UserDto;

beforeAll(async () => {
  await clearFirestore();
  [alice, bob, carol] = await Promise.all([createUser('Alice'), createUser('Bob'), createUser('Carol')]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /health', () => {
  it('reports both stores up', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ data: { postgres: 'ok', firestore: 'ok' } });
  });
});

describe('POST /chat/create', () => {
  it('creates a chat once and returns the same chat for either argument order', async () => {
    const first = await request(app).post('/chat/create').send({ userAId: alice.id, userBId: bob.id });
    expect(first.status).toBe(201);
    expect(first.body.data.created).toBe(true);

    const again = await request(app).post('/chat/create').send({ userAId: bob.id, userBId: alice.id });
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ chatId: first.body.data.chatId, created: false });
  });

  it('returns a single chat under concurrent creation', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post('/chat/create').send({ userAId: alice.id, userBId: carol.id }),
      ),
    );
    const ids = new Set(results.map((r) => r.body.data.chatId as string));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it('validates input', async () => {
    await request(app).post('/chat/create').send({ userAId: alice.id, userBId: alice.id }).expect(400);
    await request(app).post('/chat/create').send({ userAId: 'x', userBId: bob.id }).expect(400);
    await request(app)
      .post('/chat/create')
      .send({ userAId: alice.id, userBId: '99999999-9999-4999-8999-999999999999' })
      .expect(404);
  });
});

describe('messages', () => {
  it('sends messages and lists them in timestamp order with pagination', async () => {
    const [u1, u2] = await Promise.all([createUser('P1'), createUser('P2')]);
    const chatId = await createChat(u1.id, u2.id);
    const sent: MessageDto[] = [];
    for (let i = 1; i <= 5; i++) {
      sent.push(await send(chatId, i % 2 ? u1.id : u2.id, `msg ${i}`));
    }
    expect(sent[0]?.readBy[u1.id]).toBeDefined();

    const page1 = await request(app).get(`/chat/${chatId}/messages?limit=3`).expect(200);
    expect(page1.body.data.messages.map((m: MessageDto) => m.text)).toEqual(['msg 3', 'msg 4', 'msg 5']);
    expect(page1.body.data.nextCursor).toBe(sent[2]?.id);

    const page2 = await request(app)
      .get(`/chat/${chatId}/messages?limit=3&before=${page1.body.data.nextCursor as string}`)
      .expect(200);
    expect(page2.body.data.messages.map((m: MessageDto) => m.text)).toEqual(['msg 1', 'msg 2']);
    expect(page2.body.data.nextCursor).toBeNull();

    const all = await request(app).get(`/chat/${chatId}/messages`).expect(200);
    const times = all.body.data.messages.map((m: MessageDto) => Date.parse(m.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('rejects non-members and unknown chats', async () => {
    const chatId = await createChat(alice.id, bob.id);
    await request(app)
      .post(`/chat/${chatId}/message/send`)
      .send({ senderId: carol.id, text: 'hi' })
      .expect(403);
    await request(app).get(`/chat/${chatId}/messages?userId=${carol.id}`).expect(403);
    await request(app)
      .post('/chat/99999999-9999-4999-8999-999999999999/message/send')
      .send({ senderId: alice.id, text: 'hi' })
      .expect(404);
  });
});

describe('read receipts', () => {
  it('marks a message read idempotently, keeping the first read time', async () => {
    const chatId = await createChat(alice.id, bob.id);
    const msg = await send(chatId, alice.id, 'read me');

    const first = await request(app)
      .post(`/chat/${chatId}/message/${msg.id}/read`)
      .send({ userId: bob.id })
      .expect(200);
    expect(first.body.data.updated).toBe(true);

    const second = await request(app)
      .post(`/chat/${chatId}/message/${msg.id}/read`)
      .send({ userId: bob.id })
      .expect(200);
    expect(second.body.data.updated).toBe(false);
    expect(second.body.data.readAt).toBe(first.body.data.readAt);

    const list = await request(app).get(`/chat/${chatId}/messages`).expect(200);
    const stored = (list.body.data.messages as MessageDto[]).find((m) => m.id === msg.id);
    expect(Object.keys(stored?.readBy ?? {}).sort()).toEqual([alice.id, bob.id].sort());
  });

  it('404s for unknown messages and 403s for non-members', async () => {
    const chatId = await createChat(alice.id, bob.id);
    const msg = await send(chatId, alice.id, 'x');
    await request(app).post(`/chat/${chatId}/message/doesNotExist/read`).send({ userId: bob.id }).expect(404);
    await request(app).post(`/chat/${chatId}/message/${msg.id}/read`).send({ userId: carol.id }).expect(403);
  });
});

describe('last seen', () => {
  it('moves forward but never backwards', async () => {
    const chatId = await createChat(bob.id, carol.id);
    const older = await send(chatId, bob.id, 'older');
    const newer = await send(chatId, bob.id, 'newer');

    const r1 = await request(app)
      .post(`/chat/${chatId}/lastseen`)
      .send({ userId: carol.id, messageId: newer.id })
      .expect(200);
    expect(r1.body.data).toMatchObject({ lastSeenMessageId: newer.id, updated: true });

    const r2 = await request(app)
      .post(`/chat/${chatId}/lastseen`)
      .send({ userId: carol.id, messageId: older.id })
      .expect(200);
    expect(r2.body.data).toMatchObject({ lastSeenMessageId: newer.id, updated: false });

    const all = await request(app).get(`/chat/${chatId}/lastseen`).expect(200);
    expect(all.body.data).toEqual([
      expect.objectContaining({ userId: carol.id, lastSeenMessageId: newer.id }),
    ]);
  });
});

describe('GET /user/:userId/chats', () => {
  it('lists chats with member IDs', async () => {
    const dave = await createUser('Dave');
    const chatId = await createChat(dave.id, alice.id);
    const res = await request(app).get(`/user/${dave.id}/chats`).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ chatId, type: 'DIRECT' });
    expect([...res.body.data[0].memberIds].sort()).toEqual([dave.id, alice.id].sort());
  });

  it('404s for unknown users', async () => {
    await request(app).get('/user/99999999-9999-4999-8999-999999999999/chats').expect(404);
  });
});

describe('bonus: groups', () => {
  it('creates and manages a group', async () => {
    const created = await request(app)
      .post('/chat/group')
      .send({ name: 'Team', creatorId: alice.id, memberIds: [bob.id] })
      .expect(201);
    const chatId = created.body.data.chatId as string;
    expect(created.body.data.members).toEqual([
      expect.objectContaining({ userId: alice.id, role: 'ADMIN' }),
      expect.objectContaining({ userId: bob.id, role: 'MEMBER' }),
    ]);

    // Only admins add members / rename.
    await request(app)
      .post(`/chat/${chatId}/members`)
      .send({ actorId: bob.id, userIds: [carol.id] })
      .expect(403);
    const added = await request(app)
      .post(`/chat/${chatId}/members`)
      .send({ actorId: alice.id, userIds: [carol.id] })
      .expect(200);
    expect(added.body.data.memberIds).toContain(carol.id);

    const renamed = await request(app)
      .patch(`/chat/${chatId}`)
      .send({ actorId: alice.id, name: 'Core' })
      .expect(200);
    expect(renamed.body.data.name).toBe('Core');

    // Group messaging works like 1:1.
    await send(chatId, carol.id, 'hello group');

    // Admin leaves -> oldest remaining member is promoted.
    const left = await request(app)
      .delete(`/chat/${chatId}/members/${alice.id}`)
      .send({ actorId: alice.id })
      .expect(200);
    expect(left.body.data.members).toContainEqual(expect.objectContaining({ userId: bob.id, role: 'ADMIN' }));
  });

  it('refuses group operations on direct chats', async () => {
    const chatId = await createChat(alice.id, bob.id);
    await request(app).patch(`/chat/${chatId}`).send({ actorId: alice.id, name: 'x' }).expect(400);
  });
});

describe('bonus: edit / delete', () => {
  it('lets only the sender edit and soft-delete', async () => {
    const chatId = await createChat(alice.id, bob.id);
    const msg = await send(chatId, alice.id, 'typo');

    await request(app)
      .patch(`/chat/${chatId}/message/${msg.id}`)
      .send({ userId: bob.id, text: 'hacked' })
      .expect(403);

    const edited = await request(app)
      .patch(`/chat/${chatId}/message/${msg.id}`)
      .send({ userId: alice.id, text: 'fixed' })
      .expect(200);
    expect(edited.body.data).toMatchObject({ text: 'fixed', deleted: false });
    expect(edited.body.data.editedAt).not.toBeNull();

    const deleted = await request(app)
      .delete(`/chat/${chatId}/message/${msg.id}`)
      .send({ userId: alice.id })
      .expect(200);
    expect(deleted.body.data).toMatchObject({ text: '', deleted: true });

    await request(app)
      .patch(`/chat/${chatId}/message/${msg.id}`)
      .send({ userId: alice.id, text: 'again' })
      .expect(409);
  });
});

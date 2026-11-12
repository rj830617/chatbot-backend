# Chat Backend: PostgreSQL + Firebase Firestore

A chat backend written in Node.js and **TypeScript (strict)**. It uses two stores:

| Store          | Holds                                    | Why                                                                          |
| -------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| **PostgreSQL** | users, chats, chat membership            | Relational data with constraints: unique 1:1 chats, foreign keys, roles.     |
| **Firestore**  | messages, read receipts, last-seen state | High-volume, append-heavy and real-time friendly. Clients can subscribe directly. |

It supports 1:1 chats, sending messages, ordered and paginated history, read receipts, last-seen tracking and listing a user's chats.
It also implements both bonus features: **group chats** and **message edit and delete**.

---

## Quick start

Prerequisites: Node 20+, Docker, and Java 11+ (Java is only needed for the Firestore emulator).

```bash
npm install
cp .env.example .env

docker compose up -d          # PostgreSQL on :5432
npm run emulator              # Firestore emulator on :8080 (separate terminal)

npx prisma migrate deploy     # create tables
npm run db:seed               # optional: 3 demo users (Alice, Bob, Carol)

npm run dev                   # http://localhost:3000
```

To use a **real Firebase project** instead of the emulator, remove `FIRESTORE_EMULATOR_HOST` from `.env` and set
`GOOGLE_APPLICATION_CREDENTIALS` to the path of a service-account JSON key.

### Scripts

| Command                         | Description                                     |
| ------------------------------- | ----------------------------------------------- |
| `npm run dev`                   | Start with hot reload (tsx)                     |
| `npm run build` / `npm start`   | Compile to `dist/` and run                      |
| `npm test`                      | Unit and integration tests (needs Postgres and the emulator) |
| `npm run typecheck` / `npm run lint` | Strict TypeScript check / ESLint           |

---

## API

All request and response bodies are JSON. Successful responses use the shape `{ "data": ... }`.
Errors use the shape `{ "error": { "code", "message", "details?" } }`, with these status codes:
`400 VALIDATION_ERROR | BAD_REQUEST`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT`, `500 INTERNAL`.

User and chat IDs are UUIDs. Message IDs are Firestore document IDs.

### Required endpoints

| #   | Method & path                                | Body / query                    | Result                                                    |
| --- | -------------------------------------------- | ------------------------------- | --------------------------------------------------------- |
| 1   | `POST /chat/create`                          | `{ userAId, userBId }`          | `{ chatId, created }`: `201` when new, `200` when it already existed |
| 2   | `POST /chat/:chatId/message/send`            | `{ senderId, text }`            | `201` with the stored message (server timestamp)          |
| 3   | `GET /chat/:chatId/messages`                 | `?limit=50&before=<msgId>&userId=<uuid>` | `{ messages (oldest → newest), nextCursor }`     |
| 4   | `POST /chat/:chatId/message/:messageId/read` | `{ userId }`                    | `{ messageId, userId, readAt, updated }`                  |
| 5   | `POST /chat/:chatId/lastseen`                | `{ userId, messageId }`         | `{ userId, lastSeenMessageId, lastSeenAt, updated }`      |
| 6   | `GET /user/:userId/chats`                    | –                               | `[{ chatId, type, name, memberIds, createdAt }]`          |

### Supporting and bonus endpoints

| Method & path                                  | Body                                | Notes                                         |
| ---------------------------------------------- | ----------------------------------- | --------------------------------------------- |
| `POST /user`                                   | `{ name }`                          | Create a user                                 |
| `GET /user/:userId`                            | –                                   | Get a user                                    |
| `GET /chat/:chatId`                            | –                                   | Chat details with members and roles           |
| `GET /chat/:chatId/lastseen`                   | –                                   | Last-seen state of every member               |
| `POST /chat/group`                             | `{ name, creatorId, memberIds[] }`  | The creator becomes `ADMIN`                   |
| `PATCH /chat/:chatId`                          | `{ actorId, name }`                 | Rename a group (admin only)                   |
| `POST /chat/:chatId/members`                   | `{ actorId, userIds[] }`            | Add members (admin only)                      |
| `DELETE /chat/:chatId/members/:userId`         | `{ actorId }`                       | Remove a member (admin) or leave (self)       |
| `PATCH /chat/:chatId/message/:messageId`       | `{ userId, text }`                  | Edit a message (sender only). Sets `editedAt` |
| `DELETE /chat/:chatId/message/:messageId`      | `{ userId }`                        | Soft delete (sender only)                     |
| `GET /health`                                  | –                                   | Checks Postgres and Firestore                 |

### Example

```bash
A=$(curl -s -XPOST localhost:3000/user -H 'content-type: application/json' -d '{"name":"Alice"}' | jq -r .data.id)
B=$(curl -s -XPOST localhost:3000/user -H 'content-type: application/json' -d '{"name":"Bob"}'   | jq -r .data.id)

CHAT=$(curl -s -XPOST localhost:3000/chat/create -H 'content-type: application/json' \
  -d "{\"userAId\":\"$A\",\"userBId\":\"$B\"}" | jq -r .data.chatId)

MSG=$(curl -s -XPOST localhost:3000/chat/$CHAT/message/send -H 'content-type: application/json' \
  -d "{\"senderId\":\"$A\",\"text\":\"Hi Bob!\"}" | jq -r .data.id)

curl -s "localhost:3000/chat/$CHAT/messages?limit=50"
curl -s -XPOST localhost:3000/chat/$CHAT/message/$MSG/read -H 'content-type: application/json' -d "{\"userId\":\"$B\"}"
curl -s -XPOST localhost:3000/chat/$CHAT/lastseen -H 'content-type: application/json' -d "{\"userId\":\"$B\",\"messageId\":\"$MSG\"}"
curl -s localhost:3000/user/$B/chats
```

---

## Data model

### PostgreSQL ([prisma/schema.prisma](prisma/schema.prisma))

```
users(id uuid PK, name, created_at)
chats(id uuid PK, type DIRECT|GROUP, name?, direct_key UNIQUE?, created_by?, created_at)
chat_members(chat_id FK, user_id FK, role ADMIN|MEMBER, joined_at, PK(chat_id, user_id), INDEX(user_id))
```

### Firestore

```
chats/{chatId}/messages/{messageId}
    senderId, text, createdAt (server timestamp), editedAt, deleted, deletedAt,
    readBy: { [userId]: Timestamp }          ← read receipts
chats/{chatId}/members/{userId}
    lastSeenMessageId, lastSeenAt, updatedAt ← last seen per user
```

Firestore documents are keyed by the Postgres `chatId`. Postgres is the source of truth for whether a chat exists and who belongs to it.

---

## Design decisions

- **1:1 chats can't be duplicated, even under concurrency.** Each direct chat stores `direct_key = sorted(userA, userB).join(':')`, which has a `UNIQUE` constraint. The order of the two IDs doesn't matter. If two requests race, the losing insert gets `P2002` and returns the winner's chat. A test fires 5 concurrent requests and checks that exactly one chat is created.
- **Ordering uses the server clock.** `createdAt` is set with `FieldValue.serverTimestamp()`, so client clocks have no effect. Queries order by `createdAt DESC, __name__ DESC`. The document ID breaks ties, so the order is total and stable.
- **Pagination uses a cursor, not an offset.** `before=<messageId>` maps to `startAfter(snapshot)`. The server fetches `limit + 1` documents to know whether `nextCursor` should be set. Each page is returned oldest → newest, ready to render.
- **Read receipts are a `readBy` map on each message.** One read returns a message together with its receipts. Marking a message read runs in a transaction and is idempotent: the *first* read time is kept, and `updated: false` reports a repeat. The sender is marked as having read their own message.
- **Last seen only moves forward.** A transaction compares the stored position `(lastSeenAt, messageId)` with the new message's position, using nanosecond-precise timestamps. A delayed or out-of-order request can't move last seen back to an older message. It returns `updated: false` instead.
- **Every operation checks membership.** Each chat operation verifies membership in Postgres. A missing chat returns `404` and a non-member returns `403`. The assignment passes user IDs in the request body, so there is no auth layer. A JWT middleware could replace those body IDs without changing the services.
- **Deletes are soft.** A deleted message keeps its document, with `deleted: true` and empty `text`, so cursors, ordering and receipts stay valid.
- **Groups.** The creator is `ADMIN`. Only admins can add members, remove other members or rename the group. Anyone can leave. If the last admin leaves, the longest-standing member is promoted. Group operations on a direct chat return `400`.
- **Strict typing.** The compiler runs with `strict`, `noUncheckedIndexedAccess` and no `any`. Request types are inferred from zod schemas, and Firestore collections are typed with `CollectionReference<MessageDoc>`.

## Project layout

```
src/
  config/        env (zod-validated), prisma, firebase, logger
  middleware/    error handler (AppError, ZodError, Prisma, bad JSON → JSON errors)
  modules/
    chat/        routes, controller, service (PostgreSQL), schemas, types
    message/     controller, service (Firestore), schemas, types
    user/        routes, controller, service
  utils/         AppError, asyncHandler, shared validators
  app.ts         express app factory (used by tests)
  server.ts      bootstrap + graceful shutdown
tests/
  unit.test.ts   directKey, last-seen ordering, schemas
  api.test.ts    end-to-end against Postgres + Firestore emulator
```

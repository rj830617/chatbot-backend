# Chat Backend: Implementation Plan

## 1. Goal

Build a chat backend in Node.js and TypeScript with two stores:

- **PostgreSQL** (relational) holds users, chats and chat membership.
- **Firebase Firestore** holds messages, read receipts and last-seen state.

Required features: 1:1 chats, sending messages, ordered message retrieval, read receipts, last-seen tracking and listing a user's chats.
Optional extras: group chats, plus message edit and delete.

## 2. Tech Stack

| Concern            | Choice                                                    |
| ------------------ | --------------------------------------------------------- |
| Runtime / language | Node.js 20+, TypeScript (`strict: true`)                  |
| HTTP framework     | Express                                                   |
| Relational DB      | PostgreSQL 16, accessed through Prisma ORM (typed client) |
| Document DB        | Firestore through `firebase-admin`                        |
| Validation         | `zod`, which validates input and infers request types     |
| Config             | `dotenv` + a zod-validated env schema                     |
| Logging            | `pino`                                                    |
| Testing            | `vitest` + `supertest`, with the Firestore emulator       |
| Local infra        | `docker-compose` (Postgres) + Firebase emulator           |
| Lint / format      | ESLint + Prettier                                         |

## 3. Project Structure

```
.
├── prisma/
│   ├── schema.prisma
│   └── seed.ts                 # creates a few demo users
├── src/
│   ├── config/
│   │   ├── env.ts              # zod-validated env vars
│   │   ├── prisma.ts           # Prisma client singleton
│   │   └── firebase.ts         # firebase-admin init + Firestore instance
│   ├── modules/
│   │   ├── chat/
│   │   │   ├── chat.routes.ts
│   │   │   ├── chat.controller.ts
│   │   │   ├── chat.service.ts     # relational logic (create/get chat, members)
│   │   │   └── chat.schemas.ts     # zod schemas
│   │   ├── message/
│   │   │   ├── message.routes.ts
│   │   │   ├── message.controller.ts
│   │   │   ├── message.service.ts  # Firestore logic (send/list/read/lastseen)
│   │   │   └── message.schemas.ts
│   │   └── user/
│   │       ├── user.routes.ts
│   │       ├── user.controller.ts
│   │       └── user.service.ts
│   ├── middleware/
│   │   ├── validate.ts         # zod -> 400
│   │   └── errorHandler.ts     # AppError -> JSON response
│   ├── utils/
│   │   ├── AppError.ts
│   │   └── asyncHandler.ts
│   ├── types/                  # shared DTOs / domain types
│   ├── app.ts                  # express app (no listen, so tests can import it)
│   └── server.ts               # bootstrap + graceful shutdown
├── tests/
├── docker-compose.yml
├── firebase.json               # emulator config
├── .env.example
├── tsconfig.json
├── package.json
└── README.md
```

Layering: **routes → controller (HTTP only) → service (business logic) → Prisma / Firestore**.

## 4. Data Model

### 4.1 PostgreSQL (Prisma)

```prisma
enum ChatType { DIRECT GROUP }
enum MemberRole { ADMIN MEMBER }

model User {
  id        String       @id @default(uuid())
  name      String
  createdAt DateTime     @default(now())
  members   ChatMember[]
}

model Chat {
  id        String       @id @default(uuid())
  type      ChatType
  name      String?                    // groups only
  directKey String?      @unique       // "minId:maxId" for DIRECT chats
  createdBy String?
  createdAt DateTime     @default(now())
  members   ChatMember[]
}

model ChatMember {
  chatId   String
  userId   String
  role     MemberRole @default(MEMBER)
  joinedAt DateTime   @default(now())
  chat     Chat @relation(fields: [chatId], references: [id], onDelete: Cascade)
  user     User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@id([chatId, userId])
  @@index([userId])
}
```

**Why `directKey`:** a 1:1 chat between A and B must be unique regardless of argument order. The key `sorted([A, B]).join(':')` has a unique constraint, so two concurrent `create` calls cannot produce duplicate chats. The losing call catches the unique violation (`P2002`) and returns the existing chat.

### 4.2 Firestore

```
chats/{chatId}
  ├── messages/{messageId}
  │     senderId:   string
  │     text:       string
  │     createdAt:  Timestamp   (serverTimestamp)
  │     editedAt:   Timestamp | null      (bonus)
  │     deleted:    boolean               (bonus, soft delete)
  │     readBy:     { [userId]: Timestamp }   ← read receipts
  │
  └── members/{userId}
        lastSeenMessageId: string
        lastSeenAt:        Timestamp     (createdAt of that message)
        updatedAt:         Timestamp
```

Design decisions:

- **Read receipts as a `readBy` map on the message.** One read returns a message with its receipts. Updating `readBy.<userId>` with a field path is atomic and idempotent. Chats are 1:1 or small groups, so the map stays small. A `receipts` subcollection is only worth it for very large groups.
- **Last seen in a separate `members` subcollection.** It is per-user state about the chat, not about one message. It answers "where did user X stop reading?" in a single document read.
- **Ordering:** `createdAt` uses `FieldValue.serverTimestamp()`, so client clocks don't matter. Queries use `orderBy('createdAt', 'desc')` plus `orderBy(FieldPath.documentId())` as a tiebreaker, so the order is deterministic when two timestamps are equal.

## 5. API Specification

All bodies are JSON. Every endpoint validates its input with zod. On success the response is `{ data: ... }`. On failure it is `{ error: { code, message } }`.

### 5.1 `POST /chat/create`: create or get a 1:1 chat

- Body: `{ userAId: string, userBId: string }`
- Rules: the two IDs must differ, and both users must exist (404 otherwise).
- Flow: compute `directKey`. Find the chat by that key and return it if it exists. Otherwise create the chat and its two members in one transaction. If the transaction hits `P2002`, refetch the existing chat.
- Response: `201 { data: { chatId, created: true } }` for a new chat, or `200 { data: { chatId, created: false } }` for an existing one.

### 5.2 `POST /chat/:chatId/message/send`

- Body: `{ senderId: string, text: string (1..4000 chars, trimmed) }`
- Rules: the chat exists and the sender is a member (403 otherwise).
- Flow: add the document to `chats/{chatId}/messages` with `createdAt: serverTimestamp()` and `readBy: { [senderId]: serverTimestamp() }`. The sender has implicitly read their own message.
- Response: `201 { data: Message }`, where `createdAt` is resolved by reading the document back.

### 5.3 `GET /chat/:chatId/messages?limit=50&before=<messageId>`

- `limit`: default 50, max 100.
- `before`: optional cursor for paging back through older messages.
- Rules: the chat exists. If the request includes `userId`, that user must be a member.
- Flow: query `orderBy createdAt desc, docId desc`, take `limit`, then reverse so the response is oldest → newest (chronological, ready to render).
- Response: `{ data: { messages: Message[], nextCursor: string | null } }`

### 5.4 `POST /chat/:chatId/message/:messageId/read`

- Body: `{ userId: string }`
- Rules: the user is a member of the chat, and the message exists in this chat (404 otherwise).
- Flow: `update({ ['readBy.' + userId]: serverTimestamp() })`. It is idempotent, so repeating the call is harmless.
- Optional: the same call also advances last seen (see 5.5) when the message is newer.
- Response: `200 { data: { messageId, userId, readAt } }`

### 5.5 `POST /chat/:chatId/lastseen`

- Body: `{ userId: string, messageId: string }`
- Rules: the user is a member, and the message exists in this chat.
- Flow: in a **Firestore transaction**, read `members/{userId}`. Write the new value only if the new message's `createdAt` is ≥ the stored `lastSeenAt`. This stops a late or out-of-order request from moving last seen backwards.
- Response: `200 { data: { userId, lastSeenMessageId, lastSeenAt, updated: boolean } }`

### 5.6 `GET /user/:userId/chats`

- Rules: the user exists.
- Flow: one Prisma query, `chat.findMany({ where: { members: { some: { userId } } }, include: { members: true } })`, ordered by `createdAt desc`.
- Response: `{ data: [{ chatId, type, name, memberIds: string[], createdAt }] }`

### 5.7 Supporting endpoints

- `POST /users` creates a user, so the APIs can be tried without seeding.
- `GET /health` reports liveness and checks both stores.

## 6. Bonus Features (if time allows)

**Group chats**

- `POST /chat/group` with body `{ name, creatorId, memberIds[] }`. The creator becomes `ADMIN`.
- `POST /chat/:chatId/members` adds members (admin only).
- `DELETE /chat/:chatId/members/:userId` removes a member (admin, or the user leaving).
- `PATCH /chat/:chatId` renames the group (admin only).
- Read receipts and last seen work unchanged, because the Firestore model is already per-user.

**Message edit / delete**

- `PATCH /chat/:chatId/message/:messageId` with body `{ userId, text }`. Only the sender can edit. Sets `editedAt`.
- `DELETE /chat/:chatId/message/:messageId` with body `{ userId }`. Only the sender can delete. It is a soft delete: `deleted: true` and `text: ""`, which keeps the ordering and receipts intact.

## 7. Cross-cutting Concerns

- **Authorization:** no auth system is in scope, so user IDs come from the request body as the spec defines. Every chat operation still checks membership in Postgres. A JWT middleware could replace body IDs later.
- **Errors:** a typed `AppError(status, code, message)` and a central error handler. Codes include `VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN`, `CONFLICT` and `INTERNAL`.
- **Consistency across stores:** the chat must exist in Postgres before any Firestore write. Firestore documents are keyed by the Postgres `chatId`. Nothing writes to both stores in one request, so no distributed transaction is needed.
- **Graceful shutdown:** disconnect Prisma and close the HTTP server on SIGTERM.
- **Strict TS:** `strict`, `noUncheckedIndexedAccess`, no `any`. DTO types are inferred from the zod schemas.

## 8. Testing Strategy

- **Unit tests:** `directKey` generation, the last-seen "only move forward" logic, and the zod schemas.
- **Integration tests** (supertest against the real Postgres in Docker and the Firestore emulator):
  - Calling create chat twice, or with swapped IDs, returns the same `chatId`.
  - Messages come back in send order, and `limit` and `before` paging work.
  - Marking a message read sets `readBy`, and repeating the call is idempotent.
  - Last seen does not regress when an older message is posted after a newer one.
  - A non-member gets 403, and an unknown chat or message gets 404.

## 9. Implementation Steps

1. **Scaffold:** `npm init`, TypeScript config, ESLint and Prettier, folder structure, `.env.example`, `.gitignore`.
2. **Infra:** `docker-compose.yml` for Postgres, plus `firebase.json` for the Firestore emulator.
3. **Config layer:** env validation, the Prisma client and firebase-admin init (emulator-aware via `FIRESTORE_EMULATOR_HOST`).
4. **Prisma:** schema, first migration, seed script.
5. **Shared pieces:** `AppError`, error handler, validate middleware, async handler.
6. **Users:** `POST /users` and `GET /user/:userId/chats` (API 6).
7. **Chats:** `POST /chat/create` (API 1) and a membership-check helper.
8. **Messages:** send (API 2) and list with ordering and paging (API 3).
9. **Receipts:** mark read (API 4) and last seen with a transaction (API 5).
10. **Tests:** unit and integration tests for steps 6–9.
11. **Bonus:** group chats, then message edit and delete.
12. **Docs:** README with setup, env vars, how to run the emulator and DB, an endpoint table and curl examples. Optionally a Postman collection.
13. **Publish:** `git init`, commit, create a **public** GitHub repo, push, and share the link.

## 10. Environment Variables (`.env.example`)

```
PORT=3000
DATABASE_URL=postgresql://chat:chat@localhost:5432/chat
FIREBASE_PROJECT_ID=chat-backend-dev
# Use one of the following:
FIRESTORE_EMULATOR_HOST=localhost:8080          # local dev / tests
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json   # real Firebase (never commit)
```

## 11. Deliverables

- Source code in a public GitHub repository.
- A README covering setup, architecture notes (why each store holds what), API docs and design decisions.
- A test suite that runs with `npm test`.
- Reply to the assignment email with the repository link.

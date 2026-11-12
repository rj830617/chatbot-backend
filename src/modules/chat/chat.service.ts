import { Prisma, type Chat, type ChatMember } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { assertUsersExist } from '../user/user.service';
import { toChatDetails, type ChatDetails } from './chat.types';

/** Order-independent key identifying the 1:1 chat between two users. */
export function directKeyFor(userAId: string, userBId: string): string {
  const [first, second] = [userAId, userBId].sort();
  return `${first}:${second}`;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export interface CreateOrGetResult {
  chatId: string;
  created: boolean;
}

/**
 * Returns the existing 1:1 chat between the two users, or creates it.
 * The unique `direct_key` constraint makes this safe under concurrency:
 * if two requests race, the loser hits P2002 and returns the winner's chat.
 */
export async function createOrGetDirectChat(userAId: string, userBId: string): Promise<CreateOrGetResult> {
  if (userAId === userBId) {
    throw AppError.badRequest('userAId and userBId must be different users');
  }

  const directKey = directKeyFor(userAId, userBId);
  const existing = await prisma.chat.findUnique({ where: { directKey }, select: { id: true } });
  if (existing) return { chatId: existing.id, created: false };

  await assertUsersExist([userAId, userBId]);

  try {
    const chat = await prisma.chat.create({
      data: {
        type: 'DIRECT',
        directKey,
        createdBy: userAId,
        members: { create: [{ userId: userAId }, { userId: userBId }] },
      },
      select: { id: true },
    });
    return { chatId: chat.id, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await prisma.chat.findUniqueOrThrow({ where: { directKey }, select: { id: true } });
    return { chatId: winner.id, created: false };
  }
}

export async function getChatOrThrow(chatId: string): Promise<Chat> {
  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) throw AppError.notFound(`Chat ${chatId} not found`);
  return chat;
}

/** 404 if the chat does not exist, 403 if the user is not a member. */
export async function assertMember(chatId: string, userId: string): Promise<ChatMember> {
  const member = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId } },
  });
  if (member) return member;
  await getChatOrThrow(chatId);
  throw AppError.forbidden(`User ${userId} is not a member of chat ${chatId}`);
}

export async function getChatDetails(chatId: string): Promise<ChatDetails> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { members: { orderBy: { joinedAt: 'asc' } } },
  });
  if (!chat) throw AppError.notFound(`Chat ${chatId} not found`);
  return toChatDetails(chat);
}

// ---------------------------------------------------------------------------
// Group chats (bonus)
// ---------------------------------------------------------------------------

export async function createGroupChat(
  name: string,
  creatorId: string,
  memberIds: readonly string[],
): Promise<ChatDetails> {
  const others = [...new Set(memberIds)].filter((id) => id !== creatorId);
  if (others.length === 0) {
    throw AppError.badRequest('A group needs at least one member besides the creator');
  }
  await assertUsersExist([creatorId, ...others]);

  const chat = await prisma.chat.create({
    data: {
      type: 'GROUP',
      name,
      createdBy: creatorId,
      members: {
        create: [
          { userId: creatorId, role: 'ADMIN' },
          ...others.map((userId) => ({ userId, role: 'MEMBER' as const })),
        ],
      },
    },
    include: { members: { orderBy: { joinedAt: 'asc' } } },
  });
  return toChatDetails(chat);
}

async function assertGroupAdmin(chatId: string, actorId: string): Promise<void> {
  const chat = await getChatOrThrow(chatId);
  if (chat.type !== 'GROUP') throw AppError.badRequest('This operation is only allowed on group chats');
  const member = await assertMember(chatId, actorId);
  if (member.role !== 'ADMIN') throw AppError.forbidden('Only group admins can do this');
}

export async function renameGroup(chatId: string, actorId: string, name: string): Promise<ChatDetails> {
  await assertGroupAdmin(chatId, actorId);
  await prisma.chat.update({ where: { id: chatId }, data: { name } });
  return getChatDetails(chatId);
}

export async function addGroupMembers(
  chatId: string,
  actorId: string,
  userIds: readonly string[],
): Promise<ChatDetails> {
  await assertGroupAdmin(chatId, actorId);
  await assertUsersExist(userIds);
  await prisma.chatMember.createMany({
    data: [...new Set(userIds)].map((userId) => ({ chatId, userId })),
    skipDuplicates: true,
  });
  return getChatDetails(chatId);
}

/**
 * Admins can remove anyone; any member can remove themselves (leave).
 * If the last admin leaves, the longest-standing remaining member is promoted.
 * If nobody is left, the chat row is deleted.
 */
export async function removeGroupMember(
  chatId: string,
  actorId: string,
  userId: string,
): Promise<ChatDetails | null> {
  const chat = await getChatOrThrow(chatId);
  if (chat.type !== 'GROUP') throw AppError.badRequest('This operation is only allowed on group chats');

  const actor = await assertMember(chatId, actorId);
  if (actorId !== userId && actor.role !== 'ADMIN') {
    throw AppError.forbidden('Only group admins can remove other members');
  }
  const target = await prisma.chatMember.findUnique({ where: { chatId_userId: { chatId, userId } } });
  if (!target) throw AppError.notFound(`User ${userId} is not a member of chat ${chatId}`);

  const remaining = await prisma.$transaction(async (tx) => {
    await tx.chatMember.delete({ where: { chatId_userId: { chatId, userId } } });
    const left = await tx.chatMember.findMany({ where: { chatId }, orderBy: { joinedAt: 'asc' } });
    if (left.length === 0) {
      await tx.chat.delete({ where: { id: chatId } });
      return 0;
    }
    const first = left[0];
    if (first && !left.some((m) => m.role === 'ADMIN')) {
      await tx.chatMember.update({
        where: { chatId_userId: { chatId, userId: first.userId } },
        data: { role: 'ADMIN' },
      });
    }
    return left.length;
  });

  return remaining === 0 ? null : getChatDetails(chatId);
}

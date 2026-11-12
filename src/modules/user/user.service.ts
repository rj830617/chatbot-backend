import type { User } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import type { ChatSummary } from '../chat/chat.types';
import { toChatSummary } from '../chat/chat.types';

export async function createUser(name: string): Promise<User> {
  return prisma.user.create({ data: { name } });
}

export async function getUserOrThrow(userId: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound(`User ${userId} not found`);
  return user;
}

/** Throws 404 naming any IDs that do not exist. */
export async function assertUsersExist(userIds: readonly string[]): Promise<void> {
  const unique = [...new Set(userIds)];
  const found = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true } });
  if (found.length === unique.length) return;
  const foundIds = new Set(found.map((u) => u.id));
  const missing = unique.filter((id) => !foundIds.has(id));
  throw AppError.notFound(`User(s) not found: ${missing.join(', ')}`);
}

export async function listUserChats(userId: string): Promise<ChatSummary[]> {
  await getUserOrThrow(userId);
  const chats = await prisma.chat.findMany({
    where: { members: { some: { userId } } },
    include: { members: { orderBy: { joinedAt: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  return chats.map(toChatSummary);
}

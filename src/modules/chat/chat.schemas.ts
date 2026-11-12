import { z } from 'zod';
import { uuid } from '../../utils/validation';

export const createChatBody = z.object({
  userAId: uuid,
  userBId: uuid,
});

const groupName = z.string().trim().min(1).max(100);

export const createGroupBody = z.object({
  name: groupName,
  creatorId: uuid,
  memberIds: z.array(uuid).min(1).max(256),
});

export const renameGroupBody = z.object({
  actorId: uuid,
  name: groupName,
});

export const addMembersBody = z.object({
  actorId: uuid,
  userIds: z.array(uuid).min(1).max(256),
});

export const removeMemberParams = z.object({ chatId: uuid, userId: uuid });

export const removeMemberBody = z.object({ actorId: uuid });

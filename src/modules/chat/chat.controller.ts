import type { Request, Response } from 'express';
import { chatIdParams } from '../../utils/validation';
import {
  addMembersBody,
  createChatBody,
  createGroupBody,
  removeMemberBody,
  removeMemberParams,
  renameGroupBody,
} from './chat.schemas';
import * as chatService from './chat.service';

/** POST /chat/create (API 1) */
export async function createChat(req: Request, res: Response): Promise<void> {
  const { userAId, userBId } = createChatBody.parse(req.body);
  const result = await chatService.createOrGetDirectChat(userAId, userBId);
  res.status(result.created ? 201 : 200).json({ data: result });
}

/** GET /chat/:chatId */
export async function getChat(req: Request, res: Response): Promise<void> {
  const { chatId } = chatIdParams.parse(req.params);
  res.json({ data: await chatService.getChatDetails(chatId) });
}

/** POST /chat/group (bonus) */
export async function createGroup(req: Request, res: Response): Promise<void> {
  const { name, creatorId, memberIds } = createGroupBody.parse(req.body);
  const chat = await chatService.createGroupChat(name, creatorId, memberIds);
  res.status(201).json({ data: chat });
}

/** PATCH /chat/:chatId (bonus) */
export async function renameGroup(req: Request, res: Response): Promise<void> {
  const { chatId } = chatIdParams.parse(req.params);
  const { actorId, name } = renameGroupBody.parse(req.body);
  res.json({ data: await chatService.renameGroup(chatId, actorId, name) });
}

/** POST /chat/:chatId/members (bonus) */
export async function addMembers(req: Request, res: Response): Promise<void> {
  const { chatId } = chatIdParams.parse(req.params);
  const { actorId, userIds } = addMembersBody.parse(req.body);
  res.json({ data: await chatService.addGroupMembers(chatId, actorId, userIds) });
}

/** DELETE /chat/:chatId/members/:userId (bonus) */
export async function removeMember(req: Request, res: Response): Promise<void> {
  const { chatId, userId } = removeMemberParams.parse(req.params);
  const { actorId } = removeMemberBody.parse(req.body);
  const chat = await chatService.removeGroupMember(chatId, actorId, userId);
  res.json({ data: chat ?? { chatId, deleted: true } });
}

import type { Request, Response } from 'express';
import { chatIdParams, messageParams } from '../../utils/validation';
import { assertMember, getChatOrThrow } from '../chat/chat.service';
import {
  deleteMessageBody,
  editMessageBody,
  lastSeenBody,
  listMessagesQuery,
  markReadBody,
  sendMessageBody,
} from './message.schemas';
import * as messageService from './message.service';

/** POST /chat/:chatId/message/send (API 2) */
export async function sendMessage(req: Request, res: Response): Promise<void> {
  const { chatId } = chatIdParams.parse(req.params);
  const { senderId, text } = sendMessageBody.parse(req.body);
  await assertMember(chatId, senderId);
  const message = await messageService.sendMessage(chatId, senderId, text);
  res.status(201).json({ data: message });
}

/** GET /chat/:chatId/messages?limit=50&before=<messageId>&userId=<uuid> (API 3) */
export async function listMessages(req: Request, res: Response): Promise<void> {
  const { chatId } = chatIdParams.parse(req.params);
  const { limit, before, userId } = listMessagesQuery.parse(req.query);
  if (userId) await assertMember(chatId, userId);
  else await getChatOrThrow(chatId);
  res.json({ data: await messageService.listMessages(chatId, limit, before) });
}

/** POST /chat/:chatId/message/:messageId/read (API 4) */
export async function markRead(req: Request, res: Response): Promise<void> {
  const { chatId, messageId } = messageParams.parse(req.params);
  const { userId } = markReadBody.parse(req.body);
  await assertMember(chatId, userId);
  res.json({ data: await messageService.markMessageRead(chatId, messageId, userId) });
}

/** POST /chat/:chatId/lastseen (API 5) */
export async function updateLastSeen(req: Request, res: Response): Promise<void> {
  const { chatId } = chatIdParams.parse(req.params);
  const { userId, messageId } = lastSeenBody.parse(req.body);
  await assertMember(chatId, userId);
  res.json({ data: await messageService.updateLastSeen(chatId, userId, messageId) });
}

/** GET /chat/:chatId/lastseen */
export async function getLastSeen(req: Request, res: Response): Promise<void> {
  const { chatId } = chatIdParams.parse(req.params);
  await getChatOrThrow(chatId);
  res.json({ data: await messageService.getLastSeenForChat(chatId) });
}

/** PATCH /chat/:chatId/message/:messageId (bonus) */
export async function editMessage(req: Request, res: Response): Promise<void> {
  const { chatId, messageId } = messageParams.parse(req.params);
  const { userId, text } = editMessageBody.parse(req.body);
  await assertMember(chatId, userId);
  res.json({ data: await messageService.editMessage(chatId, messageId, userId, text) });
}

/** DELETE /chat/:chatId/message/:messageId (bonus) */
export async function deleteMessage(req: Request, res: Response): Promise<void> {
  const { chatId, messageId } = messageParams.parse(req.params);
  const { userId } = deleteMessageBody.parse(req.body);
  await assertMember(chatId, userId);
  res.json({ data: await messageService.deleteMessage(chatId, messageId, userId) });
}

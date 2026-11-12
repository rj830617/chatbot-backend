import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import * as chat from './chat.controller';
import * as message from '../message/message.controller';

export const chatRouter = Router();

// Chats (PostgreSQL)
chatRouter.post('/create', asyncHandler(chat.createChat));
chatRouter.post('/group', asyncHandler(chat.createGroup));
chatRouter.get('/:chatId', asyncHandler(chat.getChat));
chatRouter.patch('/:chatId', asyncHandler(chat.renameGroup));
chatRouter.post('/:chatId/members', asyncHandler(chat.addMembers));
chatRouter.delete('/:chatId/members/:userId', asyncHandler(chat.removeMember));

// Messages, read receipts, last seen (Firestore)
chatRouter.post('/:chatId/message/send', asyncHandler(message.sendMessage));
chatRouter.get('/:chatId/messages', asyncHandler(message.listMessages));
chatRouter.post('/:chatId/message/:messageId/read', asyncHandler(message.markRead));
chatRouter.patch('/:chatId/message/:messageId', asyncHandler(message.editMessage));
chatRouter.delete('/:chatId/message/:messageId', asyncHandler(message.deleteMessage));
chatRouter.post('/:chatId/lastseen', asyncHandler(message.updateLastSeen));
chatRouter.get('/:chatId/lastseen', asyncHandler(message.getLastSeen));

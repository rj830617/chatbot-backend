import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import * as user from './user.controller';

export const userRouter = Router();

userRouter.post('/', asyncHandler(user.createUser));
userRouter.get('/:userId', asyncHandler(user.getUser));
userRouter.get('/:userId/chats', asyncHandler(user.listUserChats));

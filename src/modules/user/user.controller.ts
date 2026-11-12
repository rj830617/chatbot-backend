import type { Request, Response } from 'express';
import { z } from 'zod';
import { userIdParams } from '../../utils/validation';
import * as userService from './user.service';

const createUserBody = z.object({ name: z.string().trim().min(1).max(100) });

/** POST /user */
export async function createUser(req: Request, res: Response): Promise<void> {
  const { name } = createUserBody.parse(req.body);
  const user = await userService.createUser(name);
  res.status(201).json({ data: { id: user.id, name: user.name, createdAt: user.createdAt.toISOString() } });
}

/** GET /user/:userId */
export async function getUser(req: Request, res: Response): Promise<void> {
  const { userId } = userIdParams.parse(req.params);
  const user = await userService.getUserOrThrow(userId);
  res.json({ data: { id: user.id, name: user.name, createdAt: user.createdAt.toISOString() } });
}

/** GET /user/:userId/chats (API 6) */
export async function listUserChats(req: Request, res: Response): Promise<void> {
  const { userId } = userIdParams.parse(req.params);
  res.json({ data: await userService.listUserChats(userId) });
}

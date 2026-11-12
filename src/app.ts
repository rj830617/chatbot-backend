import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { firestore } from './config/firebase';
import { logger } from './config/logger';
import { prisma } from './config/prisma';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { chatRouter } from './modules/chat/chat.routes';
import { userRouter } from './modules/user/user.routes';
import { asyncHandler } from './utils/asyncHandler';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(pinoHttp({ logger }));

  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const [postgres, firestoreStatus] = await Promise.all([
        prisma.$queryRaw`SELECT 1`.then(
          () => 'ok' as const,
          () => 'down' as const,
        ),
        firestore.listCollections().then(
          () => 'ok' as const,
          () => 'down' as const,
        ),
      ]);
      const healthy = postgres === 'ok' && firestoreStatus === 'ok';
      res.status(healthy ? 200 : 503).json({ data: { postgres, firestore: firestoreStatus } });
    }),
  );

  app.use('/chat', chatRouter);
  app.use('/user', userRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

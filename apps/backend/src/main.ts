import 'reflect-metadata';
import { json, type NextFunction, type Request, type Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { toNodeHandler } from 'better-auth/node';
import { createAuth } from './auth.js';
import { ApiModule } from './api.js';

const { auth, database } = createAuth();
const app = await NestFactory.create(ApiModule.create(auth), { bodyParser: false });
const expressApp = app.getHttpAdapter().getInstance();
expressApp.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') expressApp.set('trust proxy', 1);
expressApp.all('/api/auth/{*splat}', toNodeHandler(auth));
app.use(json({ limit: '64kb' }));
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.enableShutdownHooks();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void database.end());
await app.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '127.0.0.1');

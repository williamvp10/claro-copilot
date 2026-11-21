import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FoundationModule } from './foundation.js';

const app = await NestFactory.create(FoundationModule);
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '127.0.0.1');

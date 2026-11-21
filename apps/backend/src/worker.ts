import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';

@Module({})
class WorkerModule {}

const worker = await NestFactory.createApplicationContext(WorkerModule);
worker.enableShutdownHooks();
const keepAlive = setInterval(() => undefined, 30_000);
process.once('exit', () => clearInterval(keepAlive));

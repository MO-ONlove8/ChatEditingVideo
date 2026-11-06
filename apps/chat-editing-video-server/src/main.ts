import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const app = await NestFactory.create(AppModule.forRoot(env), { bufferLogs: true });
configureApp(app, env);
await app.listen(env.PORT);
console.log(`API listening on http://localhost:${env.PORT}/api`);

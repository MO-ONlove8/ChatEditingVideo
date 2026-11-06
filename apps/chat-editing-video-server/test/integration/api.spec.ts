import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap.js';
import { loadEnv } from '../../src/config/env.js';

/**
 * Full-stack test against real PostgreSQL + Redis.
 * Prereqs: `pnpm db:up && pnpm db:migrate`, and apps/chat-editing-video-server/.env.
 * Run: `pnpm --filter @cev/server test:integration`
 */
describe('API integration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const env = { ...loadEnv(), NODE_ENV: 'test' as const };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(env)],
    }).compile();
    app = configureApp(moduleRef.createNestApplication(), env);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reports database and redis as up', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body.checks).toMatchObject({ database: 'up', redis: 'up' });
  });

  it('creates a project and runs an edit job to completion', async () => {
    const project = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'integration' })
      .expect(201);

    const job = await request(app.getHttpServer())
      .post('/api/jobs')
      .send({
        projectId: project.body.id,
        plan: { version: 1, clips: [{ source: 'x', startSec: 0, endSec: 1 }] },
      })
      .expect(201);

    let status = job.body.status;
    for (let i = 0; i < 40 && status !== 'succeeded' && status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 250));
      status = (await request(app.getHttpServer()).get(`/api/jobs/${job.body.id}`)).body.status;
    }
    expect(status).toBe('succeeded');

    await request(app.getHttpServer()).delete(`/api/projects/${project.body.id}`).expect(204);
  });
});

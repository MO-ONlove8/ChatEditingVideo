import { Test } from '@nestjs/testing';
import { type INestApplication, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from '../../src/auth/auth.guard.js';
import { AuthService } from '../../src/auth/auth.service.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LoggerModule } from 'nestjs-pino';
import { configureApp } from '../../src/bootstrap.js';
import { EnvSchema } from '../../src/config/env.js';
import { ProjectsController } from '../../src/projects/projects.controller.js';
import { ProjectsService } from '../../src/projects/projects.service.js';

/** HTTP-level test of routing, global prefix and zod validation — no DB/Redis needed. */
describe('ProjectsController (HTTP)', () => {
  let app: INestApplication;
  const service = {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockImplementation(async (input: { name: string }) => ({
      id: '00000000-0000-4000-8000-000000000000',
      name: input.name,
      description: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    })),
  };

  beforeAll(async () => {
    const env = EnvSchema.parse({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: { level: 'silent' } })],
      controllers: [ProjectsController],
      providers: [
        { provide: ProjectsService, useValue: service },
        {
          provide: AuthService,
          useValue: {
            authenticate: async (token: string) => {
              if (token !== 'test-session') throw new UnauthorizedException();
              return { user: { id: 'test-owner' } };
            },
          },
        },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();
    app = configureApp(moduleRef.createNestApplication(), env);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /api/projects lists projects', async () => {
    await request(app.getHttpServer())
      .get('/api/projects')
      .set('Authorization', 'Bearer test-session')
      .expect(200)
      .expect([]);
    expect(service.list).toHaveBeenCalledWith('test-owner');
  });

  it('rejects anonymous requests', async () => {
    await request(app.getHttpServer()).get('/api/projects').expect(401);
  });

  it('POST /api/projects validates with the shared zod schema', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects')
      .set('Authorization', 'Bearer test-session')
      .send({ name: '' })
      .expect(400);
    expect(res.body.issues[0].path).toBe('name');
    expect(service.create).not.toHaveBeenCalled();
  });

  it('POST /api/projects trims and creates', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects')
      .set('Authorization', 'Bearer test-session')
      .send({ name: '  Demo  ' })
      .expect(201);
    expect(res.body.name).toBe('Demo');
  });
});

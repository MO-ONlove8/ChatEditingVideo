import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { it, expect } from 'vitest';
import { TimelineSchema } from '@cev/shared';
import { loadEnv } from '../../src/config/env.js';

it('migrates a fresh database and a v0.1 timeline without assigning isolated data', async () => {
  const env = loadEnv(),
    url = new URL(env.DATABASE_URL),
    name = 'cev_d1_' + randomUUID().replaceAll('-', '');
  const admin = postgres(env.DATABASE_URL, { max: 1 });
  let client: ReturnType<typeof postgres> | undefined, folder: string | undefined;
  try {
    await admin.unsafe('CREATE DATABASE "' + name + '"');
    url.pathname = '/' + name;
    client = postgres(url.toString(), { max: 1 });
    await mkdir(path.resolve('storage'), { recursive: true });
    folder = await mkdtemp(path.resolve('storage', 'migration-d1-'));
    await mkdir(path.join(folder, 'meta'));
    const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const old = { ...journal, entries: journal.entries.filter((e) => e.idx < 8) };
    for (const entry of old.entries)
      await copyFile('drizzle/' + entry.tag + '.sql', path.join(folder, entry.tag + '.sql'));
    await writeFile(path.join(folder, 'meta', '_journal.json'), JSON.stringify(old));
    await migrate(drizzle(client), { migrationsFolder: folder });
    const project = randomUUID(),
      legacy = {
        revision: 2,
        fps: 30,
        canvas: { width: 1920, height: 1080 },
        clips: [
          { id: randomUUID(), source: randomUUID(), generation: 1, startFrame: 0, endFrame: 90 },
        ],
      };
    await client`insert into projects(id,name) values(${project},'历史隔离任务')`;
    await client`insert into timelines(project_id,state) values(${project},${JSON.stringify(legacy)})`;
    await migrate(drizzle(client), { migrationsFolder: 'drizzle' });
    const [row] =
      await client`select p.owner_id,t.state from projects p join timelines t on t.project_id=p.id where p.id=${project}`;
    expect(row!.owner_id).toBeNull();
    expect(row!.state).toEqual(legacy);
    expect(TimelineSchema.parse(row!.state).clips[0]).toMatchObject({
      startFrame: 0,
      endFrame: 90,
    });
    const columns =
      await client`select column_name from information_schema.columns where table_name='edit_proposals'`;
    expect(columns.map((c) => c.column_name)).toEqual(
      expect.arrayContaining(['candidate', 'preview_execution', 'input_hash']),
    );
  } finally {
    await client?.end();
    await admin.unsafe('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await admin.end();
    if (folder) await rm(folder, { recursive: true, force: true });
  }
}, 60000);

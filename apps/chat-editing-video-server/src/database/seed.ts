/** Dev seed: `pnpm db:seed`. Idempotent — only inserts when the table is empty. */
import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { projects } from './schema.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const client = postgres(url, { max: 1 });
const db = drizzle(client);

try {
  const existing = await db.select({ id: projects.id }).from(projects).limit(1);
  if (existing.length === 0) {
    await db.insert(projects).values([{ name: '示例项目', description: '脚手架自带的演示数据' }]);
    console.log('Seeded projects.');
  } else {
    console.log('Projects already present, skipping seed.');
  }
} finally {
  await client.end();
}

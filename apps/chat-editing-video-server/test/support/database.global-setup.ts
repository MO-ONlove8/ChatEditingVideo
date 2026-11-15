import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { TestProject } from 'vitest/node';
import { loadEnv } from '../../src/config/env.js';

/** Recovery workers scan persisted work, so a queue prefix alone cannot isolate fixtures. */
export default async function setup(project: TestProject) {
  const env = loadEnv();
  const database = 'cev_integration_' + randomUUID().replaceAll('-', '');
  const url = new URL(env.DATABASE_URL);
  url.pathname = '/' + database;
  const admin = postgres(env.DATABASE_URL, { max: 1 });
  let created = false;
  const cleanup = async () => {
    try {
      if (created) await admin.unsafe('DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)');
    } finally {
      await admin.end();
    }
  };
  try {
    await admin.unsafe('CREATE DATABASE "' + database + '"');
    created = true;
    const client = postgres(url.toString(), { max: 1 });
    try {
      await migrate(drizzle(client), { migrationsFolder: 'drizzle' });
    } finally {
      await client.end();
    }
    project.provide('integrationDatabaseUrl', url.toString());
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

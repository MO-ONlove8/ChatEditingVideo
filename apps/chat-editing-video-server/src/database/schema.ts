import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { EditPlan } from '@cev/shared';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`),
};

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  ...timestamps,
});

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull().unique(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('media_assets_project_idx').on(t.projectId)],
);

export const jobStatus = pgEnum('job_status', ['queued', 'running', 'succeeded', 'failed']);

export const editJobs = pgTable(
  'edit_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: jobStatus('status').notNull().default('queued'),
    progress: integer('progress').notNull().default(0),
    plan: jsonb('plan').$type<EditPlan>().notNull(),
    outputKey: text('output_key'),
    error: text('error'),
    ...timestamps,
  },
  (t) => [index('edit_jobs_project_idx').on(t.projectId)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type MediaAssetRow = typeof mediaAssets.$inferSelect;
export type EditJobRow = typeof editJobs.$inferSelect;

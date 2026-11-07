import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  EditPlan,
  EditingMedia,
  MediaInfo,
  Timeline,
  EditOperation,
  Proposal,
} from '@cev/shared';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`),
};

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull().unique(),
  createdAt: timestamps.createdAt,
});

export const loginCodes = pgTable('login_codes', {
  phone: text('phone').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  resendAt: timestamp('resend_at', { withTimezone: true }).notNull(),
  consumed: boolean('consumed').notNull().default(false),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedReason: text('revoked_reason'),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('sessions_one_active_user')
      .on(t.userId)
      .where(sql`${t.revokedReason} is null`),
  ],
);

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Null is reserved for pre-authentication legacy data, never assigned by new requests.
  ownerId: uuid('owner_id').references(() => users.id),
  deleting: boolean('deleting').notNull().default(false),
  name: text('name').notNull(),
  description: text('description'),
  nextMediaNumber: integer('next_media_number').notNull().default(1),
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
    number: integer('number').notNull().default(1),
    status: text('status').notNull().default('queued'),
    stage: text('stage').notNull().default('等待处理'),
    progress: integer('progress').notNull().default(0),
    error: text('error'),
    generation: integer('generation').notNull().default(1),
    deleting: boolean('deleting').notNull().default(false),
    removed: boolean('removed').notNull().default(false),
    original: jsonb('original').$type<MediaInfo>(),
    normalized: jsonb('normalized').$type<MediaInfo>(),
    normalizedKey: text('normalized_key'),
    editing: jsonb('editing').$type<EditingMedia>(),
    editingKey: text('editing_key'),
    derivedPrefix: text('derived_prefix'),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('media_assets_project_idx').on(t.projectId)],
);

export const uploadContexts = pgTable('upload_contexts', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  createdAt: timestamps.createdAt,
});
export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey(),
  contextId: uuid('context_id')
    .notNull()
    .references(() => uploadContexts.id, { onDelete: 'cascade' }),
  fileName: text('file_name').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  status: text('status').notNull().default('pending'),
  error: text('error'),
  assetId: uuid('asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
  ...timestamps,
});
export const mediaRuns = pgTable(
  'media_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    executionId: uuid('execution_id'),
    queuePrefix: text('queue_prefix').notNull().default('bull'),
    phase: text('phase').notNull().default('index'),
    status: text('status').notNull().default('queued'),
    error: text('error'),
    ...timestamps,
  },
  (t) => [uniqueIndex('media_runs_generation_idx').on(t.assetId, t.generation)],
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
    queuePrefix: text('queue_prefix').notNull().default('bull'),
    revision: integer('revision'),
    generation: integer('generation').notNull().default(1),
    executionId: uuid('execution_id'),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    outputKey: text('output_key'),
    error: text('error'),
    ...timestamps,
  },
  (t) => [index('edit_jobs_project_idx').on(t.projectId)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type MediaAssetRow = typeof mediaAssets.$inferSelect;
export type EditJobRow = typeof editJobs.$inferSelect;

export const timelines = pgTable('timelines', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  state: jsonb('state').$type<Timeline>().notNull(),
});
export const chatTurns = pgTable(
  'chat_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').notNull(),
    text: text('text').notNull(),
    reply: text('reply').notNull().default(''),
    status: text('status').notNull().default('understanding'),
    baseRevision: integer('base_revision').notNull(),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('chat_turn_request').on(t.projectId, t.requestId),
    uniqueIndex('chat_turn_active')
      .on(t.projectId)
      .where(sql`${t.status} in ('understanding','pending')`),
  ],
);
export const proposals = pgTable('edit_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  turnId: uuid('turn_id')
    .notNull()
    .unique()
    .references(() => chatTurns.id, { onDelete: 'cascade' }),
  baseRevision: integer('base_revision').notNull(),
  status: text('status').notNull().default('pending'),
  operation: jsonb('operation').$type<EditOperation>().notNull(),
  sourceLabel: text('source_label').notNull(),
  destinationLabel: text('destination_label').notNull(),
  previewClip: jsonb('preview_clip').$type<Proposal['previewClip']>().notNull(),
  appliedRevision: integer('applied_revision'),
});
export const timelineMutations = pgTable('timeline_mutations', {
  requestId: uuid('request_id').primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  clipId: uuid('clip_id').notNull(),
  revision: integer('revision').notNull(),
});

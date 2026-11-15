import { z } from 'zod';
import { TimelineSchema, EditOperationSchema } from '../timeline.js';
import { ProjectSchema } from './project.js';
import {
  CompositionManifestSchema,
  CompositionStateSchema,
  ElementEditSchema,
} from '../elements.js';

export const EditingErrorCodes = {
  timelineChanged: 'TIMELINE_CHANGED',
  operationPending: 'EDIT_OPERATION_PENDING',
  proposalInvalid: 'EDIT_PROPOSAL_INVALID',
  mediaReferenced: 'MEDIA_REFERENCED',
  renderNotReady: 'RENDER_NOT_READY',
  downloadCredentialInvalid: 'DOWNLOAD_CREDENTIAL_INVALID',
  previewNotReady: 'PREVIEW_NOT_READY',
  candidateChanged: 'CANDIDATE_CHANGED',
  layoutInvalid: 'LAYOUT_INVALID',
} as const;
export const EditingErrorCodeSchema = z.enum(EditingErrorCodes);
export type EditingErrorCode = z.infer<typeof EditingErrorCodeSchema>;

export const EditingRequestSchema = z.object({
  requestId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
});
export const InstructionSchema = EditingRequestSchema.extend({
  text: z.string().trim().min(1).max(4000),
  playhead: z.number().int().nonnegative().default(0),
  selectedId: z.uuid().optional(),
});
export const IntentSchema = z.object({
  kind: z.enum(['add', 'move', 'copy', 'element', 'clarify', 'unsupported', 'multiple']),
  sourceNumber: z.number().int().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  destination: z.enum(['end', 'before', 'after']).nullable(),
  targetNumber: z.number().int().nullable(),
  message: z.string(),
  element: ElementEditSchema.omit({ requestId: true, expectedRevision: true })
    .partial()
    .nullable()
    .optional(),
});
export type EditingIntent = z.infer<typeof IntentSchema>;
export const ProposalSchema = z.object({
  id: z.uuid(),
  turnId: z.uuid(),
  baseRevision: z.number().int(),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'invalid']),
  operation: EditOperationSchema,
  sourceLabel: z.string(),
  destinationLabel: z.string(),
  previewClip: z
    .object({
      source: z.uuid(),
      generation: z.number().int(),
      startFrame: z.number().int(),
      endFrame: z.number().int(),
    })
    .nullable(),
  appliedRevision: z.number().int().nullable(),
  previewStatus: z.enum(['processing', 'ready', 'failed']).default('processing'),
  previewError: z.string().nullable().default(null),
  contentHash: z.string().nullable().default(null),
  generation: z.number().int().default(1),
  candidate: TimelineSchema.nullable().default(null),
  manifest: CompositionManifestSchema.nullable().default(null),
  details: z.array(z.string()).default([]),
});
export type Proposal = z.infer<typeof ProposalSchema>;
export const ChatTurnSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  text: z.string(),
  reply: z.string(),
  status: z.enum(['understanding', 'pending', 'done', 'failed']),
  createdAt: z.iso.datetime(),
  proposal: ProposalSchema.nullable(),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;
export const ChatPageSchema = z.object({
  turns: z.array(ChatTurnSchema),
  nextCursor: z.string().nullable(),
});
export const EditorStateSchema = z.object({
  project: ProjectSchema,
  timeline: TimelineSchema,
  turns: z.array(ChatTurnSchema),
  nextCursor: z.string().nullable(),
  composition: CompositionStateSchema.nullable().optional(),
});
export type EditorState = z.infer<typeof EditorStateSchema>;
export const EditingStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('understanding') }),
  z.object({ type: z.literal('state'), state: EditorStateSchema }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    code: EditingErrorCodeSchema.optional(),
  }),
]);

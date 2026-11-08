import { z } from 'zod';

// IDs follow the existing shared schemas: nonempty strings, without UUID coercion.
const id = z.string().min(1);
const version = z.literal('1');
const revision = z.number().int().min(1);
const displayName = z.string().trim().min(1).max(100);
const timestamp = z.iso.datetime({ offset: true });
const notes = z.array(z.string().trim().min(1).max(500)).max(20);

// Omission means unconfirmed; do not fill defaults or accept null.
export const learnerPreferencesSchema = z.object({
    sentenceLength: z.number().int().min(1).max(40).optional(),
    splitHints: z.string().max(200).optional(),
    displayMode: z.enum(['photo_only', 'photo_text']).optional(),
    audioGuidance: z.boolean().optional(),
}).strict();
export type LearnerPreferences = z.infer<typeof learnerPreferencesSchema>;

export const disabilityInfoSchema = z.object({
    detail: z.string().trim().min(1).max(500),
    source: z.string().trim().min(1).max(200),
    confirmedAt: timestamp,
}).strict();
export type DisabilityInfo = z.infer<typeof disabilityInfoSchema>;

const editable = {
    displayName,
    preferences: learnerPreferencesSchema.optional(),
    learnerWishes: notes.optional(),
    staffObservations: notes.optional(),
    staffSuggestions: notes.optional(),
    confirmedGuidance: notes.optional(),
    disabilityInfo: disabilityInfoSchema.optional(),
};

export const learnerProfileDetailSchema = z.object({
    ...editable,
    schemaVersion: version,
    learnerId: id,
    orgId: id,
    preferences: learnerPreferencesSchema,
    enteredBy: id,
    updatedBy: id,
    revision,
    createdAt: timestamp,
}).strict();
export type LearnerProfileDetail = z.infer<typeof learnerProfileDetailSchema>;

export const learnerProfileSummarySchema = learnerProfileDetailSchema.pick({
    schemaVersion: true, learnerId: true, displayName: true, preferences: true, revision: true,
});
export type LearnerProfileSummary = z.infer<typeof learnerProfileSummarySchema>;
export const learnerProfileListResponseSchema = z.object({
    items: z.array(learnerProfileSummarySchema),
}).strict();
export type LearnerProfileListResponse = z.infer<typeof learnerProfileListResponseSchema>;

export const learnerProfileCreateRequestSchema = z.object(editable).strict();
export type LearnerProfileCreateRequest = z.infer<typeof learnerProfileCreateRequestSchema>;

export const learnerProfileUpdateRequestSchema = learnerProfileCreateRequestSchema.partial().extend({
    expectedRevision: z.number().int().nonnegative(),
    // Omitted: retain the record. null: delete the optional record, never store null.
    // An object replaces it and must contain all three fields.
    disabilityInfo: disabilityInfoSchema.nullable().optional(),
}).strict();
/** disabilityInfo === null explicitly requests deletion; undefined leaves it unchanged. */
export type LearnerProfileUpdateRequest = z.infer<typeof learnerProfileUpdateRequestSchema>;

/** Allowlist projection for staff lists; never expose private notes or disabilityInfo. */
export function toLearnerProfileSummary(detail: LearnerProfileDetail): LearnerProfileSummary {
    return {
        schemaVersion: detail.schemaVersion,
        learnerId: detail.learnerId,
        displayName: detail.displayName,
        preferences: { ...detail.preferences },
        revision: detail.revision,
    };
}

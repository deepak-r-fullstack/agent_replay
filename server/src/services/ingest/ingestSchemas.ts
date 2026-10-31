import { z } from "zod";
import { isProduction } from "../../config/env";
import {
  EXTERNAL_REF_ID_MAX,
  EXTERNAL_REF_SYSTEM_PATTERN,
  EXTERNAL_REF_URL_MAX,
  MAX_RUNS_PER_BATCH,
  MAX_STEPS_PER_BATCH,
  MAX_STEPS_PER_RUN,
  RUN_STATUSES,
  STEP_TYPES,
} from "../../constants";
import { isAllowedLinkUrl } from "../../utils/externalRef";

// What the SDK may send. Unknown fields are dropped, so newer SDKs can add fields without breaking older servers.
// Text is not length-checked here: the service cuts it to 32 KB and the request size limit bounds the rest.

const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));
const wholeNumber = z
  .number()
  .min(0)
  .max(1_000_000_000)
  .transform((value) => Math.round(value));

export const ingestRunSchema = z.object({
  id: z.string().trim().min(1).max(64), // the SDK's own id for the run
  name: z.string().max(500).optional(),
  userRef: z.string().max(500).optional(),
  tags: z.array(z.string().max(200)).max(10).optional(),
  status: z.enum(RUN_STATUSES).optional(),
  startedAt: isoDate.optional(),
  durationMs: wholeNumber.optional(),
});

// A link to a record in another system. Only safe links are accepted (see utils/externalRef.ts).
export const externalRefSchema = z.object({
  system: z.string().regex(EXTERNAL_REF_SYSTEM_PATTERN, "The system name must be lowercase letters, numbers, - or _."),
  id: z.string().trim().min(1).max(EXTERNAL_REF_ID_MAX),
  url: z
    .string()
    .max(EXTERNAL_REF_URL_MAX, `A link can be up to ${EXTERNAL_REF_URL_MAX} characters.`)
    // Checked when a batch arrives, so a server running in production refuses http://localhost links.
    .refine((url) => isAllowedLinkUrl(url, isProduction), "Links must start with https:// and must not contain a password or a secret."),
});

export const ingestStepSchema = z.object({
  runId: z.string().trim().min(1).max(64), // the SDK's id of the run this step belongs to
  index: z
    .number()
    .int()
    .min(0)
    .max(MAX_STEPS_PER_RUN - 1, `A run can hold up to ${MAX_STEPS_PER_RUN} steps.`),
  type: z.enum(STEP_TYPES),
  name: z.string().max(500).default(""),
  input: z.string().default(""),
  output: z.string().default(""),
  model: z.string().max(200).default(""),
  tokens: wholeNumber.default(0),
  costUsd: z.number().min(0).max(1_000_000).default(0),
  durationMs: wholeNumber.default(0),
  error: z.string().default(""),
  startedAt: isoDate.optional(),
  externalRef: externalRefSchema.optional(),
});

export const ingestBatchSchema = z
  .object({
    runs: z.array(ingestRunSchema).max(MAX_RUNS_PER_BATCH, `A batch can hold up to ${MAX_RUNS_PER_BATCH} runs.`).default([]),
    steps: z.array(ingestStepSchema).max(MAX_STEPS_PER_BATCH, `A batch can hold up to ${MAX_STEPS_PER_BATCH} steps.`).default([]),
  })
  .refine((batch) => batch.runs.length > 0 || batch.steps.length > 0, { message: "Send at least one run or step." });

export type IngestRun = z.infer<typeof ingestRunSchema>;
export type IngestStep = z.infer<typeof ingestStepSchema>;
export type IngestBatch = z.infer<typeof ingestBatchSchema>;

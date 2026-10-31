import { z } from "zod";
import { MAX_CHECKS_PER_TEST, MAX_CHECK_TEXT_LENGTH, MAX_STEPS_PER_RUN, MAX_TEST_NAME_LENGTH } from "../../constants";

// What a person may send when saving or changing a test.

const words = z.string().trim().min(1, "Please type the words to look for.").max(MAX_CHECK_TEXT_LENGTH, `Keep it under ${MAX_CHECK_TEXT_LENGTH} letters.`);

export const checkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("contains"), value: words }),
  z.object({ type: z.literal("not_contains"), value: words }),
  z.object({ type: z.literal("equals"), value: words }),
  z.object({ type: z.literal("max_cost"), value: z.number().positive("The cost must be more than 0.").max(1000) }),
  z.object({ type: z.literal("max_ms"), value: z.number().int().min(1, "The time must be at least 1 millisecond.").max(600_000) }),
]);

const checks = z.array(checkSchema).min(1, "Add at least one check, or the test could never fail.").max(MAX_CHECKS_PER_TEST, `A test can have up to ${MAX_CHECKS_PER_TEST} checks.`);
const name = z.string().trim().min(1, "Please give the test a name.").max(MAX_TEST_NAME_LENGTH);

export const createTestSchema = z.object({
  name,
  sourceRunId: z.string().regex(/^[a-f0-9]{24}$/i, "That run was not found."),
  // The AI step to test. Without it, the last AI step of the run is used.
  stepIndex: z.number().int().min(0).max(MAX_STEPS_PER_RUN - 1).optional(),
  checks,
});

export const updateTestSchema = z
  .object({ name: name.optional(), checks: checks.optional() })
  .refine((body) => body.name !== undefined || body.checks !== undefined, { message: "Nothing to change." });

export const runSuiteSchema = z.object({ model: z.string().trim().min(1).max(80).optional() });

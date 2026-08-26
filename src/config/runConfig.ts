import { z } from 'zod';
import { PersonaSchema } from '../personas/schema.ts';
import { GoalSchema } from '../goals/schema.ts';

/**
 * Everything one simulation run needs.
 *
 * Assembled by the CLI and validated here, so a library caller and a CLI caller
 * are held to exactly the same contract. Defaults are chosen to be safe rather
 * than permissive: a run that has not been told otherwise blocks destructive
 * actions and stays on the origin it started from.
 */

const LimitsSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(200).default(40),
    wallClockMs: z.number().int().min(1000).max(30 * 60 * 1000).default(5 * 60 * 1000),
    maxNoChangeSteps: z.number().int().min(2).max(20).default(4),
    maxRepeatedActions: z.number().int().min(2).max(20).default(3),
    maxConsecutiveErrors: z.number().int().min(1).max(20).default(4),
  })
  .strict();

export const RunConfigSchema = z
  .object({
    /** Where the customer starts. Must be http or https. */
    startUrl: z
      .string()
      .url()
      .refine((value) => /^https?:$/.test(new URL(value).protocol), {
        message: 'startUrl must be http or https',
      }),
    goal: GoalSchema,
    persona: PersonaSchema,
    limits: LimitsSchema.prefault({}),
    /** Extra origins the run may follow links to. The start origin is implicit. */
    allowedOrigins: z.array(z.string().url()).max(20).default([]),
    /** Root for the database and artifacts. Gitignored. */
    dataDir: z.string().min(1).default('data'),
    headless: z.boolean().default(true),
    /** Screenshots cost time and disk; they are diagnostic, not required. */
    screenshots: z.boolean().default(true),
    /**
     * Turning this off lets the agent press buttons that spend money or send
     * real messages. It exists for a deliberately authorised run against a
     * sandbox, and defaults to on everywhere else.
     */
    blockDestructive: z.boolean().default(true),
    /** Skip the LLM evaluation pass and just record the run. */
    evaluate: z.boolean().default(true),
  })
  .strict();

export type RunConfig = z.infer<typeof RunConfigSchema>;

import { z } from 'zod';

/**
 * What we report back about a run.
 *
 * The load-bearing decision is `attribution`. Every finding must say whose
 * problem it is:
 *
 *  - PRODUCT_FRICTION   — the product made this hard for the customer.
 *  - AGENT_LIMITATION   — our simulated customer was not up to it. Our fault.
 *  - TECHNICAL_FAILURE  — the run broke. Also our fault, differently.
 *
 * Without that split, our own failures quietly get billed to the customer's
 * product, and the report becomes worthless the first time someone checks one.
 * With it, our error rate is a number we can watch, which is the only honest
 * basis for selling findings as evidence.
 *
 * `stepRefs` exists for the same reason: a finding must point at steps that
 * actually happened, and those references are checked against the record rather
 * than taken on trust.
 */

export const ATTRIBUTIONS = ['PRODUCT_FRICTION', 'AGENT_LIMITATION', 'TECHNICAL_FAILURE'] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

export const SEVERITIES = ['low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FindingSchema = z
  .object({
    title: z.string().min(1).max(200),
    /** What the customer experienced, in plain terms. */
    description: z.string().min(1).max(2000),
    attribution: z.enum(ATTRIBUTIONS),
    severity: z.enum(SEVERITIES),
    /** Zero-based step indices this finding rests on. Validated against the record. */
    stepRefs: z.array(z.number().int().min(0)).min(1).max(20),
  })
  .strict();

export type Finding = z.infer<typeof FindingSchema>;

/** Facts computed from the record without a model. Reproducible, and checkable. */
export const DeterministicFactsSchema = z
  .object({
    stepCount: z.number().int().min(0),
    durationMs: z.number().int().min(0),
    actionsAttempted: z.number().int().min(0),
    actionsFailed: z.number().int().min(0),
    plannerFailures: z.number().int().min(0),
    /** Count per ErrorKind, only for kinds that occurred. */
    errorsByKind: z.record(z.string(), z.number().int().min(1)),
    distinctUrls: z.number().int().min(0),
    /** URLs visited more than once — backtracking is a friction signal. */
    revisitedUrls: z.array(z.string()).max(50),
    destructiveActionsBlocked: z.number().int().min(0),
    /** True when the failure was ours, not the product's. */
    runIsTechnicallySound: z.boolean(),
  })
  .strict();

export type DeterministicFacts = z.infer<typeof DeterministicFactsSchema>;

export const EvaluationSchema = z
  .object({
    sessionId: z.string().min(1),
    /** The agent's own claim, restated. Not the evaluator's verdict. */
    goalAchieved: z.boolean(),
    /** Two or three sentences a product person could read on its own. */
    summary: z.string().min(1).max(3000),
    findings: z.array(FindingSchema).max(25),
    facts: DeterministicFactsSchema,
  })
  .strict();

export type Evaluation = z.infer<typeof EvaluationSchema>;

/** The part the model is asked to produce; the facts are ours. */
export const ModelEvaluationSchema = EvaluationSchema.pick({
  goalAchieved: true,
  summary: true,
  findings: true,
});

export type ModelEvaluation = z.infer<typeof ModelEvaluationSchema>;

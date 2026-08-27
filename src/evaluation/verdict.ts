import { z } from 'zod';

/**
 * The customer's own verdict on the experience.
 *
 * EXPERIMENTAL. Read this before quoting any number from it.
 *
 * These fields are a language model's guess at how a described person would
 * feel, inferred from a text transcript of a browser session. They are NOT a
 * prediction of real human behaviour, and there is currently no evidence that
 * they correlate with what an actual customer would do. Nothing here has been
 * validated against a human.
 *
 * They are worth capturing anyway for two reasons. A satisfaction score that
 * moves when a product changes is a cheap directional signal, and a verdict
 * that disagrees with the findings is a useful tell that one of the two is
 * wrong. Neither use requires the number to be accurate in absolute terms.
 *
 * What it must never be used for: a claim to a customer that their real users
 * would rate them N out of 10, or that some percentage would pay. That would be
 * inventing evidence, which is the one thing this whole system is built not to
 * do.
 */

export const WOULD_PAY_VERDICTS = [
  'YES',
  'NO',
  /** The run never reached anything that would inform the question. */
  'NOT_APPLICABLE',
] as const;

export type WouldPayVerdict = (typeof WOULD_PAY_VERDICTS)[number];

export const CustomerVerdictSchema = z
  .object({
    /**
     * 1 (would abandon and warn others) to 5 (would recommend).
     *
     * A coarse scale on purpose: a model asked for a number out of 100 will
     * produce false precision, and we have nothing to calibrate it against.
     */
    satisfactionScore: z.number().int().min(1).max(5),
    /** In the customer's own voice, and short. */
    satisfactionReason: z.string().min(1).max(1000),
    wouldUseAgain: z.boolean(),
    wouldUseAgainReason: z.string().min(1).max(1000),
    /**
     * NOT_APPLICABLE is the honest answer for most runs: a customer who never
     * saw pricing, never hit a paywall and never finished the task has no basis
     * for the question, and a forced yes/no there is noise.
     */
    wouldPay: z.enum(WOULD_PAY_VERDICTS),
    wouldPayReason: z.string().min(1).max(1000),
    /** How much the transcript actually supports this verdict. */
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();

export type CustomerVerdict = z.infer<typeof CustomerVerdictSchema>;

/** Printed next to the verdict everywhere it is shown. Not optional. */
export const VERDICT_CAVEAT =
  'Experimental signal. This is a model inferring how a described person would ' +
  'feel from a text transcript. It is not a prediction of real customer ' +
  'behaviour and has not been validated against human responses.';

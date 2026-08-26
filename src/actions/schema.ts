import { z } from 'zod';

/**
 * The complete set of things the agent is allowed to do.
 *
 * This union is the security boundary. The model produces JSON; nothing it
 * emits reaches Playwright until it has parsed cleanly here. Consequences that
 * are easy to erode and must not be:
 *
 *  - Targets are opaque snapshot refs (`e14`), never selectors. The model can
 *    only point at something we showed it, so it cannot invent a target.
 *  - There is no `navigate` action. Real customers reach pages by clicking;
 *    letting the agent type a URL would teleport it past the exact friction we
 *    exist to detect. `go_back` is allowed because customers do go back.
 *  - Secret values are referenced by name and resolved at execution time, so a
 *    password never exists in model output, a prompt, a log or a record.
 *  - `press_key` is an enum, not a free string, so it cannot become a channel
 *    for arbitrary input.
 *
 * Widening this union is a deliberate decision, not a convenience.
 */

/** Snapshot refs are minted by the observation layer: `e` followed by digits. */
export const RefSchema = z
  .string()
  .regex(/^e\d+$/, 'ref must look like "e12" (an opaque snapshot ref, never a selector)');

/**
 * A reference to a configured credential. The value is substituted inside the
 * executor and never travels with the action.
 */
export const SecretRefSchema = z
  .object({
    secret: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'secret must be an UPPER_SNAKE_CASE name'),
  })
  .strict();

export const TypeValueSchema = z.union([z.string().max(500), SecretRefSchema]);

export const PRESSABLE_KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'Backspace',
] as const;

/**
 * Present on every action. `expectation` is not decoration: comparing what the
 * agent expected against what the page actually did is our primary friction
 * signal, and the evaluator depends on it. Do not drop it to save tokens.
 */
const commonFields = {
  reasoning: z.string().min(1).max(2000),
  expectation: z.string().min(1).max(2000),
};

export const ClickActionSchema = z
  .object({ action: z.literal('click'), ref: RefSchema, ...commonFields })
  .strict();

export const TypeActionSchema = z
  .object({
    action: z.literal('type'),
    ref: RefSchema,
    value: TypeValueSchema,
    /** Press Enter after typing, the way an impatient person does. */
    submit: z.boolean().default(false),
    ...commonFields,
  })
  .strict();

export const SelectActionSchema = z
  .object({
    action: z.literal('select'),
    ref: RefSchema,
    /** Matched against the option's value, then its visible label. */
    value: z.string().min(1).max(200),
    ...commonFields,
  })
  .strict();

export const ScrollActionSchema = z
  .object({
    action: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    amount: z.enum(['page', 'half']).default('page'),
    ...commonFields,
  })
  .strict();

export const PressKeyActionSchema = z
  .object({ action: z.literal('press_key'), key: z.enum(PRESSABLE_KEYS), ...commonFields })
  .strict();

export const GoBackActionSchema = z
  .object({ action: z.literal('go_back'), ...commonFields })
  .strict();

export const WaitActionSchema = z
  .object({
    action: z.literal('wait'),
    /** Capped so a model cannot stall a run by waiting a very long time. */
    ms: z.number().int().min(100).max(5000),
    ...commonFields,
  })
  .strict();

export const FinishActionSchema = z
  .object({
    action: z.literal('finish'),
    goalAchieved: z.boolean(),
    /** What on the page convinced the agent. The evaluator checks this claim. */
    evidence: z.string().min(1).max(2000),
    ...commonFields,
  })
  .strict();

export const BLOCKER_KINDS = [
  /** The product asked for something the agent cannot supply (e.g. a real card). */
  'REQUIRES_REAL_WORLD_INPUT',
  /** A confirmation email or SMS is needed. Out of scope for V0. */
  'REQUIRES_VERIFICATION',
  /** The next step would be destructive or spend money. */
  'WOULD_BE_DESTRUCTIVE',
  /** The agent cannot find the way forward. */
  'CANNOT_FIND_PATH',
  /** The product appears broken. */
  'PRODUCT_ERROR',
  /** A bot check, login wall or similar barrier. */
  'BLOCKED_BY_SITE',
] as const;

export const FailActionSchema = z
  .object({
    action: z.literal('fail'),
    reason: z.string().min(1).max(2000),
    blocker: z.enum(BLOCKER_KINDS),
    ...commonFields,
  })
  .strict();

export const ActionSchema = z.discriminatedUnion('action', [
  ClickActionSchema,
  TypeActionSchema,
  SelectActionSchema,
  ScrollActionSchema,
  PressKeyActionSchema,
  GoBackActionSchema,
  WaitActionSchema,
  FinishActionSchema,
  FailActionSchema,
]);

export type Action = z.infer<typeof ActionSchema>;
export type ClickAction = z.infer<typeof ClickActionSchema>;
export type TypeAction = z.infer<typeof TypeActionSchema>;
export type SelectAction = z.infer<typeof SelectActionSchema>;
export type ScrollAction = z.infer<typeof ScrollActionSchema>;
export type PressKeyAction = z.infer<typeof PressKeyActionSchema>;
export type WaitAction = z.infer<typeof WaitActionSchema>;
export type FinishAction = z.infer<typeof FinishActionSchema>;
export type FailAction = z.infer<typeof FailActionSchema>;
export type SecretRef = z.infer<typeof SecretRefSchema>;
export type ActionKind = Action['action'];
export type Blocker = (typeof BLOCKER_KINDS)[number];

/** `finish` and `fail` end the run; everything else touches the page. */
export function isTerminalAction(action: Action): boolean {
  return action.action === 'finish' || action.action === 'fail';
}

export function isSecretRef(value: string | SecretRef): value is SecretRef {
  return typeof value !== 'string';
}

/**
 * A one-line description safe for logs, records and prompt history. Secret
 * values are never in the action to begin with; this keeps the *name* visible
 * so a reader can see which credential was used.
 */
export function describeAction(action: Action): string {
  switch (action.action) {
    case 'click':
      return `click ${action.ref}`;
    case 'type':
      return isSecretRef(action.value)
        ? `type <secret:${action.value.secret}> into ${action.ref}${action.submit ? ' and submit' : ''}`
        : `type ${JSON.stringify(action.value)} into ${action.ref}${action.submit ? ' and submit' : ''}`;
    case 'select':
      return `select ${JSON.stringify(action.value)} in ${action.ref}`;
    case 'scroll':
      return `scroll ${action.direction} (${action.amount})`;
    case 'press_key':
      return `press ${action.key}`;
    case 'go_back':
      return 'go back';
    case 'wait':
      return `wait ${action.ms}ms`;
    case 'finish':
      return `finish (goalAchieved=${action.goalAchieved})`;
    case 'fail':
      return `fail (${action.blocker})`;
  }
}

/**
 * Identity for loop detection: two actions with the same signature are "the
 * same move". Reasoning and expectation are excluded — a model that rephrases
 * its justification while clicking the same dead button is still stuck.
 */
export function actionSignature(action: Action): string {
  switch (action.action) {
    case 'click':
      return `click:${action.ref}`;
    case 'type':
      return isSecretRef(action.value)
        ? `type:${action.ref}:secret:${action.value.secret}`
        : `type:${action.ref}:${action.value}`;
    case 'select':
      return `select:${action.ref}:${action.value}`;
    case 'scroll':
      return `scroll:${action.direction}:${action.amount}`;
    case 'press_key':
      return `press_key:${action.key}`;
    case 'go_back':
      return 'go_back';
    case 'wait':
      return `wait:${action.ms}`;
    case 'finish':
      return `finish:${action.goalAchieved}`;
    case 'fail':
      return `fail:${action.blocker}`;
  }
}

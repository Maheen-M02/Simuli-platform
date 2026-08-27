import { ActionSchema, type Action } from '../actions/schema.ts';
import type { LlmClient } from '../llm/client.ts';
import { ACTION_JSON_SCHEMA, buildSystemPrompt, buildUserPrompt } from './prompt.ts';
import type { Goal } from '../goals/schema.ts';
import type { CustomerContext } from '../personas/context.ts';
import type { Observation } from '../observations/types.ts';
import { err, ok, type Result } from '../types/shared.ts';

/**
 * The planner interface.
 *
 * The LLM is a pure function: (persona, goal, observation, history) -> Action.
 * It gets no browser handle, no filesystem, no network and no code execution.
 * Everything it can influence has to travel back through a single validated
 * Action, which is what makes the blast radius of a bad model output equal to
 * the blast radius of one click.
 *
 * It is an interface so the loop can be tested exhaustively with a scripted
 * fake. Unit tests never call a real model: model judgment is not what those
 * tests are checking, and a suite that depends on it fails for reasons that
 * have nothing to do with the code under test.
 */

/** One past step, as the model is told about it. */
export type HistoryEntry = {
  readonly stepIndex: number;
  /** What the agent did, described without secret values. */
  readonly action: string;
  /** What it expected to happen. */
  readonly expectation: string;
  /** What actually happened — the friction signal lives in this gap. */
  readonly outcome: string;
};

export type PlannerInput = {
  /** Who the customer is, and what they came here for. */
  readonly context: CustomerContext;
  readonly goal: Goal;
  readonly observation: Observation;
  readonly history: readonly HistoryEntry[];
  /** Credential names the agent may reference. Never the values. */
  readonly availableSecrets: readonly string[];
  readonly stepsRemaining: number;
};

/**
 * Returns a validated action, or a description of why one could not be
 * produced. The error is a value: a planner failure is a recorded step, not an
 * exception that ends the run without evidence.
 */
export type Planner = (input: PlannerInput) => Promise<Result<Action, string>>;

/**
 * How often the model produced something we could not use.
 *
 * `invalidActions` counts replies that failed Zod validation. `recoveredActions`
 * counts those that then validated on the retry. The pair matters for comparing
 * providers: a model that is wrong once and self-corrects is usable, while one
 * that is wrong twice costs a step and a recorded planner failure.
 */
export type PlannerStats = {
  readonly calls: number;
  readonly invalidActions: number;
  readonly recoveredActions: number;
  readonly unusable: number;
  readonly transportFailures: number;
};

export type ModelPlanner = {
  readonly planner: Planner;
  stats(): PlannerStats;
};

/**
 * The production planner: prompt the model, then validate hard.
 *
 * The model's answer is untrusted input. It is asked for a particular shape,
 * but what it actually returns is parsed against the Zod schema before it can
 * affect anything — the request format is a convenience, not a guarantee.
 *
 * A validation failure is retried once with the errors fed back, because models
 * usually fix a schema mistake when shown it. After that the step is recorded
 * as a planner failure and the loop decides what to do; it is never silently
 * coerced into some nearby action we invented on the model's behalf.
 */
export function createModelPlanner(options: {
  readonly client: LlmClient;
  readonly model: string;
  readonly maxSchemaRetries?: number;
  readonly maxOutputTokens?: number;
}): ModelPlanner {
  const maxSchemaRetries = options.maxSchemaRetries ?? 1;

  let calls = 0;
  let invalidActions = 0;
  let recoveredActions = 0;
  let unusable = 0;
  let transportFailures = 0;

  const planner: Planner = async (input) => {
    calls += 1;
    let sawInvalid = false;
    const system = buildSystemPrompt(input);
    let user = buildUserPrompt(input);

    for (let attempt = 0; attempt <= maxSchemaRetries; attempt++) {
      const response = await options.client.completeJson({
        model: options.model,
        system,
        user,
        schemaName: 'customer_action',
        jsonSchema: ACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
        // One action plus its reasoning is a few hundred tokens. Asking for the
        // client's larger default reserves budget we will never use, which a
        // metered endpoint charges for and a prepaid one refuses outright.
        maxOutputTokens: options.maxOutputTokens ?? 1024,
      });

      if (!response.ok) {
        transportFailures += 1;
        return err(response.error);
      }

      const envelope = response.value;
      const decision =
        envelope !== null && typeof envelope === 'object' && 'decision' in envelope
          ? (envelope as { decision: unknown }).decision
          : envelope;

      const parsed = ActionSchema.safeParse(decision);
      if (parsed.success) {
        if (sawInvalid) recoveredActions += 1;
        return ok(parsed.data);
      }

      sawInvalid = true;
      invalidActions += 1;

      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');

      if (attempt === maxSchemaRetries) {
        unusable += 1;
        return err(`The model's action did not validate: ${issues}`);
      }

      user = `${buildUserPrompt(input)}

Your previous answer could not be used: ${issues}
Answer again, using only the allowed action shapes and only refs listed above.`;
    }

    // Unreachable: the loop above always returns.
    return err('The planner produced no answer.');
  };

  return {
    planner,
    stats: () => ({ calls, invalidActions, recoveredActions, unusable, transportFailures }),
  };
}

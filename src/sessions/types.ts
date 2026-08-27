import type { Action } from '../actions/schema.ts';
import type { Goal } from '../goals/schema.ts';
import type { CustomerContext } from '../personas/context.ts';
import type { ActionResult } from '../types/shared.ts';

/**
 * The record of what happened during a run.
 *
 * This is the only thing the evaluator ever reads. It must therefore be
 * complete enough to judge the run from, and self-contained enough that a
 * session recorded months ago can be re-evaluated against a better evaluator
 * without the browser, the model or the product still being available.
 */

/**
 * Every run ends as exactly one of these. There is no "still running" state on
 * disk: a crashed run is an ERROR, not an absence.
 */
export const OUTCOMES = ['SUCCESS', 'FAILURE', 'STUCK', 'TIMEOUT', 'ERROR'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Why the loop stopped. Distinct from the outcome, which is the verdict. */
export const TERMINATION_REASONS = [
  'AGENT_FINISHED',
  'AGENT_FAILED',
  'MAX_STEPS',
  'WALL_CLOCK',
  'NO_CHANGE_LOOP',
  'REPEATED_ACTION_LOOP',
  'CONSECUTIVE_ERRORS',
  'PLANNER_FAILED',
  'BROWSER_LOST',
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/** What the agent saw, flattened for storage. */
export type ObservationRecord = {
  readonly generation: number;
  readonly capturedAt: number;
  readonly url: string;
  readonly title: string;
  /** Exactly the text the model was shown. Reproducibility depends on this. */
  readonly text: string;
  readonly nodeCount: number;
  readonly screenshotPath: string | null;
};

export type StepRecord = {
  readonly index: number;
  readonly observation: ObservationRecord;
  /** Absent when the planner failed to produce a usable action. */
  readonly action: Action | null;
  /** Absent when there was no action to execute. */
  readonly result: ActionResult | null;
  /** Set when the planner itself failed, rather than the action. */
  readonly plannerError: string | null;
  readonly startedAt: number;
  readonly endedAt: number;
};

export type SessionRecord = {
  readonly id: string;
  readonly startUrl: string;
  /** Who the customer was and what they came for. */
  readonly context: CustomerContext;
  readonly goal: Goal;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly outcome: Outcome | null;
  readonly terminationReason: TerminationReason | null;
  /** The agent's own closing statement, from `finish` or `fail`. */
  readonly agentSummary: string | null;
  readonly steps: readonly StepRecord[];
  /** Model used to plan, recorded so an old run stays interpretable. */
  readonly plannerModel: string;
};

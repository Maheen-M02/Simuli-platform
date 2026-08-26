import type { Action } from '../actions/schema.ts';
import type { Goal } from '../goals/schema.ts';
import type { Persona } from '../personas/schema.ts';
import type { Observation } from '../observations/types.ts';
import type { Result } from '../types/shared.ts';

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
  readonly persona: Persona;
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

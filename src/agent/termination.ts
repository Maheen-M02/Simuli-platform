import type { Action } from '../actions/schema.ts';
import { actionSignature } from '../actions/schema.ts';
import type { TerminationReason } from '../sessions/types.ts';
import type { ActionResult } from '../types/shared.ts';

/**
 * When a run must stop.
 *
 * Every run has enforced termination. No simulation may hang: an agent that
 * cannot finish must still produce a record and an explicit outcome, because a
 * run that never ends teaches us nothing and costs money the whole time.
 *
 * These are pure functions over accumulated counters — no clock, no browser, no
 * model. That is what makes each condition testable on its own, which the spec
 * requires and which matters because these are the checks that fire only when
 * something has already gone wrong.
 */

export type Limits = {
  readonly maxSteps: number;
  readonly wallClockMs: number;
  /** Identical page, this many times running, means nothing is happening. */
  readonly maxNoChangeSteps: number;
  /** The same move repeated this many times means the agent is stuck. */
  readonly maxRepeatedActions: number;
  /** Consecutive failed actions before we call the run broken. */
  readonly maxConsecutiveErrors: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxSteps: 40,
  wallClockMs: 5 * 60 * 1000,
  maxNoChangeSteps: 4,
  maxRepeatedActions: 3,
  maxConsecutiveErrors: 4,
};

export type LoopState = {
  readonly stepCount: number;
  /** Consecutive steps whose page looked identical to the one before. */
  readonly unchangedStreak: number;
  /** Consecutive steps issuing the same action signature. */
  readonly repeatedActionStreak: number;
  readonly consecutiveErrors: number;
  readonly lastFingerprint: string | null;
  readonly lastSignature: string | null;
};

export const INITIAL_STATE: LoopState = {
  stepCount: 0,
  unchangedStreak: 0,
  repeatedActionStreak: 0,
  consecutiveErrors: 0,
  lastFingerprint: null,
  lastSignature: null,
};

/** Folds one observation into the state. Called before the agent decides. */
export function observeState(state: LoopState, fingerprint: string): LoopState {
  const unchanged = state.lastFingerprint === fingerprint;
  return {
    ...state,
    unchangedStreak: unchanged ? state.unchangedStreak + 1 : 0,
    lastFingerprint: fingerprint,
  };
}

/** Folds one completed action into the state. Called after it executes. */
export function actState(state: LoopState, action: Action, result: ActionResult): LoopState {
  const signature = actionSignature(action);
  const repeated = state.lastSignature === signature;

  return {
    ...state,
    stepCount: state.stepCount + 1,
    repeatedActionStreak: repeated ? state.repeatedActionStreak + 1 : 0,
    consecutiveErrors: result.ok ? 0 : state.consecutiveErrors + 1,
    lastSignature: signature,
  };
}

/** Records a step where the planner produced nothing usable. */
export function plannerFailedState(state: LoopState): LoopState {
  return {
    ...state,
    stepCount: state.stepCount + 1,
    consecutiveErrors: state.consecutiveErrors + 1,
  };
}

/**
 * The single place a run's continuation is decided.
 *
 * Order matters: a `finish` or `fail` the agent actually chose outranks any
 * limit, so a run that reached a real conclusion on its final permitted step is
 * reported as a conclusion rather than as a timeout.
 */
export function checkTermination(
  state: LoopState,
  limits: Limits,
  elapsedMs: number,
  lastAction: Action | null,
): TerminationReason | null {
  if (lastAction?.action === 'finish') return 'AGENT_FINISHED';
  if (lastAction?.action === 'fail') return 'AGENT_FAILED';

  if (state.consecutiveErrors >= limits.maxConsecutiveErrors) return 'CONSECUTIVE_ERRORS';
  if (state.repeatedActionStreak >= limits.maxRepeatedActions) return 'REPEATED_ACTION_LOOP';
  if (state.unchangedStreak >= limits.maxNoChangeSteps) return 'NO_CHANGE_LOOP';
  if (state.stepCount >= limits.maxSteps) return 'MAX_STEPS';
  if (elapsedMs >= limits.wallClockMs) return 'WALL_CLOCK';

  return null;
}

/**
 * The verdict that goes with a stop.
 *
 * Only the agent can claim success, and only by pointing at evidence. Every
 * other ending is a way of not succeeding, and they are kept distinct because
 * "the product blocked them" and "our agent got confused" are different
 * findings — conflating them would let us quietly count our own failures as the
 * product's.
 */
export function outcomeFor(
  reason: TerminationReason,
  lastAction: Action | null,
): 'SUCCESS' | 'FAILURE' | 'STUCK' | 'TIMEOUT' | 'ERROR' {
  switch (reason) {
    case 'AGENT_FINISHED':
      return lastAction?.action === 'finish' && lastAction.goalAchieved ? 'SUCCESS' : 'FAILURE';
    case 'AGENT_FAILED':
      return 'FAILURE';
    case 'NO_CHANGE_LOOP':
    case 'REPEATED_ACTION_LOOP':
      return 'STUCK';
    case 'MAX_STEPS':
    case 'WALL_CLOCK':
      return 'TIMEOUT';
    case 'CONSECUTIVE_ERRORS':
    case 'PLANNER_FAILED':
    case 'BROWSER_LOST':
      return 'ERROR';
  }
}

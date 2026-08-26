import { describe, expect, it } from 'vitest';
import {
  actState,
  checkTermination,
  DEFAULT_LIMITS,
  INITIAL_STATE,
  observeState,
  outcomeFor,
  plannerFailedState,
  type Limits,
  type LoopState,
} from '../../src/agent/termination.ts';
import { ActionSchema, type Action } from '../../src/actions/schema.ts';
import type { ActionResult } from '../../src/types/shared.ts';

/**
 * Each termination condition is tested on its own. They only ever fire when a
 * run has already gone wrong, so they get no natural exercise from the happy
 * path — if one is broken, the symptom is a simulation that never stops.
 */

const common = { reasoning: 'r', expectation: 'e' };
const click = (ref: string): Action => ActionSchema.parse({ action: 'click', ref, ...common });
const ok: ActionResult = { ok: true, durationMs: 1, navigated: false };
const failed: ActionResult = {
  ok: false,
  error: { kind: 'REF_NOT_FOUND', message: 'gone' },
  durationMs: 1,
  navigated: false,
};

const limits: Limits = {
  maxSteps: 10,
  wallClockMs: 60_000,
  maxNoChangeSteps: 3,
  maxRepeatedActions: 3,
  maxConsecutiveErrors: 3,
};

function check(state: LoopState, elapsedMs = 0, lastAction: Action | null = null) {
  return checkTermination(state, limits, elapsedMs, lastAction);
}

describe('termination — a healthy run keeps going', () => {
  it('does not stop a run that is making progress', () => {
    let state = INITIAL_STATE;
    for (let i = 0; i < 5; i++) {
      state = observeState(state, `page-${i}`);
      state = actState(state, click(`e${i}`), ok);
      expect(check(state, i * 1000)).toBeNull();
    }
  });
});

describe('termination — max steps', () => {
  it('stops exactly at the limit', () => {
    let state = INITIAL_STATE;
    for (let i = 0; i < limits.maxSteps - 1; i++) {
      state = observeState(state, `page-${i}`);
      state = actState(state, click(`e${i}`), ok);
    }
    expect(check(state)).toBeNull();

    state = observeState(state, 'page-final');
    state = actState(state, click('e99'), ok);
    expect(check(state)).toBe('MAX_STEPS');
  });
});

describe('termination — wall clock', () => {
  it('stops when the run has taken too long, whatever the step count', () => {
    const state = observeState(INITIAL_STATE, 'page');
    expect(check(state, limits.wallClockMs - 1)).toBeNull();
    expect(check(state, limits.wallClockMs)).toBe('WALL_CLOCK');
  });
});

describe('termination — no-change loop', () => {
  it('stops when the page has not moved for long enough', () => {
    let state = observeState(INITIAL_STATE, 'same');
    expect(check(state)).toBeNull();

    for (let i = 0; i < limits.maxNoChangeSteps - 1; i++) {
      state = observeState(state, 'same');
      expect(check(state)).toBeNull();
    }

    state = observeState(state, 'same');
    expect(check(state)).toBe('NO_CHANGE_LOOP');
  });

  it('resets the moment the page actually changes', () => {
    let state = INITIAL_STATE;
    for (let i = 0; i < 5; i++) state = observeState(state, 'same');
    expect(check(state)).toBe('NO_CHANGE_LOOP');

    state = observeState(state, 'different');
    expect(state.unchangedStreak).toBe(0);
    expect(check(state)).toBeNull();
  });
});

describe('termination — repeated action loop', () => {
  it('stops when the same move is made over and over', () => {
    let state = INITIAL_STATE;
    state = actState(state, click('e1'), ok);
    expect(check(state)).toBeNull();

    for (let i = 0; i < limits.maxRepeatedActions - 1; i++) {
      state = actState(state, click('e1'), ok);
      expect(check(state)).toBeNull();
    }

    state = actState(state, click('e1'), ok);
    expect(check(state)).toBe('REPEATED_ACTION_LOOP');
  });

  it('ignores rewritten justifications for the same move', () => {
    let state = INITIAL_STATE;
    for (const reasoning of ['first go', 'trying again', 'maybe now', 'once more']) {
      state = actState(
        state,
        ActionSchema.parse({ action: 'click', ref: 'e1', reasoning, expectation: 'e' }),
        ok,
      );
    }
    expect(check(state)).toBe('REPEATED_ACTION_LOOP');
  });

  it('resets when the agent tries something different', () => {
    let state = INITIAL_STATE;
    state = actState(state, click('e1'), ok);
    state = actState(state, click('e1'), ok);
    state = actState(state, click('e2'), ok);
    expect(state.repeatedActionStreak).toBe(0);
    expect(check(state)).toBeNull();
  });
});

describe('termination — consecutive errors', () => {
  it('stops after enough failures in a row', () => {
    let state = INITIAL_STATE;
    for (let i = 0; i < limits.maxConsecutiveErrors - 1; i++) {
      state = actState(state, click(`e${i}`), failed);
      expect(check(state)).toBeNull();
    }
    state = actState(state, click('e99'), failed);
    expect(check(state)).toBe('CONSECUTIVE_ERRORS');
  });

  it('resets on any success', () => {
    let state = INITIAL_STATE;
    state = actState(state, click('e1'), failed);
    state = actState(state, click('e2'), failed);
    state = actState(state, click('e3'), ok);
    expect(state.consecutiveErrors).toBe(0);
    expect(check(state)).toBeNull();
  });

  it('counts a planner failure as an error', () => {
    let state = INITIAL_STATE;
    for (let i = 0; i < limits.maxConsecutiveErrors; i++) state = plannerFailedState(state);
    expect(check(state)).toBe('CONSECUTIVE_ERRORS');
  });
});

describe('termination — the agent deciding for itself', () => {
  it('honours finish', () => {
    const finish = ActionSchema.parse({
      action: 'finish',
      goalAchieved: true,
      evidence: 'Invoice INV-0001 is listed as sent',
      ...common,
    });
    expect(check(INITIAL_STATE, 0, finish)).toBe('AGENT_FINISHED');
  });

  it('honours fail', () => {
    const fail = ActionSchema.parse({
      action: 'fail',
      reason: 'Signup needs an email code',
      blocker: 'REQUIRES_VERIFICATION',
      ...common,
    });
    expect(check(INITIAL_STATE, 0, fail)).toBe('AGENT_FAILED');
  });

  it('reports a real conclusion reached on the last permitted step as a conclusion', () => {
    // Otherwise a run that genuinely succeeded on step 40 is filed as a timeout.
    let state = INITIAL_STATE;
    for (let i = 0; i < limits.maxSteps; i++) state = actState(state, click(`e${i}`), ok);
    expect(check(state)).toBe('MAX_STEPS');

    const finish = ActionSchema.parse({
      action: 'finish',
      goalAchieved: true,
      evidence: 'done',
      ...common,
    });
    expect(check(state, limits.wallClockMs + 1, finish)).toBe('AGENT_FINISHED');
  });
});

describe('outcome mapping', () => {
  const finishAchieved = ActionSchema.parse({
    action: 'finish',
    goalAchieved: true,
    evidence: 'e',
    ...common,
  });
  const finishNotAchieved = ActionSchema.parse({
    action: 'finish',
    goalAchieved: false,
    evidence: 'e',
    ...common,
  });

  it('only calls a run successful when the agent claimed the goal', () => {
    expect(outcomeFor('AGENT_FINISHED', finishAchieved)).toBe('SUCCESS');
    expect(outcomeFor('AGENT_FINISHED', finishNotAchieved)).toBe('FAILURE');
  });

  it('keeps product failure, agent confusion and our own errors apart', () => {
    expect(outcomeFor('AGENT_FAILED', null)).toBe('FAILURE');
    expect(outcomeFor('NO_CHANGE_LOOP', null)).toBe('STUCK');
    expect(outcomeFor('REPEATED_ACTION_LOOP', null)).toBe('STUCK');
    expect(outcomeFor('MAX_STEPS', null)).toBe('TIMEOUT');
    expect(outcomeFor('WALL_CLOCK', null)).toBe('TIMEOUT');
    expect(outcomeFor('CONSECUTIVE_ERRORS', null)).toBe('ERROR');
    expect(outcomeFor('PLANNER_FAILED', null)).toBe('ERROR');
    expect(outcomeFor('BROWSER_LOST', null)).toBe('ERROR');
  });
});

describe('default limits', () => {
  it('are all finite, so no run can hang', () => {
    for (const value of Object.values(DEFAULT_LIMITS)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});

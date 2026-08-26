import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/persistence/db.ts';
import { createRecorder } from '../../src/sessions/recorder.ts';
import { ActionSchema } from '../../src/actions/schema.ts';
import { DEFAULT_PERSONA } from '../../src/personas/schema.ts';
import { GoalSchema } from '../../src/goals/schema.ts';
import type { Observation } from '../../src/observations/types.ts';
import type { ActionResult } from '../../src/types/shared.ts';

/**
 * Recording is only useful if it survives the runs that go wrong. A run that
 * completes tidily has little to tell us; a run that dies on step 12 has a lot,
 * and loses all of it under a write-at-the-end design. Hence the crash tests.
 */

const goal = GoalSchema.parse({ description: 'Send an invoice' });

function observation(index: number): Observation {
  return {
    generation: index,
    capturedAt: 1000 + index,
    snapshot: {
      url: `http://site.test/page-${index}`,
      title: `Page ${index}`,
      nodes: [{ ref: 'e1', role: 'button', name: 'Continue', inViewport: true }],
      hasMoreBelow: false,
      truncated: 0,
    },
    text: `URL: http://site.test/page-${index}`,
  };
}

const action = ActionSchema.parse({
  action: 'click',
  ref: 'e1',
  reasoning: 'move forward',
  expectation: 'the next page appears',
});

const okResult: ActionResult = { ok: true, durationMs: 12, navigated: true };

function setup(sessionId = 'run-1') {
  const db = openDb(':memory:');
  const recorder = createRecorder({
    sessionId,
    startUrl: 'http://site.test/',
    persona: DEFAULT_PERSONA,
    goal,
    plannerModel: 'test-model',
    db,
  });
  return { db, recorder };
}

describe('session recording', () => {
  it('writes the session row before any step exists', () => {
    const { db } = setup();
    const loaded = db.loadSession('run-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.outcome).toBeNull();
    expect(loaded?.steps).toEqual([]);
  });

  it('commits each step as it completes, not at the end', () => {
    const { db, recorder } = setup();

    recorder.beginStep(observation(1), null);
    recorder.completeStep(action, okResult);
    // The run is still in progress, but step 0 must already be on disk.
    expect(db.loadSession('run-1')?.steps).toHaveLength(1);

    recorder.beginStep(observation(2), null);
    recorder.completeStep(action, okResult);
    expect(db.loadSession('run-1')?.steps).toHaveLength(2);
    expect(db.loadSession('run-1')?.outcome).toBeNull();
  });

  it('keeps every completed step when the run dies mid-flight', () => {
    const { db, recorder } = setup();

    for (let i = 1; i <= 11; i++) {
      recorder.beginStep(observation(i), null);
      recorder.completeStep(action, okResult);
    }
    // Step 12: observed, then the process is gone. `finish` is never called.
    recorder.beginStep(observation(12), null);

    const loaded = db.loadSession('run-1');
    expect(loaded?.steps).toHaveLength(11);
    // An unfinished run reads as unfinished rather than as a missing one.
    expect(loaded?.outcome).toBeNull();
    expect(loaded?.endedAt).toBeNull();
    expect(loaded?.steps.at(-1)?.observation.url).toBe('http://site.test/page-11');
  });

  it('does not lose an observation the agent never acted on', () => {
    const { db, recorder } = setup();

    recorder.beginStep(observation(1), null);
    // A second beginStep without completing the first: the loop bailed out.
    recorder.beginStep(observation(2), null);
    recorder.completeStep(action, okResult);

    const steps = db.loadSession('run-1')?.steps ?? [];
    expect(steps).toHaveLength(2);
    expect(steps[0]?.action).toBeNull();
    expect(steps[0]?.plannerError).toContain('abandoned');
    expect(steps[1]?.action).not.toBeNull();
  });

  it('closes an open step when the run finishes', () => {
    const { db, recorder } = setup();
    recorder.beginStep(observation(1), null);
    recorder.finish('ERROR', 'BROWSER_LOST', null);

    const loaded = db.loadSession('run-1');
    expect(loaded?.steps).toHaveLength(1);
    expect(loaded?.steps[0]?.action).toBeNull();
    expect(loaded?.outcome).toBe('ERROR');
  });

  it('records a planner failure as a step rather than dropping it', () => {
    const { db, recorder } = setup();
    recorder.beginStep(observation(1), null);
    recorder.failStep('Model returned malformed JSON three times');

    const step = db.loadSession('run-1')?.steps[0];
    expect(step?.action).toBeNull();
    expect(step?.plannerError).toContain('malformed JSON');
  });

  it('round-trips a finished session faithfully', () => {
    const { db, recorder } = setup();
    recorder.beginStep(observation(1), 'data/run-1/step-000.png');
    recorder.completeStep(action, okResult);
    const finished = recorder.finish('SUCCESS', 'AGENT_FINISHED', 'Invoice INV-0001 was created.');

    const loaded = db.loadSession('run-1');
    expect(loaded?.outcome).toBe('SUCCESS');
    expect(loaded?.terminationReason).toBe('AGENT_FINISHED');
    expect(loaded?.agentSummary).toBe('Invoice INV-0001 was created.');
    expect(loaded?.persona.name).toBe(DEFAULT_PERSONA.name);
    expect(loaded?.goal.description).toBe('Send an invoice');
    expect(loaded?.plannerModel).toBe('test-model');
    expect(loaded?.steps[0]?.observation.screenshotPath).toBe('data/run-1/step-000.png');
    expect(loaded?.steps[0]?.action).toEqual(action);
    expect(loaded?.steps[0]?.result).toEqual(okResult);
    expect(loaded?.endedAt).toBe(finished.endedAt);
  });

  it('preserves a failed action result, error kind included', () => {
    const { db, recorder } = setup();
    recorder.beginStep(observation(1), null);
    recorder.completeStep(action, {
      ok: false,
      error: { kind: 'REF_AMBIGUOUS', message: 'two matches' },
      durationMs: 30,
      navigated: false,
    });

    const step = db.loadSession('run-1')?.steps[0];
    expect(step?.result?.ok).toBe(false);
    expect(step?.result?.error?.kind).toBe('REF_AMBIGUOUS');
  });

  it('keeps sessions separate', () => {
    const db = openDb(':memory:');
    for (const id of ['a', 'b']) {
      const recorder = createRecorder({
        sessionId: id,
        startUrl: 'http://site.test/',
        persona: DEFAULT_PERSONA,
        goal,
        plannerModel: 'test-model',
        db,
      });
      recorder.beginStep(observation(1), null);
      recorder.completeStep(action, okResult);
      recorder.finish('SUCCESS', 'AGENT_FINISHED', null);
    }

    expect(db.loadSession('a')?.steps).toHaveLength(1);
    expect(db.loadSession('b')?.steps).toHaveLength(1);
    expect(db.listSessionIds(10)).toHaveLength(2);
    expect(db.loadSession('missing')).toBeNull();
  });
});

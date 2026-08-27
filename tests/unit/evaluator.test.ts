import { describe, expect, it } from 'vitest';
import {
  evaluateSession,
  renderTranscript,
  validateStepRefs,
} from '../../src/evaluation/evaluator.ts';
import { computeFacts } from '../../src/evaluation/deterministic.ts';
import { FindingSchema, type Finding } from '../../src/evaluation/schema.ts';
import { ActionSchema } from '../../src/actions/schema.ts';
import { DEFAULT_PERSONA } from '../../src/personas/schema.ts';
import { GoalSchema } from '../../src/goals/schema.ts';
import type { SessionRecord, StepRecord } from '../../src/sessions/types.ts';
import type { ActionResult, ErrorKind } from '../../src/types/shared.ts';
import type { LlmClient } from '../../src/llm/client.ts';
import { ok } from '../../src/types/shared.ts';

/**
 * Evaluation is where a plausible paragraph can turn into a false claim about
 * somebody's product. Most of what follows tests refusal, not production.
 */

const common = { reasoning: 'because', expectation: 'something happens' };

function step(index: number, overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    index,
    observation: {
      generation: index + 1,
      capturedAt: 1000 + index,
      url: `http://site.test/page-${index}`,
      title: `Page ${index}`,
      text: `heading1 "Page ${index}"`,
      nodeCount: 3,
      screenshotPath: null,
    },
    action: ActionSchema.parse({ action: 'click', ref: 'e1', ...common }),
    result: { ok: true, durationMs: 10, navigated: true } satisfies ActionResult,
    plannerError: null,
    startedAt: 1000 + index,
    endedAt: 1100 + index,
    ...overrides,
  };
}

function record(steps: StepRecord[], overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'run-1',
    startUrl: 'http://site.test/',
    persona: DEFAULT_PERSONA,
    goal: GoalSchema.parse({ description: 'Create an invoice' }),
    plannerModel: 'test-model',
    startedAt: 1000,
    endedAt: 9000,
    outcome: 'SUCCESS',
    terminationReason: 'AGENT_FINISHED',
    agentSummary: 'Invoice INV-0001 created',
    steps,
    ...overrides,
  };
}

const finding = (stepRefs: number[]): Finding =>
  FindingSchema.parse({
    title: 'Password rules are hidden until you fail',
    description: 'The customer only learned the rule after a rejected attempt.',
    attribution: 'PRODUCT_FRICTION',
    severity: 'medium',
    stepRefs,
  });

function fakeClient(payload: unknown): LlmClient {
  return { async completeJson() { return ok(payload); } };
}

describe('deterministic pre-pass', () => {
  it('counts what happened without any model involved', () => {
    const failed: ActionResult = {
      ok: false,
      error: { kind: 'REF_NOT_FOUND', message: 'gone' },
      durationMs: 5,
      navigated: false,
    };

    const facts = computeFacts(
      record([step(0), step(1, { result: failed }), step(2, { action: null, plannerError: 'confused' })]),
    );

    expect(facts.stepCount).toBe(3);
    expect(facts.actionsAttempted).toBe(2);
    expect(facts.actionsFailed).toBe(1);
    expect(facts.plannerFailures).toBe(1);
    expect(facts.errorsByKind['REF_NOT_FOUND']).toBe(1);
    expect(facts.durationMs).toBe(8000);
  });

  it('notices backtracking', () => {
    const revisit = step(2);
    const facts = computeFacts(
      record([
        step(0),
        step(1),
        { ...revisit, observation: { ...revisit.observation, url: 'http://site.test/page-0' } },
      ]),
    );
    expect(facts.distinctUrls).toBe(2);
    expect(facts.revisitedUrls).toEqual(['http://site.test/page-0']);
  });

  it('counts destructive refusals separately from ordinary failures', () => {
    const blocked: ActionResult = {
      ok: false,
      error: { kind: 'ACTION_BLOCKED', message: 'would send a real invoice' },
      durationMs: 1,
      navigated: false,
    };
    const facts = computeFacts(record([step(0, { result: blocked })]));
    expect(facts.destructiveActionsBlocked).toBe(1);
    // Refusing to press "Send" is our policy working, not our tooling breaking.
    expect(facts.runIsTechnicallySound).toBe(true);
  });

  it('marks a run unsound when our own machinery failed', () => {
    for (const kind of ['BROWSER_CRASHED', 'UNKNOWN', 'STALE_SNAPSHOT', 'SECRET_NOT_FOUND'] as ErrorKind[]) {
      const facts = computeFacts(
        record([
          step(0, {
            result: { ok: false, error: { kind, message: 'x' }, durationMs: 1, navigated: false },
          }),
        ]),
      );
      expect(facts.runIsTechnicallySound, kind).toBe(false);
    }
  });

  it('marks a run unsound when it ended in ERROR', () => {
    const facts = computeFacts(record([step(0)], { outcome: 'ERROR', terminationReason: 'BROWSER_LOST' }));
    expect(facts.runIsTechnicallySound).toBe(false);
  });

  it('does not blame the product for a technically broken run', () => {
    const facts = computeFacts(record([step(0)], { outcome: 'ERROR' }));
    expect(facts.runIsTechnicallySound).toBe(false);
  });
});

describe('step-reference validation', () => {
  it('keeps a finding that cites real steps', () => {
    const { kept, rejected } = validateStepRefs([finding([0, 1])], 3);
    expect(kept).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it('drops a finding whose evidence never happened', () => {
    const { kept, rejected } = validateStepRefs([finding([14])], 9);
    expect(kept).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it('strips phantom references but keeps a finding with real evidence left', () => {
    const { kept } = validateStepRefs([finding([1, 99])], 5);
    expect(kept[0]?.stepRefs).toEqual([1]);
  });

  it('rejects an out-of-range reference and keeps the last real one', () => {
    expect(validateStepRefs([finding([5])], 5).kept).toHaveLength(0);
    expect(validateStepRefs([finding([4])], 5).kept).toHaveLength(1);
  });

  it('never accepts a negative reference in the first place', () => {
    // The schema stops this before validateStepRefs is reached; the range check
    // there is the second line, for a finding built some other way.
    expect(FindingSchema.safeParse({ ...finding([0]), stepRefs: [-1] }).success).toBe(false);
    expect(validateStepRefs([{ ...finding([0]), stepRefs: [-1] }], 5).kept).toHaveLength(0);
  });

  it('handles a record with no steps at all', () => {
    expect(validateStepRefs([finding([0])], 0).kept).toHaveLength(0);
  });
});

describe('evaluation output', () => {
  const validPayload = {
    goalAchieved: true,
    summary: 'The customer created an invoice, but had to guess where invoices lived.',
    findings: [
      {
        title: 'Invoices are hidden behind "Billing"',
        description: 'The customer looked for "Invoices" and found nothing by that name.',
        attribution: 'PRODUCT_FRICTION',
        severity: 'medium',
        stepRefs: [1],
      },
    ],
  };

  it('produces a validated evaluation carrying our own facts', async () => {
    const result = await evaluateSession(record([step(0), step(1)]), {
      client: fakeClient(validPayload),
      model: 'test-model',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe('run-1');
    expect(result.value.findings).toHaveLength(1);
    // The facts are computed by us, not supplied by the model.
    expect(result.value.facts.stepCount).toBe(2);
  });

  it('discards a hallucinated finding and reports that it did so', async () => {
    const rejected: Finding[] = [];
    const result = await evaluateSession(record([step(0)]), {
      client: fakeClient({
        ...validPayload,
        findings: [
          { ...validPayload.findings[0], stepRefs: [0] },
          { ...validPayload.findings[0], title: 'Invented', stepRefs: [12, 13] },
        ],
      }),
      model: 'test-model',
      onRejectedFindings: (findings) => rejected.push(...findings),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toHaveLength(1);
    expect(result.value.findings[0]?.title).not.toBe('Invented');
    expect(rejected).toHaveLength(1);
  });

  it('rejects an evaluation with an attribution outside the allowed set', async () => {
    const result = await evaluateSession(record([step(0)]), {
      client: fakeClient({
        ...validPayload,
        findings: [{ ...validPayload.findings[0], attribution: 'CUSTOMER_FAULT' }],
      }),
      model: 'test-model',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('did not validate');
  });

  it('rejects a finding with no evidence cited at all', async () => {
    const result = await evaluateSession(record([step(0)]), {
      client: fakeClient({
        ...validPayload,
        findings: [{ ...validPayload.findings[0], stepRefs: [] }],
      }),
      model: 'test-model',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects malformed model output rather than salvaging it', async () => {
    for (const payload of [null, 'looks fine to me', { summary: 'no verdict' }, { goalAchieved: 'yes' }]) {
      const result = await evaluateSession(record([step(0)]), {
        client: fakeClient(payload),
        model: 'test-model',
      });
      expect(result.ok, JSON.stringify(payload)).toBe(false);
    }
  });

  it('accepts a clean run with no findings', async () => {
    const result = await evaluateSession(record([step(0)]), {
      client: fakeClient({ goalAchieved: true, summary: 'Nothing got in the way.', findings: [] }),
      model: 'test-model',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findings).toEqual([]);
  });
});

describe('transcript rendering', () => {
  it('gives the evaluator step numbers it can cite, and both sides of the gap', () => {
    const transcript = renderTranscript(record([step(0), step(1)]));
    expect(transcript).toContain('--- Step 0 ---');
    expect(transcript).toContain('--- Step 1 ---');
    expect(transcript).toContain('Expected to happen: something happens');
    // The customer's reasoning must be presented as a belief. Unlabelled, the
    // evaluator read two such guesses as product behaviour on a real run and
    // filed findings that were simply false.
    expect(transcript).toContain('Believed at the time (may be mistaken): because');
  });

  it('shows failures with their kind', () => {
    const transcript = renderTranscript(
      record([
        step(0, {
          result: {
            ok: false,
            error: { kind: 'ACTION_BLOCKED', message: 'would send a real invoice' },
            durationMs: 1,
            navigated: false,
          },
        }),
      ]),
    );
    expect(transcript).toContain('FAILED — ACTION_BLOCKED');
  });

  it('never leaks a secret value into the transcript', () => {
    const typed = ActionSchema.parse({
      action: 'type',
      ref: 'e2',
      value: { secret: 'PASSWORD' },
      ...common,
    });
    const transcript = renderTranscript(record([step(0, { action: typed })]));
    expect(transcript).toContain('<secret:PASSWORD>');
    expect(transcript).not.toContain('correct-horse');
  });
});

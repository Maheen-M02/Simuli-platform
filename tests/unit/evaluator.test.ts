import { describe, expect, it } from 'vitest';
import { evaluateSession, renderEvaluatorPrompt } from '../../src/evaluation/evaluator.ts';
import { computeFacts } from '../../src/evaluation/deterministic.ts';
import { deriveEvidence } from '../../src/evaluation/evidence.ts';
import { EvaluationSchema, FindingSchema } from '../../src/evaluation/schema.ts';
import { GOLDEN_SCENARIOS } from '../fixtures/golden/scenarios.ts';
import type { LlmClient } from '../../src/llm/client.ts';
import type { PolicyAction } from '../../src/evaluation/schema.ts';
import { ok } from '../../src/types/shared.ts';

/**
 * The evaluator end to end, with a fake client. No API call happens here.
 *
 * Each test pushes a specific kind of bad output through and checks that the
 * deterministic layers catch it. That is the only way to make "our findings are
 * trustworthy" a property of the code rather than a hope about the prompt.
 */

function record(id: string) {
  const scenario = GOLDEN_SCENARIOS.find((s) => s.id === id);
  if (scenario === undefined) throw new Error(`no golden scenario ${id}`);
  return scenario.record;
}

function fakeClient(payload: unknown): LlmClient {
  return {
    async completeJson() {
      return ok(payload);
    },
  };
}

const baseFinding = {
  finding: 'The product rejected a valid email address',
  classification: 'PRODUCT_ISSUE',
  severity: 'high',
  evidence: 'The message stayed on screen after a valid address was entered.',
  evidenceType: 'VALIDATION_MESSAGE',
  confidence: 'high',
  affectedPersona: 'Sam, a small business owner',
  supportingSteps: [2],
  evidenceRefs: [] as (string | undefined)[],
  alternativeExplanation: 'The message may simply have persisted from an earlier submission.',
  recommendation: 'Clear stale validation messages on re-render.',
};

function payload(findings: unknown[]) {
  return { goalAchieved: true, summary: 'A summary of the run.', findings };
}

async function evaluate(scenarioId: string, findings: unknown[]) {
  const actions: PolicyAction[] = [];
  const result = await evaluateSession(record(scenarioId), {
    client: fakeClient(payload(findings)),
    model: 'test-model',
    onPolicyActions: (a) => actions.push(...a),
  });
  return { result, actions };
}

describe('1. agent reasoning cannot be treated as evidence', () => {
  it('never shows the model a belief inside the observed-facts section', () => {
    const rec = record('persistent-validation-message');
    const prompt = renderEvaluatorPrompt(rec, deriveEvidence(rec));

    const factsSection = prompt.slice(prompt.indexOf('OBSERVED FACTS'), prompt.indexOf('AGENT BELIEFS'));
    expect(factsSection).not.toContain('rejects example.com');
    // It is present in the run, just quarantined below the fence.
    expect(prompt).toContain('rejects example.com');
  });

  it('demotes a product issue whose evidence type is the customer belief', async () => {
    const { result, actions } = await evaluate('persistent-validation-message', [
      { ...baseFinding, evidenceType: 'AGENT_BELIEF', evidenceRefs: ['f1'] },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings[0]?.classification).toBe('INCONCLUSIVE');
    expect(actions).toHaveLength(1);
  });

  it('rejects a belief id offered as an evidence ref', () => {
    // The schema will not even accept a `b`-prefixed id in evidenceRefs.
    expect(FindingSchema.safeParse({ ...baseFinding, evidenceRefs: ['b2'] }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...baseFinding, evidenceRefs: ['f2'] }).success).toBe(true);
  });
});

describe('2. unsupported product findings become INCONCLUSIVE', () => {
  it('demotes a product issue that cites no facts', async () => {
    const { result } = await evaluate('thin-evidence-giveup', [{ ...baseFinding, supportingSteps: [0] }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings[0]?.classification).toBe('INCONCLUSIVE');
  });

  it('records the demotion rather than applying it silently', async () => {
    const { result } = await evaluate('thin-evidence-giveup', [{ ...baseFinding, supportingSteps: [0] }]);
    if (!result.ok) return;
    expect(result.value.policyActions).toHaveLength(1);
    expect(result.value.policyActions[0]?.from).toBe('PRODUCT_ISSUE');
    expect(result.value.policyActions[0]?.to).toBe('INCONCLUSIVE');
  });
});

describe('3. observable browser evidence can support a product finding', () => {
  it('keeps a product finding built on a validation message the product showed', async () => {
    const rec = record('hidden-password-rule');
    const ledger = deriveEvidence(rec);
    const message = ledger.facts.find((f) => f.kind === 'VALIDATION_MESSAGE_SHOWN');
    expect(message).toBeDefined();

    const { result, actions } = await evaluate('hidden-password-rule', [
      {
        ...baseFinding,
        finding: 'The password rule is only revealed after a failed attempt',
        evidenceRefs: [message?.id],
        supportingSteps: [2],
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings[0]?.classification).toBe('PRODUCT_ISSUE');
    expect(result.value.findings[0]?.confidence).toBe('high');
    expect(actions).toHaveLength(0);
  });

  it('keeps a product finding built on what was present on the page', async () => {
    const rec = record('ambiguous-duplicate-labels');
    const ledger = deriveEvidence(rec);
    const present = ledger.facts.find((f) => f.kind === 'ELEMENT_PRESENT');

    const { result } = await evaluate('ambiguous-duplicate-labels', [
      {
        ...baseFinding,
        finding: 'Two different controls share the label "Continue"',
        evidenceType: 'PAGE_CONTENT',
        evidenceRefs: [present?.id],
        supportingSteps: [0],
      },
    ]);
    if (!result.ok) return;
    expect(result.value.findings[0]?.classification).toBe('PRODUCT_ISSUE');
  });
});

describe('4. agent misunderstanding is classified separately', () => {
  it('preserves an AGENT_MISUNDERSTANDING classification untouched', async () => {
    const rec = record('typed-into-dropdown');
    const ledger = deriveEvidence(rec);
    const present = ledger.facts.find((f) => f.kind === 'ELEMENT_PRESENT');

    const { result, actions } = await evaluate('typed-into-dropdown', [
      {
        ...baseFinding,
        finding: 'The customer typed into a dropdown instead of selecting from it',
        classification: 'AGENT_MISUNDERSTANDING',
        evidenceType: 'ACTION_RESULT',
        evidenceRefs: [present?.id],
        supportingSteps: [0],
      },
    ]);

    if (!result.ok) return;
    expect(result.value.findings[0]?.classification).toBe('AGENT_MISUNDERSTANDING');
    expect(actions).toHaveLength(0);
  });

  it('does not let an agent misunderstanding be counted as a product issue', async () => {
    const { result } = await evaluate('typed-into-dropdown', [
      { ...baseFinding, classification: 'AGENT_MISUNDERSTANDING', evidenceRefs: ['f1'] },
    ]);
    if (!result.ok) return;
    const products = result.value.findings.filter((f) => f.classification === 'PRODUCT_ISSUE');
    expect(products).toHaveLength(0);
  });
});

describe('5. environment and browser failures are classified separately', () => {
  it('reclassifies a product issue resting only on a browser crash', async () => {
    const rec = record('browser-crashed');
    const runtime = deriveEvidence(rec)
      .facts.filter((f) => f.kind === 'RUNTIME_FAILURE')
      .map((f) => f.id);

    const { result, actions } = await evaluate('browser-crashed', [
      { ...baseFinding, evidenceRefs: runtime, evidenceType: 'RUNTIME_FAILURE', supportingSteps: [0] },
    ]);

    if (!result.ok) return;
    expect(result.value.findings[0]?.classification).toBe('ENVIRONMENT_ERROR');
    expect(actions[0]?.reason).toContain('our own simulation');
  });

  it('reclassifies a product issue resting only on our destructive-action block', async () => {
    const rec = record('destructive-block');
    const blocked = deriveEvidence(rec)
      .facts.filter((f) => f.kind === 'DESTRUCTIVE_ACTION_BLOCKED')
      .map((f) => f.id);

    const { result } = await evaluate('destructive-block', [
      { ...baseFinding, evidenceRefs: blocked, supportingSteps: [0] },
    ]);
    if (!result.ok) return;
    expect(result.value.findings[0]?.classification).toBe('ENVIRONMENT_ERROR');
  });
});

describe('6. findings contain explicit evidence', () => {
  it('requires every evidence field, refusing a finding that omits one', () => {
    for (const field of [
      'finding',
      'classification',
      'severity',
      'evidence',
      'evidenceType',
      'confidence',
      'affectedPersona',
      'supportingSteps',
      'alternativeExplanation',
      'recommendation',
    ]) {
      const incomplete: Record<string, unknown> = { ...baseFinding };
      delete incomplete[field];
      expect(FindingSchema.safeParse(incomplete).success, `missing ${field}`).toBe(false);
    }
  });

  it('refuses an empty alternative explanation', () => {
    // A finding that has not considered the other reading has not been thought
    // about, and this is where most false positives would otherwise get through.
    expect(FindingSchema.safeParse({ ...baseFinding, alternativeExplanation: '' }).success).toBe(false);
  });

  it('refuses a finding citing no step at all', () => {
    expect(FindingSchema.safeParse({ ...baseFinding, supportingSteps: [] }).success).toBe(false);
  });
});

describe('7. evaluator output conforms to the Zod schema', () => {
  it('produces a schema-valid evaluation carrying our own computed facts', async () => {
    const rec = record('hidden-nav-label');
    const ledger = deriveEvidence(rec);
    const fact = ledger.facts[0];

    const result = await evaluateSession(rec, {
      client: fakeClient(payload([{ ...baseFinding, evidenceRefs: [fact?.id], supportingSteps: [0] }])),
      model: 'test-model',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(EvaluationSchema.safeParse(result.value).success).toBe(true);
    // The measurements are ours, not the model's.
    expect(result.value.facts).toEqual(computeFacts(rec));
    expect(result.value.sessionId).toBe(rec.id);
  });

  it('rejects a classification outside the allowed set', async () => {
    const { result } = await evaluate('clean-success', [
      { ...baseFinding, classification: 'CUSTOMER_FAULT' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('did not validate');
  });

  it('rejects an evidence type outside the allowed set', async () => {
    const { result } = await evaluate('clean-success', [{ ...baseFinding, evidenceType: 'VIBES' }]);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed model output rather than salvaging it', async () => {
    for (const bad of [null, 'looks fine', { summary: 'no verdict' }, { goalAchieved: 'yes' }]) {
      const result = await evaluateSession(record('clean-success'), {
        client: fakeClient(bad),
        model: 'test-model',
      });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts a clean run reported with no findings at all', async () => {
    const { result } = await evaluate('clean-success', []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.findings).toEqual([]);
      expect(result.value.policyActions).toEqual([]);
    }
  });
});

describe('the prompt tells the model the rules it will be held to', () => {
  it('shows computed measurements separately from the evidence ledger', () => {
    const rec = record('broken-submit');
    const prompt = renderEvaluatorPrompt(rec, deriveEvidence(rec));
    expect(prompt).toContain('COMPUTED MEASUREMENTS');
    expect(prompt).toContain('OBSERVED FACTS');
    expect(prompt.indexOf('COMPUTED MEASUREMENTS')).toBeLessThan(prompt.indexOf('OBSERVED FACTS'));
  });

  it('never leaks a secret value into the prompt', () => {
    const rec = record('missing-credential');
    const prompt = renderEvaluatorPrompt(rec, deriveEvidence(rec));
    expect(prompt).toContain('secret:PASSWORD');
    expect(prompt).not.toContain('correct-horse');
  });
});

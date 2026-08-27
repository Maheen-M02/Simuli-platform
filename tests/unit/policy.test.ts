import { describe, expect, it } from 'vitest';
import { applyEvidencePolicy } from '../../src/evaluation/policy.ts';
import { deriveEvidence, type EvidenceLedger } from '../../src/evaluation/evidence.ts';
import { FindingSchema, type Finding } from '../../src/evaluation/schema.ts';
import { GOLDEN_SCENARIOS } from '../fixtures/golden/scenarios.ts';

/**
 * The policy pass is enforcement, not advice. These tests are the reason we can
 * say a product finding is evidenced rather than hoping the prompt was obeyed.
 */

function ledgerFor(id: string): EvidenceLedger {
  const scenario = GOLDEN_SCENARIOS.find((s) => s.id === id);
  if (scenario === undefined) throw new Error(`no golden scenario ${id}`);
  return deriveEvidence(scenario.record);
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return FindingSchema.parse({
    finding: 'The dropdown could not be used',
    classification: 'PRODUCT_ISSUE',
    severity: 'high',
    evidence: 'The customer could not set a team size.',
    evidenceType: 'PAGE_CONTENT',
    confidence: 'high',
    affectedPersona: 'Sam, a small business owner',
    supportingSteps: [0],
    evidenceRefs: ['f1'],
    alternativeExplanation: 'The customer may have used the wrong control.',
    recommendation: 'Make the control clearer.',
    ...overrides,
  });
}

describe('a product finding must rest on observed facts', () => {
  it('demotes a product issue citing no facts at all to INCONCLUSIVE', () => {
    const result = applyEvidencePolicy([finding({ evidenceRefs: [] })], ledgerFor('clean-success'), 4);

    expect(result.findings[0]?.classification).toBe('INCONCLUSIVE');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.reason).toContain('no observed fact');
  });

  it('demotes a product issue whose evidence is the agent’s belief', () => {
    const result = applyEvidencePolicy(
      [finding({ evidenceType: 'AGENT_BELIEF' })],
      ledgerFor('persistent-validation-message'),
      5,
    );

    expect(result.findings[0]?.classification).toBe('INCONCLUSIVE');
    expect(result.actions[0]?.reason).toContain('interpretation');
  });

  it('drops a confidence rating that a demotion has invalidated', () => {
    const result = applyEvidencePolicy([finding({ evidenceRefs: [] })], ledgerFor('clean-success'), 4);
    expect(result.findings[0]?.confidence).toBe('low');
  });

  it('leaves a properly evidenced product finding alone', () => {
    const ledger = ledgerFor('hidden-password-rule');
    const messageFact = ledger.facts.find((f) => f.kind === 'VALIDATION_MESSAGE_SHOWN');
    expect(messageFact).toBeDefined();

    const result = applyEvidencePolicy(
      [
        finding({
          finding: 'The password rule is withheld until an attempt fails',
          evidenceType: 'VALIDATION_MESSAGE',
          evidenceRefs: [messageFact?.id ?? 'f1'],
          supportingSteps: [2],
        }),
      ],
      ledger,
      4,
    );

    expect(result.findings[0]?.classification).toBe('PRODUCT_ISSUE');
    expect(result.findings[0]?.confidence).toBe('high');
    expect(result.actions).toHaveLength(0);
  });
});

describe('our own failures cannot be sold as product issues', () => {
  it('reclassifies a product issue resting only on runtime failures', () => {
    const ledger = ledgerFor('browser-crashed');
    const runtime = ledger.facts.filter((f) => f.kind === 'RUNTIME_FAILURE').map((f) => f.id);
    expect(runtime.length).toBeGreaterThan(0);

    const result = applyEvidencePolicy(
      [finding({ evidenceRefs: runtime, evidenceType: 'RUNTIME_FAILURE' })],
      ledger,
      1,
    );

    expect(result.findings[0]?.classification).toBe('ENVIRONMENT_ERROR');
    expect(result.actions[0]?.reason).toContain('our own simulation');
  });

  it('reclassifies a product issue resting only on our destructive block', () => {
    const ledger = ledgerFor('destructive-block');
    const blocked = ledger.facts.filter((f) => f.kind === 'DESTRUCTIVE_ACTION_BLOCKED').map((f) => f.id);

    const result = applyEvidencePolicy([finding({ evidenceRefs: blocked })], ledger, 2);
    expect(result.findings[0]?.classification).toBe('ENVIRONMENT_ERROR');
  });

  it('does not reclassify when a real product fact is cited alongside ours', () => {
    // Mixed evidence is not automatically ours. Only wholly-ours evidence is.
    const ledger = ledgerFor('broken-submit');
    const message = ledger.facts.find((f) => f.kind === 'VALIDATION_MESSAGE_SHOWN');
    const page = ledger.facts.find((f) => f.kind === 'PAGE_VISITED');

    const result = applyEvidencePolicy(
      [finding({ evidenceRefs: [message?.id ?? 'f1', page?.id ?? 'f2'] })],
      ledger,
      5,
    );
    expect(result.findings[0]?.classification).toBe('PRODUCT_ISSUE');
  });
});

describe('hallucinated evidence is discarded', () => {
  it('drops a finding citing steps that never happened', () => {
    const result = applyEvidencePolicy([finding({ supportingSteps: [900, 901] })], ledgerFor('clean-success'), 4);
    expect(result.findings).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it('strips phantom step refs but keeps a finding with a real one left', () => {
    const ledger = ledgerFor('clean-success');
    const fact = ledger.facts[0];
    const result = applyEvidencePolicy(
      [finding({ supportingSteps: [1, 99], evidenceRefs: [fact?.id ?? 'f1'] })],
      ledger,
      4,
    );
    expect(result.findings[0]?.supportingSteps).toEqual([1]);
  });

  it('demotes a finding whose every evidence id is unknown', () => {
    const result = applyEvidencePolicy(
      [finding({ classification: 'AGENT_MISUNDERSTANDING', evidenceRefs: ['f9999'] })],
      ledgerFor('clean-success'),
      4,
    );
    expect(result.findings[0]?.classification).toBe('INCONCLUSIVE');
    expect(result.actions[0]?.reason).toContain('unknown');
  });
});

describe('the policy does not invent or inflate', () => {
  it('never promotes a finding to PRODUCT_ISSUE', () => {
    const ledger = ledgerFor('hidden-password-rule');
    const fact = ledger.facts.find((f) => f.kind === 'VALIDATION_MESSAGE_SHOWN');

    for (const classification of ['AGENT_MISUNDERSTANDING', 'ENVIRONMENT_ERROR', 'INCONCLUSIVE'] as const) {
      const result = applyEvidencePolicy(
        [finding({ classification, evidenceRefs: [fact?.id ?? 'f1'] })],
        ledger,
        4,
      );
      expect(result.findings[0]?.classification, classification).not.toBe('PRODUCT_ISSUE');
    }
  });

  it('records every intervention it makes, so overrides stay countable', () => {
    const result = applyEvidencePolicy(
      [finding({ evidenceRefs: [] }), finding({ evidenceType: 'AGENT_BELIEF' })],
      ledgerFor('clean-success'),
      4,
    );
    expect(result.actions).toHaveLength(2);
    for (const action of result.actions) {
      expect(action.from).toBe('PRODUCT_ISSUE');
      expect(action.to).toBe('INCONCLUSIVE');
      expect(action.reason.length).toBeGreaterThan(10);
    }
  });

  it('passes an empty finding list through untouched', () => {
    const result = applyEvidencePolicy([], ledgerFor('clean-success'), 4);
    expect(result.findings).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { isSameSite } from '../../src/browser/session.ts';
import { CustomerContextSchema, describeCustomerContext } from '../../src/personas/context.ts';
import { CustomerVerdictSchema, VERDICT_CAVEAT } from '../../src/evaluation/verdict.ts';
import { EvaluationSchema } from '../../src/evaluation/schema.ts';
import { renderVerdict } from '../../src/cli/render.ts';
import { DEFAULT_PERSONA, PersonaSchema } from '../../src/personas/schema.ts';
import { deriveEvidence } from '../../src/evaluation/evidence.ts';
import { GOLDEN_SCENARIOS } from '../fixtures/golden/scenarios.ts';
import type { StepRecord } from '../../src/sessions/types.ts';

/**
 * The pieces added for running against a real application.
 *
 * Two of these guard against a specific way real-world validation could quietly
 * mislead us: a page we truncated looking like a product that hides things, and
 * an experimental satisfaction score being read as a measurement.
 */

describe('same-site matching', () => {
  const start = 'https://app.acme.test/dashboard';

  it('permits the auth subdomain a real product will redirect to', () => {
    // The reason this exists: without it the login redirect is refused and the
    // agent reads our sandbox boundary as a dead end in the product.
    for (const url of [
      'https://auth.acme.test/login',
      'https://accounts.acme.test/sso',
      'https://app.acme.test/settings',
      'https://acme.test/',
    ]) {
      expect(isSameSite(start, url), url).toBe(true);
    }
  });

  it('still refuses an unrelated site', () => {
    for (const url of [
      'https://payco.test/checkout',
      'https://acme.test.evil.test/',
      'https://notacme.test/',
      'https://acme.other/',
    ]) {
      expect(isSameSite(start, url), url).toBe(false);
    }
  });

  it('refuses a non-http scheme even on the same host', () => {
    expect(isSameSite(start, 'javascript:alert(1)')).toBe(false);
    expect(isSameSite(start, 'file:///etc/passwd')).toBe(false);
  });

  it('handles a malformed url without throwing', () => {
    expect(isSameSite(start, 'not a url')).toBe(false);
    expect(isSameSite('not a url', 'https://acme.test/')).toBe(false);
  });
});

describe('customer context', () => {
  const full = CustomerContextSchema.parse({
    persona: PersonaSchema.parse({ name: 'Priya', background: 'Ops lead at a logistics firm' }),
    background: 'Her team is outgrowing spreadsheets and she has budget approval this quarter.',
    motivation: 'Needs to pick a tool before the quarter closes.',
    expectations: ['a free trial without a card', 'import from CSV'],
    constraints: ['cannot enter real payment details', 'no admin rights on her laptop'],
  });

  it('accepts the five documented fields', () => {
    expect(full.persona.name).toBe('Priya');
    expect(full.expectations).toHaveLength(2);
    expect(full.constraints).toHaveLength(2);
  });

  it('needs nothing but a persona, so a thin run is still runnable', () => {
    const minimal = CustomerContextSchema.parse({ persona: DEFAULT_PERSONA });
    expect(minimal.expectations).toEqual([]);
    expect(minimal.motivation).toBe('');
  });

  it('rejects an unknown field rather than ignoring it', () => {
    expect(
      CustomerContextSchema.safeParse({ persona: DEFAULT_PERSONA, mood: 'grumpy' }).success,
    ).toBe(false);
  });

  it('puts everything the customer arrived with into the prompt', () => {
    const described = describeCustomerContext(full);
    expect(described).toContain('Priya');
    expect(described).toContain('outgrowing spreadsheets');
    expect(described).toContain('before the quarter closes');
    expect(described).toContain('a free trial without a card');
    expect(described).toContain('no admin rights');
  });

  it('tells the agent to notice a broken expectation rather than adapt to it', () => {
    // Otherwise the agent quietly works around exactly the friction we sell.
    expect(describeCustomerContext(full)).toContain('notice it rather than adapting silently');
  });

  it('omits empty sections instead of showing blank headings', () => {
    const described = describeCustomerContext(CustomerContextSchema.parse({ persona: DEFAULT_PERSONA }));
    expect(described).not.toContain('What you are expecting');
    expect(described).not.toContain('Your situation');
  });
});

describe('customer verdict', () => {
  const verdict = CustomerVerdictSchema.parse({
    satisfactionScore: 2,
    satisfactionReason: 'Got there, but had to guess twice.',
    wouldUseAgain: false,
    wouldUseAgainReason: 'Would try a competitor first.',
    wouldPay: 'NOT_APPLICABLE',
    wouldPayReason: 'Never saw pricing.',
    confidence: 'low',
  });

  it('bounds the score to the documented scale', () => {
    for (const score of [0, 6, -1, 2.5]) {
      expect(CustomerVerdictSchema.safeParse({ ...verdict, satisfactionScore: score }).success).toBe(false);
    }
    expect(CustomerVerdictSchema.safeParse({ ...verdict, satisfactionScore: 5 }).success).toBe(true);
  });

  it('allows would-pay to be not applicable, which is the usual honest answer', () => {
    expect(verdict.wouldPay).toBe('NOT_APPLICABLE');
    expect(CustomerVerdictSchema.safeParse({ ...verdict, wouldPay: 'MAYBE' }).success).toBe(false);
  });

  it('requires a reason for every judgment', () => {
    for (const field of ['satisfactionReason', 'wouldUseAgainReason', 'wouldPayReason']) {
      expect(CustomerVerdictSchema.safeParse({ ...verdict, [field]: '' }).success, field).toBe(false);
    }
  });

  it('prints the caveat next to the number, not in a footnote', () => {
    // A score that travels without this line is the thing that ends up in a deck.
    const rendered = renderVerdict({
      sessionId: 's',
      goalAchieved: false,
      summary: 'x',
      findings: [],
      policyActions: [],
      customerVerdict: verdict,
      facts: {
        stepCount: 1,
        durationMs: 1,
        actionsAttempted: 1,
        actionsFailed: 0,
        plannerFailures: 0,
        errorsByKind: {},
        distinctUrls: 1,
        revisitedUrls: [],
        destructiveActionsBlocked: 0,
        runIsTechnicallySound: true,
      },
    });

    expect(rendered).toContain('2/5');
    expect(rendered).toContain('not applicable');
    expect(rendered).toContain(VERDICT_CAVEAT);
    expect(VERDICT_CAVEAT).toContain('not a prediction of real customer');
  });

  it('says a verdict is missing rather than showing a neutral one', () => {
    const rendered = renderVerdict({
      sessionId: 's',
      goalAchieved: false,
      summary: 'x',
      findings: [],
      policyActions: [],
      customerVerdict: null,
      facts: {
        stepCount: 0,
        durationMs: 0,
        actionsAttempted: 0,
        actionsFailed: 0,
        plannerFailures: 0,
        errorsByKind: {},
        distinctUrls: 0,
        revisitedUrls: [],
        destructiveActionsBlocked: 0,
        runIsTechnicallySound: true,
      },
    });
    expect(rendered).toContain('Not produced');
    expect(rendered).not.toContain('/5');
  });

  it('is nullable on the evaluation, so a failed run still validates', () => {
    const base = {
      sessionId: 's',
      goalAchieved: false,
      summary: 'x',
      findings: [],
      policyActions: [],
      facts: {
        stepCount: 0,
        durationMs: 0,
        actionsAttempted: 0,
        actionsFailed: 0,
        plannerFailures: 0,
        errorsByKind: {},
        distinctUrls: 0,
        revisitedUrls: [],
        destructiveActionsBlocked: 0,
        runIsTechnicallySound: true,
      },
    };
    expect(EvaluationSchema.safeParse({ ...base, customerVerdict: null }).success).toBe(true);
    expect(EvaluationSchema.safeParse({ ...base, customerVerdict: verdict }).success).toBe(true);
  });
});

describe('a page we truncated is not the product hiding things', () => {
  /** Borrows a golden record and marks one observation as truncated. */
  function withTruncation(): { steps: StepRecord[] } {
    const scenario = GOLDEN_SCENARIOS.find((s) => s.id === 'hidden-nav-label');
    if (scenario === undefined) throw new Error('missing scenario');
    const steps = scenario.record.steps.map((step, index) =>
      index === 0
        ? {
            ...step,
            observation: {
              ...step.observation,
              text: `${step.observation.text}\n\n(37 further elements were omitted; this page is very large.)`,
            },
          }
        : step,
    );
    return { steps };
  }

  it('emits an explicit fact when the snapshot budget hid part of the page', () => {
    const scenario = GOLDEN_SCENARIOS.find((s) => s.id === 'hidden-nav-label');
    if (scenario === undefined) throw new Error('missing scenario');

    const ledger = deriveEvidence({ ...scenario.record, ...withTruncation() });
    const truncated = ledger.facts.filter((f) => f.kind === 'OBSERVATION_TRUNCATED');

    expect(truncated).toHaveLength(1);
    expect(truncated[0]?.statement).toContain('37 element(s) were never shown');
    // The point of the fact: it says whose fault a missing feature might be.
    expect(truncated[0]?.statement).toContain('hidden by us rather than by the product');
  });

  it('counts truncation as our fault, so a product claim resting on it is demoted', async () => {
    const { OUR_FAULT_FACT_KINDS } = await import('../../src/evaluation/evidence.ts');
    expect(OUR_FAULT_FACT_KINDS.has('OBSERVATION_TRUNCATED')).toBe(true);
  });

  it('emits nothing when the whole page fitted', () => {
    const scenario = GOLDEN_SCENARIOS.find((s) => s.id === 'clean-success');
    if (scenario === undefined) throw new Error('missing scenario');
    const ledger = deriveEvidence(scenario.record);
    expect(ledger.facts.some((f) => f.kind === 'OBSERVATION_TRUNCATED')).toBe(false);
  });
});

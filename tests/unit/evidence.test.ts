import { describe, expect, it } from 'vitest';
import { deriveEvidence, renderEvidence } from '../../src/evaluation/evidence.ts';
import { GOLDEN_SCENARIOS } from '../fixtures/golden/scenarios.ts';

/**
 * The evidence ledger is the foundation the whole trust argument stands on: if a
 * belief can leak into the fact list, every downstream check is decoration.
 */

function scenario(id: string) {
  const found = GOLDEN_SCENARIOS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no golden scenario ${id}`);
  return found;
}

describe('facts and beliefs are separated', () => {
  it('puts the agent’s reasoning in beliefs, never in facts', () => {
    const ledger = deriveEvidence(scenario('persistent-validation-message').record);

    // The agent's wrong guess is recorded...
    const beliefText = ledger.beliefs.map((b) => b.reasoning).join(' ');
    expect(beliefText).toContain('rejects example.com');

    // ...and appears nowhere in the fact list.
    const factText = ledger.facts.map((f) => f.statement).join(' ');
    expect(factText).not.toContain('rejects example.com');
    expect(factText).not.toContain('still thinks the email is invalid');
  });

  it('gives facts and beliefs non-interchangeable id spaces', () => {
    const ledger = deriveEvidence(scenario('persistent-validation-message').record);
    expect(ledger.facts.every((f) => /^f\d+$/.test(f.id))).toBe(true);
    expect(ledger.beliefs.every((b) => /^b\d+$/.test(b.id))).toBe(true);
  });

  it('tells the model plainly that beliefs are not evidence', () => {
    const rendered = renderEvidence(deriveEvidence(scenario('persistent-validation-message').record));
    expect(rendered).toContain('OBSERVED FACTS');
    expect(rendered).toContain('AGENT BELIEFS — NOT EVIDENCE');
    expect(rendered).toContain('never be cited');
  });
});

describe('observable evidence is derived faithfully', () => {
  it('records a validation message the product showed', () => {
    const ledger = deriveEvidence(scenario('hidden-password-rule').record);
    const messages = ledger.facts.filter((f) => f.kind === 'VALIDATION_MESSAGE_SHOWN');
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.map((f) => f.statement).join(' ')).toContain('at least 12 characters');
  });

  it('records navigation and URL change', () => {
    const ledger = deriveEvidence(scenario('clean-success').record);
    expect(ledger.facts.some((f) => f.kind === 'NAVIGATION_OCCURRED')).toBe(true);
    expect(ledger.facts.some((f) => f.kind === 'URL_CHANGED')).toBe(true);
  });

  it('records which elements were available', () => {
    const ledger = deriveEvidence(scenario('gave-up-with-path-open').record);
    const present = ledger.facts.filter((f) => f.kind === 'ELEMENT_PRESENT');
    // The link the agent claimed did not exist is in the facts.
    expect(present.map((f) => f.statement).join(' ')).toContain('Download PDF');
  });

  it('marks a persisting message as persisting, not as a fresh rejection', () => {
    const ledger = deriveEvidence(scenario('persistent-validation-message').record);
    const persisted = ledger.facts.filter((f) => f.kind === 'MESSAGE_PERSISTED_UNCHANGED');
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted[0]?.statement).toContain('was not raised again');
  });

  it('notes an unchanged page', () => {
    const ledger = deriveEvidence(scenario('typed-into-dropdown').record);
    expect(ledger.facts.some((f) => f.kind === 'PAGE_UNCHANGED')).toBe(true);
  });
});

describe('our own failures are labelled as ours', () => {
  it('classifies a browser crash as a runtime failure', () => {
    const ledger = deriveEvidence(scenario('browser-crashed').record);
    const runtime = ledger.facts.filter((f) => f.kind === 'RUNTIME_FAILURE');
    expect(runtime.length).toBeGreaterThan(0);
    expect(runtime[0]?.statement).toContain('not evidence about the product');
  });

  it('classifies a missing credential and a blocked navigation as ours', () => {
    for (const id of ['missing-credential', 'navigation-blocked']) {
      const ledger = deriveEvidence(scenario(id).record);
      expect(ledger.facts.some((f) => f.kind === 'RUNTIME_FAILURE'), id).toBe(true);
      // And never as a product-side action failure.
      expect(ledger.facts.some((f) => f.kind === 'ACTION_FAILED'), id).toBe(false);
    }
  });

  it('keeps our destructive-action refusal distinct from a product failure', () => {
    const ledger = deriveEvidence(scenario('destructive-block').record);
    expect(ledger.facts.some((f) => f.kind === 'DESTRUCTIVE_ACTION_BLOCKED')).toBe(true);
    expect(ledger.facts.some((f) => f.kind === 'ACTION_FAILED')).toBe(false);
  });

  it('records a planner failure and no action facts', () => {
    const ledger = deriveEvidence(scenario('planner-failed').record);
    expect(ledger.facts.filter((f) => f.kind === 'PLANNER_FAILURE')).toHaveLength(3);
    expect(ledger.facts.some((f) => f.kind === 'ACTION_SUCCEEDED')).toBe(false);
    expect(ledger.beliefs).toHaveLength(0);
  });

  it('treats a genuine product-side failure as product-side', () => {
    // A 500 page is the product failing, so it must NOT be a runtime failure.
    const ledger = deriveEvidence(scenario('broken-submit').record);
    const messages = ledger.facts.filter((f) => f.kind === 'VALIDATION_MESSAGE_SHOWN');
    expect(messages.map((f) => f.statement).join(' ')).toContain('Error 500');
    expect(ledger.facts.some((f) => f.kind === 'RUNTIME_FAILURE')).toBe(false);
  });
});

describe('the ledger never leaks a secret', () => {
  it('does not record a secret value, only its name', () => {
    const ledger = deriveEvidence(scenario('missing-credential').record);
    const all = JSON.stringify(ledger);
    expect(all).toContain('secret:PASSWORD');
    expect(all).not.toContain('correct-horse');
  });
});

describe('every golden scenario produces a usable ledger', () => {
  it('derives at least one fact per scenario, deterministically', () => {
    for (const s of GOLDEN_SCENARIOS) {
      const first = deriveEvidence(s.record);
      const second = deriveEvidence(s.record);
      expect(first.facts.length, s.id).toBeGreaterThan(0);
      // Same record twice must give byte-identical evidence, or the metric
      // moves for reasons that have nothing to do with the evaluator.
      expect(JSON.stringify(second), s.id).toBe(JSON.stringify(first));
    }
  });
});

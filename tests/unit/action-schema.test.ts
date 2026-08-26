import { describe, expect, it } from 'vitest';
import {
  ActionSchema,
  actionSignature,
  describeAction,
  isTerminalAction,
  type Action,
} from '../../src/actions/schema.ts';

/**
 * This schema is the boundary between "text a model produced" and "something
 * that touches a real browser". The adversarial block below is the point of
 * this file: each case is a way a model could try to reach past the boundary.
 */

const common = { reasoning: 'because', expectation: 'the page will do a thing' };

function parse(input: unknown) {
  return ActionSchema.safeParse(input);
}

describe('action schema — valid output', () => {
  it('accepts a click on a snapshot ref', () => {
    const result = parse({ action: 'click', ref: 'e14', ...common });
    expect(result.success).toBe(true);
  });

  it('accepts typing a literal value and defaults submit to false', () => {
    const result = parse({ action: 'type', ref: 'e2', value: 'founder@acme.test', ...common });
    expect(result.success).toBe(true);
    if (result.success && result.data.action === 'type') {
      expect(result.data.submit).toBe(false);
    }
  });

  it('accepts a secret reference in place of a literal value', () => {
    const result = parse({ action: 'type', ref: 'e3', value: { secret: 'PASSWORD' }, ...common });
    expect(result.success).toBe(true);
    if (result.success && result.data.action === 'type') {
      expect(result.data.value).toEqual({ secret: 'PASSWORD' });
    }
  });

  it('defaults scroll amount to a page', () => {
    const result = parse({ action: 'scroll', direction: 'down', ...common });
    expect(result.success).toBe(true);
    if (result.success && result.data.action === 'scroll') {
      expect(result.data.amount).toBe('page');
    }
  });

  it('accepts every remaining action shape', () => {
    const cases: unknown[] = [
      { action: 'select', ref: 'e9', value: '2-10', ...common },
      { action: 'press_key', key: 'Enter', ...common },
      { action: 'go_back', ...common },
      { action: 'wait', ms: 1000, ...common },
      { action: 'finish', goalAchieved: true, evidence: 'Invoice INV-0001 shows as sent', ...common },
      { action: 'fail', reason: 'Signup needs a confirmation email', blocker: 'REQUIRES_VERIFICATION', ...common },
    ];
    for (const input of cases) {
      expect(parse(input).success, JSON.stringify(input)).toBe(true);
    }
  });
});

describe('action schema — invalid output', () => {
  it('rejects an unknown action name', () => {
    expect(parse({ action: 'navigate', url: 'https://evil.test', ...common }).success).toBe(false);
  });

  it('rejects a missing reasoning or expectation', () => {
    expect(parse({ action: 'click', ref: 'e1', expectation: 'x' }).success).toBe(false);
    expect(parse({ action: 'click', ref: 'e1', reasoning: 'x' }).success).toBe(false);
  });

  it('rejects empty reasoning or expectation', () => {
    expect(parse({ action: 'click', ref: 'e1', reasoning: '', expectation: 'x' }).success).toBe(false);
    expect(parse({ action: 'click', ref: 'e1', reasoning: 'x', expectation: '' }).success).toBe(false);
  });

  it('rejects a wait outside its bounds', () => {
    expect(parse({ action: 'wait', ms: 50, ...common }).success).toBe(false);
    expect(parse({ action: 'wait', ms: 60_000, ...common }).success).toBe(false);
    expect(parse({ action: 'wait', ms: 1500.5, ...common }).success).toBe(false);
  });

  it('rejects a key outside the pressable enum', () => {
    expect(parse({ action: 'press_key', key: 'F12', ...common }).success).toBe(false);
    expect(parse({ action: 'press_key', key: 'Control+A', ...common }).success).toBe(false);
  });

  it('rejects a scroll in an unsupported direction', () => {
    expect(parse({ action: 'scroll', direction: 'left', ...common }).success).toBe(false);
  });

  it('rejects a finish with no evidence', () => {
    expect(parse({ action: 'finish', goalAchieved: true, evidence: '', ...common }).success).toBe(false);
  });

  it('rejects a fail with a blocker outside the enum', () => {
    expect(parse({ action: 'fail', reason: 'r', blocker: 'BORED', ...common }).success).toBe(false);
  });

  it('rejects non-object input entirely', () => {
    for (const input of [null, undefined, 'click e1', 42, [], true]) {
      expect(parse(input).success).toBe(false);
    }
  });
});

describe('action schema — adversarial model output', () => {
  it('refuses a CSS selector where a ref belongs', () => {
    for (const ref of ['button.submit', '#login', 'body > div:nth-child(2)', '//button[1]', 'text=Send']) {
      expect(parse({ action: 'click', ref, ...common }).success, ref).toBe(false);
    }
  });

  it('refuses ref shapes that are close to valid but not minted by us', () => {
    for (const ref of ['e', 'E14', 'e14 ', ' e14', 'e14a', 'e-1', 'e1.5', 'e١٤']) {
      expect(parse({ action: 'click', ref, ...common }).success, JSON.stringify(ref)).toBe(false);
    }
  });

  it('refuses smuggled extra fields rather than silently dropping them', () => {
    const result = parse({
      action: 'click',
      ref: 'e1',
      selector: 'button.pay-now',
      script: 'fetch("https://evil.test")',
      ...common,
    });
    expect(result.success).toBe(false);
  });

  it('refuses a secret reference that is not a plain name', () => {
    for (const secret of ['password', 'PASS WORD', 'PASSWORD;DROP', '../../.env', '', 'A'.repeat(80)]) {
      expect(
        parse({ action: 'type', ref: 'e1', value: { secret }, ...common }).success,
        JSON.stringify(secret),
      ).toBe(false);
    }
  });

  it('refuses a secret object carrying anything beyond the name', () => {
    const result = parse({
      action: 'type',
      ref: 'e1',
      value: { secret: 'PASSWORD', fallback: 'hunter2' },
      ...common,
    });
    expect(result.success).toBe(false);
  });

  it('refuses an unbounded typed value', () => {
    expect(parse({ action: 'type', ref: 'e1', value: 'x'.repeat(5000), ...common }).success).toBe(false);
  });

  it('refuses a prototype-pollution payload', () => {
    const input = JSON.parse(
      '{"action":"click","ref":"e1","reasoning":"r","expectation":"e","__proto__":{"polluted":true}}',
    ) as unknown;
    // Whether or not the key survives JSON.parse, nothing may reach Object.prototype.
    parse(input);
    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('keeps a discriminated union tight: fields from one variant do not satisfy another', () => {
    expect(parse({ action: 'click', ref: 'e1', value: 'hello', ...common }).success).toBe(false);
    expect(parse({ action: 'go_back', ref: 'e1', ...common }).success).toBe(false);
  });
});

describe('action helpers', () => {
  it('never puts a secret value in a description, only its name', () => {
    const action = ActionSchema.parse({
      action: 'type',
      ref: 'e3',
      value: { secret: 'PASSWORD' },
      ...common,
    });
    const description = describeAction(action);
    expect(description).toContain('PASSWORD');
    expect(description).toContain('<secret:');
  });

  it('treats only finish and fail as terminal', () => {
    const terminal: Action[] = [
      ActionSchema.parse({ action: 'finish', goalAchieved: false, evidence: 'e', ...common }),
      ActionSchema.parse({ action: 'fail', reason: 'r', blocker: 'CANNOT_FIND_PATH', ...common }),
    ];
    for (const action of terminal) expect(isTerminalAction(action)).toBe(true);
    expect(isTerminalAction(ActionSchema.parse({ action: 'click', ref: 'e1', ...common }))).toBe(false);
  });

  it('gives the same signature to the same move under different justifications', () => {
    const a = ActionSchema.parse({ action: 'click', ref: 'e7', reasoning: 'first try', expectation: 'x' });
    const b = ActionSchema.parse({ action: 'click', ref: 'e7', reasoning: 'maybe now', expectation: 'y' });
    expect(actionSignature(a)).toBe(actionSignature(b));
  });

  it('distinguishes moves that differ in their target or payload', () => {
    const a = ActionSchema.parse({ action: 'click', ref: 'e7', ...common });
    const b = ActionSchema.parse({ action: 'click', ref: 'e8', ...common });
    expect(actionSignature(a)).not.toBe(actionSignature(b));
  });
});

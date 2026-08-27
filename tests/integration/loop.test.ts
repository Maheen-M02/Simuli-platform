import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/server.ts';
import { startSession, type BrowserSession } from '../../src/browser/session.ts';
import { runLoop } from '../../src/agent/loop.ts';
import type { Planner, PlannerInput } from '../../src/agent/planner.ts';
import { openDb, type Db } from '../../src/persistence/db.ts';
import { createRecorder } from '../../src/sessions/recorder.ts';
import { DEFAULT_PERSONA } from '../../src/personas/schema.ts';
import { CustomerContextSchema } from '../../src/personas/context.ts';
import { GoalSchema } from '../../src/goals/schema.ts';
import { ActionSchema } from '../../src/actions/schema.ts';
import { createRedactor } from '../../src/observations/redact.ts';
import { silentLogger } from '../../src/logging/logger.ts';
import { ok, err, type Result } from '../../src/types/shared.ts';
import type { Action } from '../../src/actions/schema.ts';
import type { Limits } from '../../src/agent/termination.ts';

/** Same persona as before, now inside the context envelope. */
const CONTEXT = CustomerContextSchema.parse({ persona: DEFAULT_PERSONA });


/**
 * The loop, end to end, with an injected fake planner.
 *
 * No OpenAI call happens here. The planner is scripted, so every assertion is
 * about our machinery — termination, recording, mediation between observing and
 * acting — and never about whether a model made a good choice. A suite that
 * depended on model judgment would fail for reasons no code change could fix.
 */

let site: FixtureSite;
let session: BrowserSession;
let db: Db;
let runCounter = 0;

const SECRETS = new Map([['PASSWORD', 'correct-horse-9']]);
const goal = GoalSchema.parse({ description: 'Create an invoice' });
const common = { reasoning: 'r', expectation: 'e' };

const limits: Limits = {
  maxSteps: 12,
  wallClockMs: 60_000,
  maxNoChangeSteps: 3,
  maxRepeatedActions: 3,
  maxConsecutiveErrors: 3,
};

/** Plays a fixed list of actions, then repeats the last one forever. */
function scriptedPlanner(script: readonly unknown[]): Planner {
  let index = 0;
  return async () => {
    const raw = script[Math.min(index, script.length - 1)];
    index += 1;
    return ok(ActionSchema.parse(raw)) as Result<Action, string>;
  };
}

/** Chooses an action by looking at what the page offers, like a tiny agent. */
function reactivePlanner(
  choose: (input: PlannerInput) => unknown | null,
): Planner {
  return async (input) => {
    const chosen = choose(input);
    if (chosen === null) {
      return err('Nothing sensible to do on this page.') as Result<Action, string>;
    }
    return ok(ActionSchema.parse(chosen)) as Result<Action, string>;
  };
}

async function drive(planner: Planner, startPath = '/', overrides: Partial<Limits> = {}) {
  runCounter += 1;
  const sessionId = `run-${runCounter}`;
  await session.context.clearCookies();
  await session.page.goto(`${site.url}${startPath}`);

  const recorder = createRecorder({
    sessionId,
    startUrl: `${site.url}${startPath}`,
    context: CONTEXT,
    goal,
    plannerModel: 'scripted-fake',
    db,
  });

  const record = await runLoop({
    session,
    planner,
    recorder,
    context: CONTEXT,
    goal,
    secrets: SECRETS,
    redact: createRedactor(SECRETS),
    logger: silentLogger(),
    limits: { ...limits, ...overrides },
  });

  return { record, sessionId };
}

/** Finds a ref in the current observation by role and name. */
function ref(input: PlannerInput, role: string, name: string): string | null {
  const node = input.observation.snapshot.nodes.find((n) => n.role === role && n.name === name);
  return node?.ref ?? null;
}

beforeAll(async () => {
  site = await startFixtureSite();
  session = await startSession(site.url, { headless: true, allowedOrigins: [] });
  db = openDb(':memory:');
}, 120_000);

afterAll(async () => {
  await session?.close();
  await site?.close();
  db?.close();
});

beforeEach(async () => {
  await session.context.clearCookies();
});

describe('the loop reaches an explicit outcome', () => {
  it('SUCCESS when the agent finishes having achieved the goal', async () => {
    const { record } = await drive(
      scriptedPlanner([
        { action: 'finish', goalAchieved: true, evidence: 'The pricing page lists a free plan', ...common },
      ]),
      '/pricing',
    );

    expect(record.outcome).toBe('SUCCESS');
    expect(record.terminationReason).toBe('AGENT_FINISHED');
    expect(record.agentSummary).toContain('free plan');
    expect(record.endedAt).not.toBeNull();
  });

  it('FAILURE when the agent finishes without achieving the goal', async () => {
    const { record } = await drive(
      scriptedPlanner([
        { action: 'finish', goalAchieved: false, evidence: 'I could not find invoices anywhere', ...common },
      ]),
    );
    expect(record.outcome).toBe('FAILURE');
    expect(record.terminationReason).toBe('AGENT_FINISHED');
  });

  it('FAILURE when the agent gives up against a real blocker', async () => {
    const { record } = await drive(
      scriptedPlanner([
        { action: 'fail', reason: 'Signup wants a code from my email', blocker: 'REQUIRES_VERIFICATION', ...common },
      ]),
    );
    expect(record.outcome).toBe('FAILURE');
    expect(record.terminationReason).toBe('AGENT_FAILED');
    expect(record.agentSummary).toContain('code from my email');
  });

  it('STUCK when the same move is repeated against an unmoving page', async () => {
    const { record } = await drive(
      reactivePlanner((input) => {
        const target = ref(input, 'link', 'Pricing');
        return target === null ? null : { action: 'click', ref: target, ...common };
      }),
      '/pricing',
    );

    expect(record.outcome).toBe('STUCK');
    expect(['REPEATED_ACTION_LOOP', 'NO_CHANGE_LOOP']).toContain(record.terminationReason);
  }, 60_000);

  it('TIMEOUT when the agent runs out of steps', async () => {
    // Scrolling always succeeds and always changes nothing structural, so
    // neither loop detector fires and the step limit is what stops it.
    let down = true;
    const { record } = await drive(
      reactivePlanner(() => {
        down = !down;
        return { action: 'scroll', direction: down ? 'down' : 'up', ...common };
      }),
      '/pricing',
      { maxSteps: 5, maxNoChangeSteps: 99, maxRepeatedActions: 99 },
    );

    expect(record.outcome).toBe('TIMEOUT');
    expect(record.terminationReason).toBe('MAX_STEPS');
    expect(record.steps.length).toBe(5);
  }, 60_000);

  it('TIMEOUT when the wall clock runs out', async () => {
    const { record } = await drive(
      scriptedPlanner([{ action: 'wait', ms: 200, ...common }]),
      '/pricing',
      { wallClockMs: 1, maxSteps: 99 },
    );
    expect(record.outcome).toBe('TIMEOUT');
    expect(record.terminationReason).toBe('WALL_CLOCK');
  });

  it('ERROR when actions keep failing', async () => {
    const { record } = await drive(
      scriptedPlanner([{ action: 'click', ref: 'e999', ...common }]),
      '/pricing',
    );
    expect(record.outcome).toBe('ERROR');
    expect(record.terminationReason).toBe('CONSECUTIVE_ERRORS');
    expect(record.steps.every((step) => step.result?.ok === false)).toBe(true);
  }, 60_000);

  it('ERROR when the planner cannot produce anything usable', async () => {
    const { record } = await drive(
      reactivePlanner(() => null),
      '/pricing',
    );
    expect(record.outcome).toBe('ERROR');
    expect(record.terminationReason).toBe('CONSECUTIVE_ERRORS');
    expect(record.steps.every((step) => step.action === null)).toBe(true);
    expect(record.steps[0]?.plannerError).toContain('Nothing sensible');
  }, 60_000);
});

describe('the loop drives a real flow', () => {
  it('completes signup -> onboarding -> invoice and records every step', async () => {
    const { record, sessionId } = await drive(
      reactivePlanner((input) => {
        const has = (role: string, name: string) => ref(input, role, name);
        const url = input.observation.snapshot.url;

        const start = has('link', 'Get started free');
        if (start !== null) return { action: 'click', ref: start, ...common };

        if (url.includes('/signup')) {
          const email = has('textbox', 'Work email');
          if (email !== null && input.observation.snapshot.nodes.find((n) => n.role === 'textbox' && n.name === 'Work email')?.value === '') {
            return { action: 'type', ref: email, value: 'loop@acme.test', ...common };
          }
          const password = has('password', 'Password');
          if (password !== null) {
            return { action: 'type', ref: password, value: { secret: 'PASSWORD' }, submit: true, ...common };
          }
        }

        const company = has('textbox', 'Company name');
        if (company !== null) {
          const filled = input.observation.snapshot.nodes.find((n) => n.name === 'Company name')?.value;
          if (filled === '') return { action: 'type', ref: company, value: 'Loop Ltd', ...common };
          const cont = has('button', 'Continue');
          if (cont !== null) return { action: 'click', ref: cont, ...common };
        }

        const team = has('combobox', 'Team size');
        if (team !== null) {
          const chosen = input.observation.snapshot.nodes.find((n) => n.role === 'combobox')?.value;
          if (chosen === 'Choose an option') return { action: 'select', ref: team, value: '2-10', ...common };
          const finishSetup = has('button', 'Finish setup');
          if (finishSetup !== null) return { action: 'click', ref: finishSetup, ...common };
        }

        const billing = has('link', 'Go to Billing');
        if (billing !== null) return { action: 'click', ref: billing, ...common };

        const newInvoice = has('link', 'New invoice');
        if (newInvoice !== null) return { action: 'click', ref: newInvoice, ...common };

        if (url.includes('/billing/new')) {
          const client = has('textbox', 'Client name');
          if (client !== null && input.observation.snapshot.nodes.find((n) => n.name === 'Client name')?.value === '') {
            return { action: 'type', ref: client, value: 'Globex', ...common };
          }
          const amount = has('textbox', 'Amount');
          if (amount !== null && input.observation.snapshot.nodes.find((n) => n.name === 'Amount')?.value === '') {
            return { action: 'type', ref: amount, value: '1250.00', ...common };
          }
          const create = has('button', 'Create invoice');
          if (create !== null) return { action: 'click', ref: create, ...common };
        }

        if (/\/billing\/INV-\d{4}$/.test(url)) {
          return {
            action: 'finish',
            goalAchieved: true,
            evidence: `Invoice created and shown at ${url}`,
            ...common,
          };
        }

        return null;
      }),
      '/',
      { maxSteps: 20 },
    );

    expect(record.outcome).toBe('SUCCESS');
    expect(record.agentSummary).toContain('INV-');

    // Every step carries what was seen and what was decided.
    for (const step of record.steps) {
      expect(step.observation.text.length).toBeGreaterThan(0);
      expect(step.observation.url.length).toBeGreaterThan(0);
    }

    // Reasoning and expectation survive to the record: the evaluator needs both.
    const acted = record.steps.filter((step) => step.action !== null);
    expect(acted.length).toBeGreaterThan(5);
    for (const step of acted) {
      expect(step.action?.reasoning).toBeTruthy();
      expect(step.action?.expectation).toBeTruthy();
    }

    // No secret value anywhere in the persisted record.
    const persisted = JSON.stringify(db.loadSession(sessionId));
    expect(persisted).not.toContain('correct-horse-9');
    expect(persisted).toContain('PASSWORD');
  }, 120_000);
});

describe('the loop mediates between observing and acting', () => {
  it('gives the planner a fresh generation each step and rejects nothing valid', async () => {
    const generations: number[] = [];
    const { record } = await drive(
      reactivePlanner((input) => {
        generations.push(input.observation.generation);
        if (generations.length >= 3) {
          return { action: 'finish', goalAchieved: false, evidence: 'enough', ...common };
        }
        return { action: 'scroll', direction: 'down', ...common };
      }),
      '/pricing',
    );

    expect(generations).toEqual([1, 2, 3]);
    expect(record.steps.every((step) => step.result === null || step.result.ok)).toBe(true);
  }, 60_000);

  it('tells the planner what actually happened, not just that it worked', async () => {
    const histories: string[][] = [];
    await drive(
      reactivePlanner((input) => {
        histories.push(input.history.map((entry) => entry.outcome));
        const start = ref(input, 'link', 'Get started free');
        if (input.history.length >= 2 || start === null) {
          return { action: 'finish', goalAchieved: false, evidence: 'done', ...common };
        }
        return { action: 'click', ref: start, ...common };
      }),
      '/pricing',
    );

    // By the second decision, the first action's consequence is described in
    // terms of where the agent actually ended up.
    const second = histories[1];
    expect(second?.[0]).toContain('different page');
    expect(second?.[0]).toContain('Create your account');
  }, 60_000);

  it('records a run that ends mid-flight with an explicit outcome anyway', async () => {
    const { record } = await drive(
      scriptedPlanner([{ action: 'click', ref: 'e999', ...common }]),
      '/pricing',
    );
    // Not SUCCESS, not null — every run lands somewhere.
    expect(record.outcome).not.toBeNull();
    expect(record.terminationReason).not.toBeNull();
    expect(record.endedAt).not.toBeNull();
  }, 60_000);
});

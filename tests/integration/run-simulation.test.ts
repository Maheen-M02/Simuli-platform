import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/server.ts';
import { runSimulation } from '../../src/runSimulation.ts';
import { RunConfigSchema } from '../../src/config/runConfig.ts';
import { DEFAULT_PERSONA } from '../../src/personas/schema.ts';
import { openDb } from '../../src/persistence/db.ts';
import { ok, type Result } from '../../src/types/shared.ts';
import { ActionSchema, type Action } from '../../src/actions/schema.ts';
import type { Env } from '../../src/config/env.ts';
import type { LlmClient } from '../../src/llm/client.ts';
import type { Planner, PlannerInput } from '../../src/agent/planner.ts';

/**
 * The whole runtime, wired together, with no model call anywhere.
 *
 * This is the V0 deliverable end to end: a run drives a real browser, every
 * action is validated, executed and recorded, the run terminates with an
 * explicit outcome, and a schema-validated evaluation comes out the far side.
 */

let site: FixtureSite;
let dataDir: string;

const env: Env = {
  openaiApiKey: 'not-used-in-this-test',
  plannerModel: 'fake-planner',
  evaluatorModel: 'fake-evaluator',
  logLevel: 'error',
  headless: true,
  secrets: new Map([['PASSWORD', 'correct-horse-9']]),
};

const common = { reasoning: 'r', expectation: 'e' };

/** Stands in for the model's evaluation; the facts are still computed by us. */
const evaluatorClient: LlmClient = {
  async completeJson() {
    return ok({
      goalAchieved: true,
      summary: 'The customer signed up and created an invoice, after hunting for "Billing".',
      findings: [
        {
          title: 'Invoices live under a nav item called "Billing"',
          description: 'The customer expected "Invoices" and had to guess.',
          attribution: 'PRODUCT_FRICTION',
          severity: 'medium',
          stepRefs: [0],
        },
        {
          title: 'A finding about a step that never happened',
          description: 'This one cites evidence that does not exist.',
          attribution: 'PRODUCT_FRICTION',
          severity: 'high',
          stepRefs: [900, 901],
        },
      ],
    });
  },
};

function ref(input: PlannerInput, role: string, name: string): string | null {
  return input.observation.snapshot.nodes.find((n) => n.role === role && n.name === name)?.ref ?? null;
}

function valueOf(input: PlannerInput, name: string): string | undefined {
  return input.observation.snapshot.nodes.find((n) => n.name === name)?.value;
}

/** Walks the fixture flow by reading the page, like a very small agent. */
const flowPlanner: Planner = async (input) => {
  const url = input.observation.snapshot.url;
  const pick = (raw: unknown): Result<Action, string> => ok(ActionSchema.parse(raw));

  const start = ref(input, 'link', 'Get started free');
  if (start !== null) return pick({ action: 'click', ref: start, ...common });

  if (url.includes('/signup')) {
    const email = ref(input, 'textbox', 'Work email');
    if (email !== null && valueOf(input, 'Work email') === '') {
      return pick({ action: 'type', ref: email, value: 'sim@acme.test', ...common });
    }
    const password = ref(input, 'password', 'Password');
    if (password !== null) {
      return pick({
        action: 'type',
        ref: password,
        value: { secret: 'PASSWORD' },
        submit: true,
        ...common,
      });
    }
  }

  const company = ref(input, 'textbox', 'Company name');
  if (company !== null) {
    if (valueOf(input, 'Company name') === '') {
      return pick({ action: 'type', ref: company, value: 'Sim Ltd', ...common });
    }
    const cont = ref(input, 'button', 'Continue');
    if (cont !== null) return pick({ action: 'click', ref: cont, ...common });
  }

  const team = ref(input, 'combobox', 'Team size');
  if (team !== null) {
    if (valueOf(input, 'Team size') === 'Choose an option') {
      return pick({ action: 'select', ref: team, value: '2-10', ...common });
    }
    const done = ref(input, 'button', 'Finish setup');
    if (done !== null) return pick({ action: 'click', ref: done, ...common });
  }

  const billing = ref(input, 'link', 'Go to Billing');
  if (billing !== null) return pick({ action: 'click', ref: billing, ...common });

  const newInvoice = ref(input, 'link', 'New invoice');
  if (newInvoice !== null) return pick({ action: 'click', ref: newInvoice, ...common });

  if (url.includes('/billing/new')) {
    const client = ref(input, 'textbox', 'Client name');
    if (client !== null && valueOf(input, 'Client name') === '') {
      return pick({ action: 'type', ref: client, value: 'Globex', ...common });
    }
    const amount = ref(input, 'textbox', 'Amount');
    if (amount !== null && valueOf(input, 'Amount') === '') {
      return pick({ action: 'type', ref: amount, value: '1250.00', ...common });
    }
    const create = ref(input, 'button', 'Create invoice');
    if (create !== null) return pick({ action: 'click', ref: create, ...common });
  }

  return pick({
    action: 'finish',
    goalAchieved: /\/billing\/INV-\d{4}$/.test(url),
    evidence: `The page at ${url} shows the invoice`,
    ...common,
  });
};

beforeAll(async () => {
  site = await startFixtureSite();
  dataDir = mkdtempSync(join(tmpdir(), 'sim-run-'));
}, 120_000);

afterAll(async () => {
  await site?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('runSimulation', () => {
  it('drives a real browser to a recorded, evaluated outcome', async () => {
    const config = RunConfigSchema.parse({
      startUrl: site.url,
      goal: { description: 'Create my first invoice' },
      persona: DEFAULT_PERSONA,
      dataDir,
      limits: { maxSteps: 20 },
    });

    const result = await runSimulation(config, {
      env,
      planner: flowPlanner,
      llmClient: evaluatorClient,
      sessionId: 'e2e-run',
    });

    // 1. The run reached an explicit outcome.
    expect(result.record.outcome).toBe('SUCCESS');
    expect(result.record.terminationReason).toBe('AGENT_FINISHED');
    expect(result.record.agentSummary).toContain('INV-');

    // 2. Every action was validated, executed and recorded.
    const acted = result.record.steps.filter((step) => step.action !== null);
    expect(acted.length).toBeGreaterThan(5);
    for (const step of acted) {
      expect(ActionSchema.safeParse(step.action).success).toBe(true);
      expect(step.result).not.toBeNull();
      expect(step.action?.expectation).toBeTruthy();
    }

    // 3. A structured, schema-validated evaluation came out.
    expect(result.evaluation).not.toBeNull();
    expect(result.evaluation?.summary).toContain('invoice');
    expect(result.evaluation?.facts.stepCount).toBe(result.record.steps.length);

    // 4. The hallucinated finding was discarded, not reported.
    expect(result.evaluation?.findings).toHaveLength(1);
    expect(result.rejectedFindings).toHaveLength(1);
    expect(result.rejectedFindings[0]?.title).toContain('never happened');

    // 5. It is all on disk, and re-readable without the browser.
    const db = openDb(join(dataDir, 'sessions.db'));
    const reloaded = db.loadSession('e2e-run');
    expect(reloaded?.outcome).toBe('SUCCESS');
    expect(reloaded?.steps).toHaveLength(result.record.steps.length);
    db.close();

    // 6. Screenshots landed in the artifacts directory.
    const shots = readdirSync(join(dataDir, 'artifacts', 'e2e-run'));
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((name) => name.endsWith('.png'))).toBe(true);

    // 7. No credential value anywhere in what we persisted.
    const persisted = JSON.stringify(reloaded);
    expect(persisted).not.toContain('correct-horse-9');
    expect(persisted).toContain('PASSWORD');
  }, 180_000);

  it('keeps the record when evaluation fails', async () => {
    const brokenEvaluator: LlmClient = {
      async completeJson() {
        return ok({ nonsense: true });
      },
    };

    const config = RunConfigSchema.parse({
      startUrl: `${site.url}/pricing`,
      goal: { description: 'Understand the pricing' },
      persona: DEFAULT_PERSONA,
      dataDir,
      screenshots: false,
    });

    const result = await runSimulation(config, {
      env,
      planner: async () =>
        ok(
          ActionSchema.parse({
            action: 'finish',
            goalAchieved: true,
            evidence: 'Two plans are listed',
            ...common,
          }),
        ),
      llmClient: brokenEvaluator,
      sessionId: 'eval-fails',
    });

    // The expensive part survives a failure in the cheap part.
    expect(result.record.outcome).toBe('SUCCESS');
    expect(result.evaluation).toBeNull();
    expect(result.evaluationError).toContain('did not validate');

    const db = openDb(join(dataDir, 'sessions.db'));
    expect(db.loadSession('eval-fails')?.steps.length).toBeGreaterThan(0);
    db.close();
  }, 120_000);

  it('can record a run without evaluating it at all', async () => {
    const config = RunConfigSchema.parse({
      startUrl: `${site.url}/pricing`,
      goal: { description: 'Look at pricing' },
      persona: DEFAULT_PERSONA,
      dataDir,
      screenshots: false,
      evaluate: false,
    });

    const result = await runSimulation(config, {
      env,
      planner: async () =>
        ok(ActionSchema.parse({ action: 'finish', goalAchieved: false, evidence: 'x', ...common })),
      sessionId: 'no-eval',
    });

    expect(result.evaluation).toBeNull();
    expect(result.evaluationError).toBeNull();
    expect(result.record.outcome).toBe('FAILURE');
  }, 120_000);
});

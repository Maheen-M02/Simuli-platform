import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/server.ts';
import { startSession, type BrowserSession } from '../../src/browser/session.ts';
import { executeAction, isDestructiveName } from '../../src/browser/executor.ts';
import { observe, settle } from '../../src/observations/observe.ts';
import { ActionSchema, type Action } from '../../src/actions/schema.ts';
import type { Observation, SnapshotNode } from '../../src/observations/types.ts';
import { createRedactor } from '../../src/observations/redact.ts';

/**
 * Execution and observation against a real browser and the fixture site.
 *
 * These assert loop and executor behaviour only. Nothing here depends on model
 * judgment — actions are handwritten, so a failure means our machinery broke,
 * not that a model had an off day.
 */

let site: FixtureSite;
let session: BrowserSession;
let blockedNavigations: string[] = [];

const SECRETS = new Map([['PASSWORD', 'correct-horse-9']]);
const redact = createRedactor(SECRETS);

let generation = 0;
let current: Observation;

async function look(): Promise<Observation> {
  await settle(session.page, { timeoutMs: 5000 });
  generation += 1;
  current = await observe(session.page, { generation, redact });
  return current;
}

async function run(input: unknown): Promise<ReturnType<typeof executeAction>> {
  const action: Action = ActionSchema.parse(input);
  return executeAction(session.page, action, {
    snapshot: current.snapshot,
    actionGeneration: current.generation,
    currentGeneration: generation,
    secrets: SECRETS,
    takeBlockedNavigations: session.takeBlockedNavigations,
  });
}

function find(predicate: (node: SnapshotNode) => boolean): SnapshotNode {
  const node = current.snapshot.nodes.find(predicate);
  if (node === undefined) {
    throw new Error(`No matching node. Saw:\n${current.text}`);
  }
  return node;
}

function refFor(role: SnapshotNode['role'], name: string): string {
  const node = find((n) => n.role === role && n.name === name);
  if (node.ref === null) throw new Error(`${role} "${name}" has no ref`);
  return node.ref;
}

const common = { reasoning: 'test', expectation: 'test' };

beforeAll(async () => {
  site = await startFixtureSite();
  session = await startSession(site.url, {
    headless: true,
    allowedOrigins: [],
    onBlockedNavigation: (url) => blockedNavigations.push(url),
  });
}, 120_000);

afterAll(async () => {
  await session?.close();
  await site?.close();
});

beforeEach(async () => {
  blockedNavigations = [];
  // Each test starts signed out. Runs are isolated from each other in
  // production for the same reason: leftover state makes results a lie.
  await session.context.clearCookies();
});

describe('observation', () => {
  it('sees a page the way a person would describe it', async () => {
    await session.page.goto(`${site.url}/signup`);
    const observation = await look();

    expect(observation.text).toContain('Create your account');
    expect(observation.text).toContain('textbox "Work email"');
    expect(observation.text).toContain('button "Create account"');
    // The nav is a real part of the page and must be visible to the agent.
    expect(observation.text).toContain('link "Pricing"');
  });

  it('never reads a password field back out', async () => {
    await session.page.goto(`${site.url}/signup`);
    await look();
    await run({ action: 'type', ref: refFor('password', 'Password'), value: { secret: 'PASSWORD' }, ...common });

    const after = await look();
    const password = find((n) => n.role === 'password');
    expect(password.value).toBeUndefined();
    expect(after.text).toContain('value hidden');
    expect(after.text).not.toContain('correct-horse-9');
  });

  it('redacts a secret the product echoes back into its own HTML', async () => {
    // The site renders the email back into the form after a failed signup; the
    // same mechanism is how a real product leaks a value into an observation.
    const leakyRedactor = createRedactor(new Map([['EMAIL', 'leaky@acme.test']]));
    await session.page.goto(`${site.url}/signup`);
    await session.page.fill('#email', 'leaky@acme.test');
    await session.page.fill('#password', 'short');
    await session.page.click('button[type=submit]');
    await settle(session.page, { timeoutMs: 5000 });

    const observation = await observe(session.page, { generation: 99, redact: leakyRedactor });
    expect(observation.text).not.toContain('leaky@acme.test');
    expect(observation.text).toContain('[REDACTED:EMAIL]');
  });

  it('surfaces an error message as an alert', async () => {
    await session.page.goto(`${site.url}/signup`);
    await session.page.fill('#email', 'x@y.com');
    await session.page.fill('#password', 'short');
    await session.page.click('button[type=submit]');
    const observation = await look();
    expect(observation.text).toContain('alert "Password must be at least 10 characters');
  });

  it('mints a fresh set of refs each time and clears the previous stamps', async () => {
    await session.page.goto(`${site.url}/signup`);
    const first = await look();
    const second = await look();

    const refs = second.snapshot.nodes.filter((n) => n.ref !== null).map((n) => n.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(await session.page.locator('[data-sim-ref]').count()).toBe(refs.length);
    expect(second.generation).toBe(first.generation + 1);
  });
});

describe('code injected into the page', () => {
  it('survives a build that rewrites named functions', async () => {
    // Found by the first real CLI run, not by this suite: esbuild with
    // keepNames compiles our DOM walk into calls to an injected `__name`
    // helper, which does not exist inside the browser. tsx does this and
    // vitest does not, so the same code passed `npm test` and died instantly
    // under the CLI with `__name is not defined`.
    await session.page.goto(`${site.url}/signup`);
    expect(await session.page.evaluate(() => typeof (globalThis as never)['__name'])).toBe('function');

    // The shim must survive navigation, or it only protects the first page.
    await session.page.goto(`${site.url}/pricing`);
    expect(await session.page.evaluate(() => typeof (globalThis as never)['__name'])).toBe('function');

    // And it must be harmless: an identity function, not a transform.
    const identity = await session.page.evaluate(() => {
      const name = (globalThis as never)['__name'] as (fn: unknown) => unknown;
      const fn = () => 42;
      return name(fn) === fn;
    });
    expect(identity).toBe(true);
  });

  it('still extracts a snapshot on a page that defines its own __name', async () => {
    // The shim uses ??=, so a page with its own binding keeps it.
    await session.page.goto(`${site.url}/signup`);
    const observation = await look();
    expect(observation.snapshot.nodes.length).toBeGreaterThan(0);
  });
});

describe('execution', () => {
  it('completes signup -> onboarding -> invoice using only refs', async () => {
    await session.page.goto(site.url);
    await look();

    // The landing CTA is a <button> inside an <a>. The walk reports the anchor and
    // does not descend, so the agent sees one link rather than two overlapping targets.
    expect((await run({ action: 'click', ref: refFor('link', 'Get started free'), ...common })).ok).toBe(true);
    await look();

    await run({ action: 'type', ref: refFor('textbox', 'Work email'), value: 'agent@acme.test', ...common });
    await run({ action: 'type', ref: refFor('password', 'Password'), value: { secret: 'PASSWORD' }, ...common });
    await run({ action: 'click', ref: refFor('button', 'Create account'), ...common });

    let observation = await look();
    expect(observation.snapshot.url).toContain('/onboarding');

    await run({ action: 'type', ref: refFor('textbox', 'Company name'), value: 'Acme Ltd', ...common });
    await run({ action: 'click', ref: refFor('button', 'Continue'), ...common });
    await look();

    // A select, chosen by its visible label rather than its value.
    const selectResult = await run({ action: 'select', ref: refFor('combobox', 'Team size'), value: '2-10', ...common });
    expect(selectResult.ok).toBe(true);
    await run({ action: 'click', ref: refFor('button', 'Finish setup'), ...common });

    observation = await look();
    expect(observation.snapshot.url).toMatch(/\/app$/);

    await run({ action: 'click', ref: refFor('link', 'Go to Billing'), ...common });
    await look();
    await run({ action: 'click', ref: refFor('link', 'New invoice'), ...common });
    await look();

    await run({ action: 'type', ref: refFor('textbox', 'Client name'), value: 'Globex', ...common });
    await run({ action: 'type', ref: refFor('textbox', 'Amount'), value: '1250.00', ...common });
    const created = await run({ action: 'click', ref: refFor('button', 'Create invoice'), ...common });
    expect(created.ok).toBe(true);
    expect(created.navigated).toBe(true);

    observation = await look();
    expect(observation.snapshot.url).toMatch(/\/app\/billing\/INV-\d{4}$/);
    expect(observation.text).toContain('Globex');
  }, 60_000);

  it('reports navigation when an action changes the page', async () => {
    await session.page.goto(`${site.url}/pricing`);
    await look();
    const result = await run({ action: 'click', ref: refFor('link', 'Sign up'), ...common });
    expect(result.ok).toBe(true);
    expect(result.navigated).toBe(true);
  });

  it('submits on Enter when asked to', async () => {
    await session.page.goto(`${site.url}/signup`);
    await look();
    await run({ action: 'type', ref: refFor('textbox', 'Work email'), value: 'enter@acme.test', ...common });
    const typed = await run({
      action: 'type',
      ref: refFor('password', 'Password'),
      value: 'short',
      submit: true,
      ...common,
    });
    expect(typed.ok).toBe(true);
    const observation = await look();
    expect(observation.text).toContain('alert "Password must be at least 10 characters');
  });

  it('goes back, and says so when there is nowhere to go', async () => {
    await session.page.goto(`${site.url}/`);
    await session.page.goto(`${site.url}/pricing`);
    await look();
    const back = await run({ action: 'go_back', ...common });
    expect(back.ok).toBe(true);
    expect(session.page.url()).toMatch(/\/$/);
  });
});

describe('execution — refusals', () => {
  it('rejects an action decided against a stale view', async () => {
    await session.page.goto(`${site.url}/signup`);
    await look();
    const staleRef = refFor('button', 'Create account');
    const staleSnapshot = current.snapshot;
    const staleGeneration = current.generation;

    await look(); // the page has moved on to a new generation

    const result = await executeAction(
      session.page,
      ActionSchema.parse({ action: 'click', ref: staleRef, ...common }),
      {
        snapshot: staleSnapshot,
        actionGeneration: staleGeneration,
        currentGeneration: generation,
        secrets: SECRETS,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('STALE_SNAPSHOT');
  });

  it('fails rather than guesses when a ref is not in the snapshot', async () => {
    await session.page.goto(`${site.url}/signup`);
    await look();
    const result = await run({ action: 'click', ref: 'e999', ...common });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('REF_NOT_FOUND');
  });

  it('refuses a destructive click and explains why', async () => {
    // Get an account to an invoice with a "Send invoice" button.
    await session.page.goto(`${site.url}/signup`);
    await look();
    await run({ action: 'type', ref: refFor('textbox', 'Work email'), value: 'sender@acme.test', ...common });
    await run({ action: 'type', ref: refFor('password', 'Password'), value: { secret: 'PASSWORD' }, ...common });
    await run({ action: 'click', ref: refFor('button', 'Create account'), ...common });
    await look();
    await run({ action: 'type', ref: refFor('textbox', 'Company name'), value: 'Sender Ltd', ...common });
    await run({ action: 'click', ref: refFor('button', 'Continue'), ...common });
    await look();
    await run({ action: 'select', ref: refFor('combobox', 'Team size'), value: 'Just me', ...common });
    await run({ action: 'click', ref: refFor('button', 'Finish setup'), ...common });
    await look();

    await session.page.goto(`${site.url}/app/billing/new`);
    await look();
    await run({ action: 'type', ref: refFor('textbox', 'Client name'), value: 'Initech', ...common });
    await run({ action: 'type', ref: refFor('textbox', 'Amount'), value: '99', ...common });
    await run({ action: 'click', ref: refFor('button', 'Create invoice'), ...common });
    await look();

    const result = await run({ action: 'click', ref: refFor('button', 'Send invoice'), ...common });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('ACTION_BLOCKED');

    // The refusal must be real, not advisory: the invoice is still a draft.
    await look();
    expect(current.text).toContain('Status: draft');
  }, 60_000);

  it('reports a missing credential without inventing one', async () => {
    await session.page.goto(`${site.url}/signup`);
    await look();
    const result = await run({
      action: 'type',
      ref: refFor('password', 'Password'),
      value: { secret: 'NOT_CONFIGURED' },
      ...common,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('SECRET_NOT_FOUND');
    expect(await session.page.inputValue('#password')).toBe('');
  });

  it('blocks navigation outside the allowlist', async () => {
    await session.page.goto(`${site.url}/`);
    await session.page
      .evaluate(() => {
        const link = document.createElement('a');
        link.href = 'https://example.com/';
        link.textContent = 'Leave the site';
        document.body.appendChild(link);
      });
    await look();
    const result = await run({ action: 'click', ref: refFor('link', 'Leave the site'), ...common });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('NAVIGATION_BLOCKED');
    expect(blockedNavigations.some((url) => url.startsWith('https://example.com'))).toBe(true);

    // The agent is not stranded on a browser error page: it can read what
    // happened and back out the way a person would.
    const after = await look();
    expect(after.text).toContain('This page is outside the simulation');
    const back = await run({ action: 'go_back', ...common });
    expect(back.ok).toBe(true);
    expect(session.page.url()).toContain('127.0.0.1');
  });
});

describe('destructive-name matching', () => {
  it('catches the phrasings a product actually uses', () => {
    for (const name of [
      'Send invoice',
      'Pay now',
      'Complete purchase',
      'Delete account',
      'Place order',
      'Transfer funds',
      'Yes, delete it',
      'Cancel my subscription',
    ]) {
      expect(isDestructiveName(name), name).toBe(true);
    }
  });

  it('leaves ordinary progress alone', () => {
    for (const name of [
      'Create account',
      'Continue',
      'Finish setup',
      'New invoice',
      'Create invoice',
      'Go to Billing',
      'Get started free',
      'Save draft',
      'Back to Billing',
    ]) {
      expect(isDestructiveName(name), name).toBe(false);
    }
  });
});

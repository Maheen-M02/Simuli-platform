import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/server.ts';

/**
 * The fixture site is the substrate every other integration test stands on.
 * If its flow drifts, those tests fail for reasons that have nothing to do with
 * the agent, so it gets its own contract test.
 */

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

/** A fetch that never follows redirects, so we can assert on Location. */
async function get(path: string, cookie?: string): Promise<Response> {
  return fetch(`${site.url}${path}`, {
    redirect: 'manual',
    headers: cookie === undefined ? {} : { cookie },
  });
}

async function post(path: string, form: Record<string, string>, cookie?: string): Promise<Response> {
  return fetch(`${site.url}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(form).toString(),
  });
}

function sessionCookie(res: Response): string {
  const header = res.headers.get('set-cookie');
  expect(header).not.toBeNull();
  return (header as string).split(';')[0] as string;
}

describe('fixture site', () => {
  it('serves a landing page that links to signup', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Get started free');
    expect(body).toContain('href="/signup"');
  });

  it('rejects a weak password and only then reveals the rule', async () => {
    const before = await get('/signup');
    expect(await before.text()).not.toContain('at least 10 characters');

    const res = await post('/signup', { email: 'a@b.com', password: 'short' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('at least 10 characters and include a number');
  });

  it('rejects an invalid email', async () => {
    const res = await post('/signup', { email: 'not-an-email', password: 'correct-horse-9' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('valid email');
  });

  it('gates the app behind onboarding, then completes signup -> onboarding -> invoice', async () => {
    const signup = await post('/signup', { email: 'founder@acme.test', password: 'correct-horse-9' });
    expect(signup.status).toBe(303);
    expect(signup.headers.get('location')).toBe('/onboarding');
    const cookie = sessionCookie(signup);

    // Onboarding is not optional: the app bounces back until it is finished.
    const early = await get('/app', cookie);
    expect(early.status).toBe(303);
    expect(early.headers.get('location')).toBe('/onboarding');

    const noCompany = await post('/onboarding', { company: '' }, cookie);
    expect(noCompany.status).toBe(400);

    const company = await post('/onboarding', { company: 'Acme Ltd' }, cookie);
    expect(company.headers.get('location')).toBe('/onboarding/team');

    const noTeam = await post('/onboarding/team', { teamSize: '' }, cookie);
    expect(noTeam.status).toBe(400);
    expect(await noTeam.text()).toContain('Select a team size');

    const team = await post('/onboarding/team', { teamSize: '2-10' }, cookie);
    expect(team.headers.get('location')).toBe('/app');

    const home = await get('/app', cookie);
    expect(await home.text()).toContain('Acme Ltd');

    const emptyBilling = await get('/app/billing', cookie);
    expect(await emptyBilling.text()).toContain('No invoices yet');

    // The amount field will not accept a currency symbol.
    const badAmount = await post('/app/billing/new', { client: 'Globex', amount: '$1,250' }, cookie);
    expect(badAmount.status).toBe(400);
    expect(await badAmount.text()).toContain('Enter an amount like 250');

    const created = await post('/app/billing/new', { client: 'Globex', amount: '1250.00' }, cookie);
    expect(created.status).toBe(303);
    const location = created.headers.get('location') as string;
    expect(location).toMatch(/^\/app\/billing\/INV-\d{4}$/);

    const detail = await get(location, cookie);
    const detailBody = await detail.text();
    expect(detailBody).toContain('Globex');
    expect(detailBody).toContain('$1250.00');
    expect(detailBody).toContain('Status: draft');

    const sent = await post(`${location}/send`, {}, cookie);
    expect(sent.status).toBe(303);
    expect(await (await get(location, cookie)).text()).toContain('Status: sent');
  });

  it('redirects anonymous visitors away from the app', async () => {
    const res = await get('/app/billing');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/signup');
  });

  it('refuses a duplicate email', async () => {
    await post('/signup', { email: 'dupe@acme.test', password: 'correct-horse-9' });
    const again = await post('/signup', { email: 'dupe@acme.test', password: 'correct-horse-9' });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('already exists');
  });
});

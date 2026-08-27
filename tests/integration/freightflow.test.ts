import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { startFreightFlow, type FreightFlowSite } from '../../fixtures/freightflow/server.ts';
import {
  GROUND_TRUTH_MARKER,
  KNOWN_NON_ISSUES,
  KNOWN_PATHS,
  KNOWN_PRODUCT_ISSUES,
} from '../../fixtures/freightflow/ground-truth.ts';

/**
 * FreightFlow's own contract, plus the two checks that keep the experiment
 * honest.
 *
 * If the ground truth can reach the agent, every number this target produces is
 * worthless — an agent that can read the answer key is not being measured. So
 * those two tests matter more than the flow tests: a flow regression makes a
 * run fail visibly, while a leak makes it succeed misleadingly.
 */

let site: FreightFlowSite;

beforeAll(async () => {
  site = await startFreightFlow();
});

afterAll(async () => {
  await site.close();
});

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

/** Signs up and finishes onboarding. Returns the session cookie. */
async function onboardedAccount(email: string): Promise<string> {
  const signup = await post('/signup', { email, password: 'freight-flow-1' });
  expect(signup.status).toBe(303);
  const cookie = sessionCookie(signup);
  await post('/onboarding/company', { company: 'Test Haulage', country: 'GB' }, cookie);
  await post('/onboarding/size', { teamSize: '25-49' }, cookie);
  return cookie;
}

describe('ground truth cannot reach the agent', () => {
  /**
   * Import statements only. A comment explaining the rule is fine and in fact
   * desirable — the thing that would compromise the experiment is the module
   * being reachable from code that renders a page.
   */
  function importsOf(file: string): string[] {
    return [...readFileSync(file, 'utf8').matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map(
      (match) => match[1] ?? '',
    );
  }

  it('is not imported by the server, or by anything the server renders with', () => {
    // The agent's whole view is what these files write to the wire, so keeping
    // the answers out of them is the mechanism, not a convention.
    for (const file of [
      'fixtures/freightflow/server.ts',
      'fixtures/freightflow/render.ts',
      'fixtures/freightflow/state.ts',
    ]) {
      const imports = importsOf(file);
      expect(imports.some((specifier) => specifier.includes('ground-truth')), file).toBe(false);
    }
  });

  it('is imported by the harness, which is how the scorer reaches it', () => {
    // The other half of the guarantee: if nothing imported it, the isolation
    // test above would pass trivially and prove nothing.
    expect(importsOf('scripts/targets.ts').some((s) => s.includes('ground-truth'))).toBe(true);
  });

  it('leaks no marker into any served page', async () => {
    const cookie = await onboardedAccount('leak-check@test.test');
    const markers = [
      GROUND_TRUTH_MARKER,
      'KNOWN_PRODUCT_ISSUES',
      'KNOWN_NON_ISSUES',
      ...KNOWN_PRODUCT_ISSUES.map((issue) => issue.id),
      ...KNOWN_NON_ISSUES.map((entry) => entry.id),
    ];

    for (const path of KNOWN_PATHS) {
      const body = await (await get(path, cookie)).text();
      for (const marker of markers) {
        expect(body.includes(marker), `${marker} leaked into ${path}`).toBe(false);
      }
    }
  });

  it('does not hint at the deliberate friction in its own markup', async () => {
    // A comment such as "intentionally hard to find" would be as good as
    // telling the agent, and is the sort of thing added while debugging.
    const cookie = await onboardedAccount('hint-check@test.test');
    for (const path of KNOWN_PATHS) {
      const body = (await (await get(path, cookie)).text()).toLowerCase();
      for (const hint of ['intentional', 'deliberate', 'on purpose', 'known issue', 'fixture']) {
        expect(body.includes(hint), `"${hint}" appears in ${path}`).toBe(false);
      }
    }
  });
});

describe('the public site', () => {
  it('presents a product and links to pricing and signup', async () => {
    const body = await (await get('/')).text();
    expect(body).toContain('Freight operations');
    expect(body).toContain('href="/pricing"');
    expect(body).toContain('href="/signup"');
  });

  it('states three plans with user limits, so cost is answerable', async () => {
    const body = await (await get('/pricing')).text();
    expect(body).toContain('Starter');
    expect(body).toContain('Growth');
    expect(body).toContain('Enterprise');
    expect(body).toContain('£49');
    expect(body).toContain('Up to 10 users');
    expect(body).toContain('Up to 25 users');
    // A 40-person company needs Enterprise. That is the answer to a task.
    expect(body).toContain('26 users or more');
  });
});

describe('signup, onboarding and sign-in', () => {
  it('states the password rule up front and enforces it', async () => {
    const form = await (await get('/signup')).text();
    expect(form).toContain('At least 10 characters, including a number');

    const weak = await post('/signup', { email: 'weak@test.test', password: 'short' });
    expect(weak.status).toBe(400);
    expect(await weak.text()).toContain('at least 10 characters and include a number');
  });

  it('walks two onboarding steps and lands in the app', async () => {
    const signup = await post('/signup', { email: 'flow@test.test', password: 'freight-flow-1' });
    expect(signup.headers.get('location')).toBe('/onboarding/company');
    const cookie = sessionCookie(signup);

    // The app is gated until setup finishes.
    expect((await get('/app', cookie)).headers.get('location')).toBe('/onboarding/company');

    const noCountry = await post('/onboarding/company', { company: 'Acme', country: '' }, cookie);
    expect(noCountry.status).toBe(400);
    expect(await noCountry.text()).toContain('Choose the country');

    const company = await post('/onboarding/company', { company: 'Acme', country: 'GB' }, cookie);
    expect(company.headers.get('location')).toBe('/onboarding/size');

    const noSize = await post('/onboarding/size', { teamSize: '' }, cookie);
    expect(noSize.status).toBe(400);

    const size = await post('/onboarding/size', { teamSize: '25-49' }, cookie);
    expect(size.headers.get('location')).toBe('/app');
    expect(await (await get('/app', cookie)).text()).toContain('Acme');
  });

  it('signs an existing account back in', async () => {
    await onboardedAccount('returning@test.test');
    const again = await post('/signin', { email: 'returning@test.test', password: 'freight-flow-1' });
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe('/app');

    const wrong = await post('/signin', { email: 'returning@test.test', password: 'nope' });
    expect(wrong.status).toBe(400);
  });

  it('sends anonymous visitors to sign in', async () => {
    expect((await get('/app/invoices')).headers.get('location')).toBe('/signin');
  });
});

describe('the application works where we say it works', () => {
  it('shows a dashboard with seeded data, so the product is not empty', async () => {
    const cookie = await onboardedAccount('dash@test.test');
    const body = await (await get('/app', cookie)).text();
    expect(body).toContain('Meridian Foods');
    expect(body).toContain('Shipments in progress');
    expect(body).toContain('Book a shipment');
  });

  it('adds a customer', async () => {
    const cookie = await onboardedAccount('cust@test.test');
    const created = await post(
      '/app/customers/new',
      { name: 'Northgate Timber', contact: 'accounts@northgate.test' },
      cookie,
    );
    expect(created.status).toBe(303);
    expect(await (await get('/app/customers', cookie)).text()).toContain('Northgate Timber');
  });

  it('books a shipment given valid input', async () => {
    const cookie = await onboardedAccount('ship@test.test');
    const created = await post(
      '/app/shipments/new',
      { customerId: 'CUS-001', origin: 'Dover', destination: 'Glasgow', weight: '1200' },
      cookie,
    );
    expect(created.status).toBe(303);
    const location = created.headers.get('location') as string;
    expect(location).toMatch(/^\/app\/shipments\/SHP-\d+$/);
    const detail = await (await get(location, cookie)).text();
    expect(detail).toContain('Dover');
    expect(detail).toContain('1,200 kg');
  });

  it('searches across shipments, customers and invoices', async () => {
    const cookie = await onboardedAccount('search@test.test');
    expect(await (await get('/app/search?q=meridian', cookie)).text()).toContain('Meridian Foods');
    expect(await (await get('/app/search?q=SHP-1002', cookie)).text()).toContain('SHP-1002');
    expect(await (await get('/app/search?q=zzzz', cookie)).text()).toContain('Nothing matched');
  });

  it('signs out', async () => {
    const cookie = await onboardedAccount('out@test.test');
    const out = await post('/signout', {}, cookie);
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe('/');
  });
});

describe('the deliberate friction is really there', () => {
  it('offers no billing link on the dashboard, and no nav item called Billing', async () => {
    const cookie = await onboardedAccount('billing@test.test');
    const dashboard = await (await get('/app', cookie)).text();

    expect(dashboard).not.toContain('/app/account/billing');
    // The sidebar says "Account". A customer looking for "Billing" sees nothing.
    expect(dashboard).toContain('>Account<');
    expect(dashboard).not.toMatch(/>Billing</);

    // It does exist, two levels down, which is what makes it friction rather
    // than an absent feature.
    expect(await (await get('/app/account', cookie)).text()).toContain('/app/account/billing');
    expect(await (await get('/app/account/billing', cookie)).text()).toContain('Current plan');
  });

  it('offers no way to create an invoice from the invoices page', async () => {
    const cookie = await onboardedAccount('inv@test.test');
    const invoices = await (await get('/app/invoices', cookie)).text();

    expect(invoices).toContain('Invoices');
    expect(invoices).not.toContain('/app/invoices/new');
    expect(invoices).not.toContain('New invoice');
    // And no hint about where they come from.
    expect(invoices.toLowerCase()).not.toContain('generated from');
  });

  it('generates an invoice only from a shipment', async () => {
    const cookie = await onboardedAccount('gen@test.test');
    // SHP-1002 is seeded uninvoiced.
    const shipment = await (await get('/app/shipments/SHP-1002', cookie)).text();
    expect(shipment).toContain('Generate invoice');

    const generated = await post('/app/shipments/SHP-1002/invoice', {}, cookie);
    expect(generated.status).toBe(303);
    const location = generated.headers.get('location') as string;
    expect(location).toMatch(/^\/app\/invoices\/INV-\d+$/);
    expect(await (await get(location, cookie)).text()).toContain('SHP-1002');
  });

  it('states no unit or range on the weight field, and says only "Invalid value."', async () => {
    const cookie = await onboardedAccount('weight@test.test');
    const form = await (await get('/app/shipments/new', cookie)).text();

    // The label is bare: no kg, no maximum.
    expect(form).toContain('>Weight<');
    expect(form).not.toMatch(/Weight[^<]*\(kg\)/);
    expect(form).not.toContain('30000');

    const bad = await post(
      '/app/shipments/new',
      { customerId: 'CUS-001', origin: 'Dover', destination: 'Leeds', weight: '2.5 tonnes' },
      cookie,
    );
    expect(bad.status).toBe(400);
    const body = await bad.text();
    expect(body).toContain('Invalid value.');
    // The error adds nothing the customer did not already know.
    expect(body).not.toContain('kilogram');
    expect(body).not.toContain('30,000');
  });

  it('links pricing nowhere in the app except inside billing', async () => {
    const cookie = await onboardedAccount('price@test.test');
    for (const path of ['/app', '/app/shipments', '/app/customers', '/app/invoices', '/app/account']) {
      expect((await (await get(path, cookie)).text()).includes('href="/pricing"'), path).toBe(false);
    }
    expect(await (await get('/app/account/billing', cookie)).text()).toContain('href="/pricing"');
  });

  it('returns a real 500 from the reports page', async () => {
    const cookie = await onboardedAccount('reports@test.test');
    const res = await get('/app/reports', cookie);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('error 500');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFreightFlow, type FreightFlowSite } from '../../fixtures/freightflow/server.ts';
import { startSession, type BrowserSession } from '../../src/browser/session.ts';
import { observe, settle } from '../../src/observations/observe.ts';
import { createRedactor } from '../../src/observations/redact.ts';
import type { Observation } from '../../src/observations/types.ts';

/**
 * What the agent can and cannot see, element by element.
 *
 * This file exists because of a specific failure. FreightFlow's pricing page
 * puts each price in a `<div class="price">` and each plan name in a
 * `<strong>`, and our DOM walk reported text only from a whitelist of block
 * tags. The agent was shown a pricing page with no prices on it, scrolled four
 * times looking for them, and gave up — correctly, given what we had shown it.
 *
 * Had that reached a customer, the report would have said "your pricing page
 * shows no prices". So the coverage is now pinned per element type, and the
 * pricing page has its own test at the bottom.
 *
 * The other half of the requirement is that this stays *compact*. Dumping the
 * DOM would pass every test above and make the agent worse, so several tests
 * here assert absence: no duplication, no wrapper noise, no invisible text.
 */

let site: FreightFlowSite;
let session: BrowserSession;
const redact = createRedactor(new Map());
let generation = 0;

async function look(): Promise<Observation> {
  // Short settle: these pages are already loaded and several fragments contain
  // no interactive element, so the client-render wait would otherwise burn its
  // full budget on every one of them.
  await settle(session.page, { timeoutMs: 500 });
  generation += 1;
  return observe(session.page, { generation, redact });
}

/** Renders a fragment on a blank page and returns what the agent would see. */
async function seeing(html: string): Promise<Observation> {
  await session.page.goto(`${site.url}/`);
  await session.page.evaluate((markup: string) => {
    document.body.innerHTML = markup;
  }, html);
  return look();
}

function lines(observation: Observation): string[] {
  return observation.text.split('\n').filter((line) => line.trim() !== '');
}

beforeAll(async () => {
  site = await startFreightFlow();
  session = await startSession(site.url, { headless: true, allowedOrigins: [] });
}, 120_000);

afterAll(async () => {
  await session?.close();
  await site?.close();
});

describe('every element type a real product uses is represented', () => {
  it('reports text in a div', async () => {
    const observation = await seeing('<div>Quarterly volume is up</div>');
    expect(observation.text).toContain('Quarterly volume is up');
  });

  it('reports text in a span', async () => {
    const observation = await seeing('<span>in transit</span>');
    expect(observation.text).toContain('in transit');
  });

  it('reports text in a strong or an em', async () => {
    const observation = await seeing('<strong>Growth plan</strong><em>most popular</em>');
    expect(observation.text).toContain('Growth plan');
    expect(observation.text).toContain('most popular');
  });

  it('reports headings with their level', async () => {
    const observation = await seeing('<h1>Invoices</h1><h2>Outstanding</h2><h3>Overdue</h3>');
    expect(observation.text).toContain('heading1 "Invoices"');
    expect(observation.text).toContain('heading2 "Outstanding"');
    expect(observation.text).toContain('heading3 "Overdue"');
  });

  it('reports a button as an actionable control with a ref', async () => {
    const observation = await seeing('<button>Generate invoice</button>');
    expect(observation.text).toMatch(/button "Generate invoice" \[e\d+\]/);
  });

  it('reports a link as an actionable control with a ref', async () => {
    const observation = await seeing('<a href="/app/invoices">See invoices</a>');
    expect(observation.text).toMatch(/link "See invoices" \[e\d+\]/);
  });

  it('reports an input as a textbox named by its label', async () => {
    // This is what "appropriately" means for a label: its text becomes the
    // field's name. Reporting it separately as well would show the customer the
    // same words twice and make a field indistinguishable from its caption.
    const observation = await seeing(
      '<label for="client">Client name</label><input id="client" type="text" value="Meridian">',
    );
    expect(observation.text).toMatch(/textbox "Client name" \[e\d+\]/);
    expect(observation.text).toContain('current value: "Meridian"');

    const labelLines = lines(observation).filter((line) => line.startsWith('text "Client name"'));
    expect(labelLines).toHaveLength(0);
  });

  it('reports a password field without ever reading its value', async () => {
    const observation = await seeing(
      '<label for="pw">Password</label><input id="pw" type="password" value="hunter2-secret">',
    );
    expect(observation.text).toContain('password "Password"');
    expect(observation.text).toContain('value hidden');
    expect(observation.text).not.toContain('hunter2-secret');
  });

  it('reports a select with its options and current value', async () => {
    const observation = await seeing(
      '<label for="size">Team size</label>' +
        '<select id="size"><option value="">Choose</option><option selected>10 to 24</option><option>25 to 49</option></select>',
    );
    expect(observation.text).toContain('combobox "Team size"');
    expect(observation.text).toContain('"10 to 24"');
    expect(observation.text).toContain('"25 to 49"');
    expect(observation.text).toContain('current value: "10 to 24"');
  });

  it('reports a checkbox and a radio with their checked state', async () => {
    const observation = await seeing(
      '<label for="a">Email me</label><input id="a" type="checkbox" checked>' +
        '<label for="b">By road</label><input id="b" type="radio">',
    );
    expect(observation.text).toContain('checkbox "Email me"');
    expect(observation.text).toContain('checked');
    expect(observation.text).toContain('radio "By road"');
    expect(observation.text).toContain('unchecked');
  });

  it('reports table cells and headers', async () => {
    const observation = await seeing(
      '<table><tr><th>Reference</th><td>SHP-1002</td></tr><tr><th>Weight</th><td>2,150 kg</td></tr></table>',
    );
    expect(observation.text).toContain('Reference');
    expect(observation.text).toContain('SHP-1002');
    expect(observation.text).toContain('2,150 kg');
  });

  it('reports a validation message as an alert', async () => {
    const observation = await seeing('<div role="alert">Invalid value.</div>');
    expect(observation.text).toContain('alert "Invalid value."');
  });

  it('reports list items', async () => {
    const observation = await seeing('<ul><li>Up to 10 users</li><li>150 shipments a month</li></ul>');
    expect(observation.text).toContain('Up to 10 users');
    expect(observation.text).toContain('150 shipments a month');
  });
});

describe('the observation stays compact', () => {
  it('does not report the same text twice through nested wrappers', async () => {
    // Four wrappers around one string. A naive innerText walk emits it five
    // times and the agent reads a page that repeats itself.
    const observation = await seeing(
      '<div><div><section><span>Only once please</span></section></div></div>',
    );
    const hits = lines(observation).filter((line) => line.includes('Only once please'));
    expect(hits).toHaveLength(1);
  });

  it('attributes a parent and child their own text, without either swallowing the other', async () => {
    const observation = await seeing('<div>Outer text<span>inner text</span></div>');
    const outer = lines(observation).filter((line) => line.includes('Outer text'));
    expect(outer).toHaveLength(1);
    expect(outer[0]).not.toContain('inner text');
    expect(observation.text).toContain('inner text');
  });

  it('emits no empty or whitespace-only text nodes', async () => {
    const observation = await seeing('<div>   \n  <span>real</span>  \n </div><div></div>');
    for (const line of lines(observation)) {
      expect(line).not.toMatch(/^text ""$/);
    }
    expect(observation.text).toContain('real');
  });

  it('reports nothing from a hidden subtree', async () => {
    const observation = await seeing(
      '<div style="display:none">hidden by css</div>' +
        '<div aria-hidden="true">hidden from assistive tech</div>' +
        '<div hidden>hidden attribute</div>' +
        '<div>visible</div>',
    );
    expect(observation.text).not.toContain('hidden by css');
    expect(observation.text).not.toContain('hidden from assistive tech');
    expect(observation.text).not.toContain('hidden attribute');
    expect(observation.text).toContain('visible');
  });

  it('reports nothing from script, style or template', async () => {
    const observation = await seeing(
      '<script>var secretInScript = 1;</script>' +
        '<style>.x { color: red }</style>' +
        '<template><div>templated</div></template>' +
        '<div>actual content</div>',
    );
    expect(observation.text).not.toContain('secretInScript');
    expect(observation.text).not.toContain('color: red');
    expect(observation.text).not.toContain('templated');
    expect(observation.text).toContain('actual content');
  });

  it('does not descend into an anchor that wraps a button', async () => {
    // One thing a person can click, so one line — not two overlapping targets.
    const observation = await seeing('<a href="/x"><button>Start free trial</button></a>');
    const hits = lines(observation).filter((line) => line.includes('Start free trial'));
    expect(hits).toHaveLength(1);
  });

  it('keeps a whole real page to a readable length', async () => {
    // Compactness is a property of real pages, not of contrived fragments.
    await session.page.goto(`${site.url}/pricing`);
    const observation = await look();
    expect(lines(observation).length).toBeLessThan(60);
    expect(observation.snapshot.truncated).toBe(0);
  });
});

describe('the pricing page regression', () => {
  it('shows the prices, which live inside div and span', async () => {
    // The exact failure this file was written for. Each price is
    // `<div class="price">£49<span>/mo</span></div>`; neither tag was in the
    // old whitelist, so the agent saw a pricing page with no prices on it.
    await session.page.goto(`${site.url}/pricing`);
    const observation = await look();

    expect(observation.text).toContain('£49');
    expect(observation.text).toContain('£149');
    expect(observation.text).toContain('Talk to us');
  });

  it('shows the plan names, which live inside strong', async () => {
    await session.page.goto(`${site.url}/pricing`);
    const observation = await look();

    expect(observation.text).toContain('Starter');
    expect(observation.text).toContain('Growth');
    expect(observation.text).toContain('Enterprise');
  });

  it('shows the user limits, so a 40-person question is answerable', async () => {
    await session.page.goto(`${site.url}/pricing`);
    const observation = await look();

    expect(observation.text).toContain('Up to 10 users');
    expect(observation.text).toContain('Up to 25 users');
    expect(observation.text).toContain('26 users or more');
  });

  it('pairs each plan name with its price in reading order', async () => {
    // Seeing both is not enough: an agent has to be able to tell which price
    // belongs to which plan.
    await session.page.goto(`${site.url}/pricing`);
    const observation = await look();
    const all = lines(observation);

    const starter = all.findIndex((line) => line.includes('"Starter"'));
    const fortyNine = all.findIndex((line) => line.includes('£49'));
    const growth = all.findIndex((line) => line.includes('"Growth"'));
    const oneFortyNine = all.findIndex((line) => line.includes('£149'));

    expect(starter).toBeGreaterThanOrEqual(0);
    expect(fortyNine).toBe(starter + 1);
    expect(growth).toBeGreaterThan(fortyNine);
    expect(oneFortyNine).toBe(growth + 1);
  });

  it('shows the dashboard metric numbers, which live inside div', async () => {
    // The same class of problem elsewhere: the dashboard cards put each count
    // in a `<div class="n">` and its caption in a `<div class="l">`.
    const signup = await fetch(`${site.url}/signup`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'obs@test.test', password: 'freight-flow-1' }).toString(),
    });
    const cookie = (signup.headers.get('set-cookie') as string).split(';')[0] as string;
    for (const [path, form] of [
      ['/onboarding/company', { company: 'Obs Ltd', country: 'GB' }],
      ['/onboarding/size', { teamSize: '25-49' }],
    ] as const) {
      await fetch(`${site.url}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams(form).toString(),
      });
    }
    await session.context.addCookies([
      { name: cookie.split('=')[0] as string, value: cookie.split('=')[1] as string, url: site.url },
    ]);

    await session.page.goto(`${site.url}/app`);
    const observation = await look();

    expect(observation.text).toContain('Shipments in progress');
    expect(observation.text).toContain('Invoices outstanding');
    // The counts themselves, not just their captions.
    expect(observation.text).toMatch(/text "\d+"/);
  });
});

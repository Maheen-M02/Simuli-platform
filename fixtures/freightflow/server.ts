/**
 * FreightFlow — a small freight operations SaaS, built as an evaluation target.
 *
 * This application exists for one purpose: to give our agent a believable B2B
 * product to get lost in. It is not a demo of anything and nobody should ship
 * it. What matters is that the paths through it are as unobvious as a real
 * product's, so that "the agent completed the task" means something.
 *
 * IMPORTANT: this module must never import `ground-truth.ts`. The agent sees
 * only what this server writes to the wire, so the way we keep known answers
 * away from it is to keep them out of this file entirely. A test asserts the
 * import is absent, and another crawls every route looking for leaked markers.
 *
 * The deliberate friction is documented in ground-truth.ts, not here — a reader
 * of this file should be able to mistake it for an ordinary product, because
 * that is exactly what the agent has to do.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  accountForToken,
  createSession,
  createStore,
  customerName,
  workspaceFor,
  type Account,
  type Store,
  type Workspace,
} from './state.ts';
import {
  appPage,
  errorBox,
  escapeHtml,
  money,
  notice,
  onboardingPage,
  publicPage,
  weight,
} from './render.ts';

export type FreightFlowSite = {
  /** Origin with no trailing slash. */
  readonly url: string;
  readonly store: Store;
  close(): Promise<void>;
};

export type FreightFlowOptions = {
  /** 0 picks a free port. Pass a fixed one for `npm run fixture:freightflow`. */
  readonly port?: number;
};

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function html(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function redirect(res: ServerResponse, location: string, cookie?: string): void {
  const headers: Record<string, string> = { location };
  if (cookie !== undefined) headers['set-cookie'] = cookie;
  res.writeHead(303, headers);
  res.end();
}

/** Weight is whole kilograms up to 30 tonnes. The form does not say so. */
function parseWeight(raw: string): number | null {
  if (!/^\d{1,6}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value > 0 && value <= 30_000 ? value : null;
}

/** Freight is priced by weight band. Arbitrary but consistent. */
function priceFor(weightKg: number): number {
  return 12_000 + weightKg * 20;
}

export async function startFreightFlow(
  options: FreightFlowOptions = {},
): Promise<FreightFlowSite> {
  const store = createStore();

  const server = createServer((req, res) => {
    handle(req, res, store).catch(() => {
      if (!res.headersSent) {
        html(res, publicPage('Error', '<h1>Something went wrong</h1>'), 500);
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    store,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ---------------------------------------------------------------- page bodies

function landingBody(): string {
  return `
    <h1>Freight operations without the spreadsheets</h1>
    <p class="sub">Book shipments, track them, and invoice your customers from one place.
    Built for freight forwarders and shippers moving 20 to 2,000 loads a month.</p>
    <p><a href="/signup"><button>Start free trial</button></a>
       <a href="/pricing"><button class="plain">See pricing</button></a></p>
    <h2>What you get</h2>
    <table>
      <tr><th>Shipments</th><td>Book a load, assign a customer, track it to delivery.</td></tr>
      <tr><th>Customers</th><td>Keep contacts and addresses in one place.</td></tr>
      <tr><th>Invoicing</th><td>Turn a delivered shipment into an invoice.</td></tr>
      <tr><th>Reporting</th><td>Monthly volume and revenue summaries.</td></tr>
    </table>
    <p class="sub">14-day trial. No card required to start.</p>
  `;
}

function pricingBody(): string {
  return `
    <h1>Pricing</h1>
    <p class="sub">Billed monthly. All plans include shipments, customers and invoicing.</p>
    <div class="plans">
      <div class="plan">
        <strong>Starter</strong>
        <div class="price">£49<span style="font-size:14px">/mo</span></div>
        <ul>
          <li>Up to 10 users</li>
          <li>150 shipments a month</li>
          <li>Email support</li>
        </ul>
      </div>
      <div class="plan">
        <strong>Growth</strong>
        <div class="price">£149<span style="font-size:14px">/mo</span></div>
        <ul>
          <li>Up to 25 users</li>
          <li>750 shipments a month</li>
          <li>Priority support</li>
        </ul>
      </div>
      <div class="plan">
        <strong>Enterprise</strong>
        <div class="price">Talk to us</div>
        <ul>
          <li>26 users or more</li>
          <li>Unlimited shipments</li>
          <li>Named account manager</li>
        </ul>
      </div>
    </div>
    <h2>Common questions</h2>
    <table>
      <tr><th>Is there a free trial?</th><td>Yes, 14 days. No card required.</td></tr>
      <tr><th>What counts as a user?</th><td>Anyone with a login on your account.</td></tr>
      <tr><th>Can we change plan later?</th><td>Yes, from Account.</td></tr>
    </table>
    <p><a href="/signup"><button>Start free trial</button></a></p>
  `;
}

function signupBody(error: string | null, email: string): string {
  return `
    <h1>Start your free trial</h1>
    <p class="sub">14 days, no card required.</p>
    ${errorBox(error)}
    <form method="post" action="/signup">
      <label for="email">Work email</label>
      <input id="email" name="email" type="email" value="${escapeHtml(email)}" autocomplete="email">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="new-password">
      <div class="sub" style="font-size:13px;margin-top:4px">At least 10 characters, including a number.</div>
      <button type="submit">Create account</button>
    </form>
    <p class="sub">Already have an account? <a href="/signin">Sign in</a>.</p>
  `;
}

function signinBody(error: string | null): string {
  return `
    <h1>Sign in</h1>
    ${errorBox(error)}
    <form method="post" action="/signin">
      <label for="email">Work email</label>
      <input id="email" name="email" type="email" autocomplete="email">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password">
      <button type="submit">Sign in</button>
    </form>
    <p class="sub">No account? <a href="/signup">Start a free trial</a>.</p>
  `;
}

function dashboardBody(account: Account, workspace: Workspace): string {
  const active = workspace.shipments.filter((s) => s.status !== 'delivered').length;
  const unpaid = workspace.invoices.filter((i) => i.status !== 'paid').length;

  const rows = workspace.shipments
    .slice(-5)
    .reverse()
    .map(
      (s) => `<tr>
        <td><a href="/app/shipments/${s.id}">${escapeHtml(s.id)}</a></td>
        <td>${escapeHtml(customerName(workspace, s.customerId))}</td>
        <td>${escapeHtml(s.origin)} → ${escapeHtml(s.destination)}</td>
        <td><span class="pill">${s.status}</span></td>
      </tr>`,
    )
    .join('');

  return `
    <h1>${escapeHtml(account.company ?? 'Dashboard')}</h1>
    <p class="sub">Here is where your freight stands today.</p>
    <div class="cards">
      <div class="card"><div class="n">${active}</div><div class="l">Shipments in progress</div></div>
      <div class="card"><div class="n">${workspace.customers.length}</div><div class="l">Customers</div></div>
      <div class="card"><div class="n">${unpaid}</div><div class="l">Invoices outstanding</div></div>
    </div>
    <h2>Recent shipments</h2>
    <table>
      <tr><th>Reference</th><th>Customer</th><th>Route</th><th>Status</th></tr>
      ${rows}
    </table>
    <h2>Quick actions</h2>
    <p class="row">
      <a href="/app/shipments/new"><button>Book a shipment</button></a>
      <a href="/app/customers/new"><button class="plain">Add a customer</button></a>
    </p>
  `;
}

// -------------------------------------------------------------------- routing

async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  const account = accountForToken(store, readCookie(req, 'ff_session'));

  // ---- public -------------------------------------------------------------

  if (path === '/' && method === 'GET') {
    return html(res, publicPage('Freight operations without the spreadsheets', landingBody()));
  }
  if (path === '/pricing' && method === 'GET') {
    return html(res, publicPage('Pricing', pricingBody()));
  }
  if (path === '/signup' && method === 'GET') {
    return html(res, publicPage('Start your free trial', signupBody(null, '')));
  }
  if (path === '/signin' && method === 'GET') {
    return html(res, publicPage('Sign in', signinBody(null)));
  }

  if (path === '/signup' && method === 'POST') {
    const body = await readBody(req);
    const email = (body.get('email') ?? '').trim();
    const password = body.get('password') ?? '';

    if (!email.includes('@') || email.length < 3) {
      return html(res, publicPage('Start your free trial', signupBody('Enter a valid work email address.', email)), 400);
    }
    if (store.accounts.has(email)) {
      return html(
        res,
        publicPage('Start your free trial', signupBody('An account already exists for that email. Sign in instead.', email)),
        400,
      );
    }
    // The rule is stated on the form, so failing it is not a discovery problem.
    if (password.length < 10 || !/\d/.test(password)) {
      return html(
        res,
        publicPage(
          'Start your free trial',
          signupBody('Password must be at least 10 characters and include a number.', email),
        ),
        400,
      );
    }

    store.accounts.set(email, {
      email,
      password,
      company: null,
      country: null,
      teamSize: null,
      onboarded: false,
      plan: 'trial',
    });
    return redirect(res, '/onboarding/company', `ff_session=${createSession(store, email)}; Path=/; HttpOnly`);
  }

  if (path === '/signin' && method === 'POST') {
    const body = await readBody(req);
    const email = (body.get('email') ?? '').trim();
    const password = body.get('password') ?? '';
    const existing = store.accounts.get(email);

    if (existing === undefined || existing.password !== password) {
      return html(res, publicPage('Sign in', signinBody('That email and password do not match an account.')), 400);
    }
    const destination = existing.onboarded ? '/app' : '/onboarding/company';
    return redirect(res, destination, `ff_session=${createSession(store, email)}; Path=/; HttpOnly`);
  }

  if (path === '/signout' && method === 'POST') {
    return redirect(res, '/', 'ff_session=; Path=/; Max-Age=0');
  }

  // ---- everything below needs an account ----------------------------------

  if (account === null) {
    if (path.startsWith('/app') || path.startsWith('/onboarding')) return redirect(res, '/signin');
    return html(res, publicPage('Not found', '<h1>Page not found</h1>'), 404);
  }

  if (path === '/onboarding/company' && method === 'GET') {
    return html(res, onboardingPage('Set up your account', companyBody(null)));
  }
  if (path === '/onboarding/company' && method === 'POST') {
    const body = await readBody(req);
    const company = (body.get('company') ?? '').trim();
    const country = body.get('country') ?? '';
    if (company === '') {
      return html(res, onboardingPage('Set up your account', companyBody('Enter your company name.')), 400);
    }
    if (country === '') {
      return html(res, onboardingPage('Set up your account', companyBody('Choose the country you operate from.')), 400);
    }
    account.company = company;
    account.country = country;
    return redirect(res, '/onboarding/size');
  }

  if (path === '/onboarding/size' && method === 'GET') {
    return html(res, onboardingPage('Set up your account', sizeBody(null)));
  }
  if (path === '/onboarding/size' && method === 'POST') {
    const teamSize = (await readBody(req)).get('teamSize') ?? '';
    if (teamSize === '') {
      return html(res, onboardingPage('Set up your account', sizeBody('Choose how many people will use FreightFlow.')), 400);
    }
    account.teamSize = teamSize;
    account.onboarded = true;
    return redirect(res, '/app');
  }

  if (!account.onboarded && path.startsWith('/app')) return redirect(res, '/onboarding/company');

  const workspace = workspaceFor(store, account);

  // ---- the application ----------------------------------------------------

  if (path === '/app' && method === 'GET') {
    return html(res, appPage('Dashboard', 'dashboard', dashboardBody(account, workspace)));
  }

  if (path === '/app/reports' && method === 'GET') {
    // A controlled server-side failure. Real products have a page like this.
    return html(
      res,
      appPage(
        'Reports',
        'none',
        `<h1>Something went wrong</h1>
         <div class="error" role="alert">We could not load your reports (error 500). Try again later.</div>
         <p><a href="/app">Back to dashboard</a></p>`,
      ),
      500,
    );
  }

  if (path === '/app/customers' && method === 'GET') {
    const rows = workspace.customers
      .map(
        (c) => `<tr><td>${escapeHtml(c.id)}</td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.contact)}</td></tr>`,
      )
      .join('');
    return html(
      res,
      appPage('Customers', 'customers', `
        <h1>Customers</h1>
        <p class="sub">Everyone you move freight for.</p>
        <p><a href="/app/customers/new"><button>Add a customer</button></a></p>
        <table><tr><th>Reference</th><th>Name</th><th>Contact</th></tr>${rows}</table>
      `),
    );
  }

  if (path === '/app/customers/new' && method === 'GET') {
    return html(res, appPage('Add a customer', 'customers', customerFormBody(null, '', '')));
  }
  if (path === '/app/customers/new' && method === 'POST') {
    const body = await readBody(req);
    const name = (body.get('name') ?? '').trim();
    const contact = (body.get('contact') ?? '').trim();
    if (name === '') {
      return html(res, appPage('Add a customer', 'customers', customerFormBody('Enter the customer name.', name, contact)), 400);
    }
    if (!contact.includes('@')) {
      return html(
        res,
        appPage('Add a customer', 'customers', customerFormBody('Enter a contact email address.', name, contact)),
        400,
      );
    }
    const id = `CUS-${String(workspace.nextCustomer++).padStart(3, '0')}`;
    workspace.customers.push({ id, name, contact });
    return redirect(res, '/app/customers');
  }

  if (path === '/app/shipments' && method === 'GET') {
    const rows = workspace.shipments
      .slice()
      .reverse()
      .map(
        (s) => `<tr>
          <td><a href="/app/shipments/${s.id}">${escapeHtml(s.id)}</a></td>
          <td>${escapeHtml(customerName(workspace, s.customerId))}</td>
          <td>${escapeHtml(s.origin)} → ${escapeHtml(s.destination)}</td>
          <td>${weight(s.weightKg)}</td>
          <td><span class="pill">${s.status}</span></td>
        </tr>`,
      )
      .join('');
    return html(
      res,
      appPage('Shipments', 'shipments', `
        <h1>Shipments</h1>
        <p class="sub">Every load you are moving.</p>
        <p><a href="/app/shipments/new"><button>Book a shipment</button></a></p>
        <table><tr><th>Reference</th><th>Customer</th><th>Route</th><th>Weight</th><th>Status</th></tr>${rows}</table>
      `),
    );
  }

  if (path === '/app/shipments/new' && method === 'GET') {
    return html(res, appPage('Book a shipment', 'shipments', shipmentFormBody(workspace, null, {})));
  }
  if (path === '/app/shipments/new' && method === 'POST') {
    const body = await readBody(req);
    const values = {
      customerId: body.get('customerId') ?? '',
      origin: (body.get('origin') ?? '').trim(),
      destination: (body.get('destination') ?? '').trim(),
      weight: (body.get('weight') ?? '').trim(),
    };

    if (values.customerId === '' || !workspace.customers.some((c) => c.id === values.customerId)) {
      return html(res, appPage('Book a shipment', 'shipments', shipmentFormBody(workspace, 'Choose a customer.', values)), 400);
    }
    if (values.origin === '' || values.destination === '') {
      return html(
        res,
        appPage('Book a shipment', 'shipments', shipmentFormBody(workspace, 'Enter both an origin and a destination.', values)),
        400,
      );
    }
    const weightKg = parseWeight(values.weight);
    if (weightKg === null) {
      // Deliberately unhelpful. The field gives no unit and no range, and this
      // message adds neither.
      return html(res, appPage('Book a shipment', 'shipments', shipmentFormBody(workspace, 'Invalid value.', values)), 400);
    }

    const id = `SHP-${workspace.nextShipment++}`;
    workspace.shipments.push({
      id,
      customerId: values.customerId,
      origin: values.origin,
      destination: values.destination,
      weightKg,
      status: 'booked',
      invoiceId: null,
    });
    return redirect(res, `/app/shipments/${id}`);
  }

  const shipmentMatch = /^\/app\/shipments\/(SHP-\d+)$/.exec(path);
  if (shipmentMatch !== null && method === 'GET') {
    const shipment = workspace.shipments.find((s) => s.id === shipmentMatch[1]);
    if (shipment === undefined) {
      return html(res, appPage('Not found', 'shipments', '<h1>Shipment not found</h1>'), 404);
    }
    const invoiceRow =
      shipment.invoiceId === null
        ? `<form method="post" action="/app/shipments/${shipment.id}/invoice">
             <button type="submit">Generate invoice</button>
           </form>`
        : `<p>Invoiced as <a href="/app/invoices/${shipment.invoiceId}">${escapeHtml(shipment.invoiceId)}</a>.</p>`;

    return html(
      res,
      appPage(shipment.id, 'shipments', `
        <h1>Shipment ${escapeHtml(shipment.id)}</h1>
        <p class="sub">${escapeHtml(customerName(workspace, shipment.customerId))}</p>
        <table>
          <tr><th>Route</th><td>${escapeHtml(shipment.origin)} → ${escapeHtml(shipment.destination)}</td></tr>
          <tr><th>Weight</th><td>${weight(shipment.weightKg)}</td></tr>
          <tr><th>Status</th><td>${shipment.status}</td></tr>
        </table>
        <h2>Billing</h2>
        ${invoiceRow}
        <p><a href="/app/shipments">Back to shipments</a></p>
      `),
    );
  }

  const invoiceForShipment = /^\/app\/shipments\/(SHP-\d+)\/invoice$/.exec(path);
  if (invoiceForShipment !== null && method === 'POST') {
    const shipment = workspace.shipments.find((s) => s.id === invoiceForShipment[1]);
    if (shipment === undefined) {
      return html(res, appPage('Not found', 'shipments', '<h1>Shipment not found</h1>'), 404);
    }
    if (shipment.invoiceId !== null) return redirect(res, `/app/invoices/${shipment.invoiceId}`);

    const id = `INV-${workspace.nextInvoice++}`;
    workspace.invoices.push({
      id,
      customerId: shipment.customerId,
      shipmentId: shipment.id,
      amountCents: priceFor(shipment.weightKg),
      status: 'draft',
    });
    shipment.invoiceId = id;
    return redirect(res, `/app/invoices/${id}`);
  }

  if (path === '/app/invoices' && method === 'GET') {
    const filter = url.searchParams.get('status') ?? 'all';
    const visible = workspace.invoices.filter((i) => filter === 'all' || i.status === filter);
    const rows = visible
      .map(
        (i) => `<tr>
          <td><a href="/app/invoices/${i.id}">${escapeHtml(i.id)}</a></td>
          <td>${escapeHtml(customerName(workspace, i.customerId))}</td>
          <td>${money(i.amountCents)}</td>
          <td><span class="pill">${i.status}</span></td>
        </tr>`,
      )
      .join('');

    // No create action, and no explanation of where invoices come from.
    return html(
      res,
      appPage('Invoices', 'invoices', `
        <h1>Invoices</h1>
        <p class="sub">What your customers owe you.</p>
        <form method="get" action="/app/invoices" class="row">
          <label for="status" style="margin:0">Status</label>
          <select id="status" name="status" style="width:auto">
            <option value="all"${filter === 'all' ? ' selected' : ''}>All</option>
            <option value="draft"${filter === 'draft' ? ' selected' : ''}>Draft</option>
            <option value="sent"${filter === 'sent' ? ' selected' : ''}>Sent</option>
            <option value="paid"${filter === 'paid' ? ' selected' : ''}>Paid</option>
          </select>
          <button class="plain" type="submit">Filter</button>
        </form>
        ${
          visible.length === 0
            ? '<p class="empty">No invoices to show.</p>'
            : `<table><tr><th>Reference</th><th>Customer</th><th>Amount</th><th>Status</th></tr>${rows}</table>`
        }
      `),
    );
  }

  const invoiceMatch = /^\/app\/invoices\/(INV-\d+)$/.exec(path);
  if (invoiceMatch !== null && method === 'GET') {
    const invoice = workspace.invoices.find((i) => i.id === invoiceMatch[1]);
    if (invoice === undefined) {
      return html(res, appPage('Not found', 'invoices', '<h1>Invoice not found</h1>'), 404);
    }
    return html(
      res,
      appPage(invoice.id, 'invoices', `
        <h1>Invoice ${escapeHtml(invoice.id)}</h1>
        <p class="sub">${escapeHtml(customerName(workspace, invoice.customerId))}</p>
        <table>
          <tr><th>Shipment</th><td><a href="/app/shipments/${invoice.shipmentId}">${escapeHtml(invoice.shipmentId)}</a></td></tr>
          <tr><th>Amount</th><td>${money(invoice.amountCents)}</td></tr>
          <tr><th>Status</th><td>${invoice.status}</td></tr>
        </table>
        <p><a href="/app/invoices">Back to invoices</a></p>
      `),
    );
  }

  if (path === '/app/search' && method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const hits: string[] = [];

    if (query !== '') {
      for (const c of workspace.customers) {
        if (c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query)) {
          hits.push(`<tr><td>Customer</td><td><a href="/app/customers">${escapeHtml(c.name)}</a></td></tr>`);
        }
      }
      for (const s of workspace.shipments) {
        const haystack = `${s.id} ${s.origin} ${s.destination}`.toLowerCase();
        if (haystack.includes(query)) {
          hits.push(
            `<tr><td>Shipment</td><td><a href="/app/shipments/${s.id}">${escapeHtml(s.id)} — ${escapeHtml(s.origin)} → ${escapeHtml(s.destination)}</a></td></tr>`,
          );
        }
      }
      for (const i of workspace.invoices) {
        if (i.id.toLowerCase().includes(query)) {
          hits.push(`<tr><td>Invoice</td><td><a href="/app/invoices/${i.id}">${escapeHtml(i.id)}</a></td></tr>`);
        }
      }
    }

    return html(
      res,
      appPage('Search', 'none', `
        <h1>Search</h1>
        <form method="get" action="/app/search">
          <label for="q">Search shipments, customers and invoices</label>
          <input id="q" name="q" type="search" value="${escapeHtml(url.searchParams.get('q') ?? '')}">
          <button type="submit">Search</button>
        </form>
        ${
          query === ''
            ? '<p class="empty">Enter something to search for.</p>'
            : hits.length === 0
              ? `<p class="empty">Nothing matched “${escapeHtml(query)}”.</p>`
              : `<table><tr><th>Type</th><th>Result</th></tr>${hits.join('')}</table>`
        }
      `),
    );
  }

  if (path === '/app/account' && method === 'GET') {
    return html(
      res,
      appPage('Account', 'account', `
        <h1>Account</h1>
        <p class="sub">Your company details and subscription.</p>
        <h2>Company</h2>
        <table>
          <tr><th>Company</th><td>${escapeHtml(account.company ?? '')}</td></tr>
          <tr><th>Country</th><td>${escapeHtml(account.country ?? '')}</td></tr>
          <tr><th>People using FreightFlow</th><td>${escapeHtml(account.teamSize ?? '')}</td></tr>
          <tr><th>Signed in as</th><td>${escapeHtml(account.email)}</td></tr>
        </table>
        <h2>Subscription</h2>
        <p><a href="/app/account/billing">Billing and plan</a></p>
      `),
    );
  }

  if (path === '/app/account/billing' && method === 'GET') {
    const shipmentsThisMonth = workspace.shipments.length;
    return html(
      res,
      appPage('Billing', 'account', `
        <h1>Billing and plan</h1>
        ${account.plan === 'trial' ? notice('You are on a 14-day free trial. No card on file.') : ''}
        <h2>Current plan</h2>
        <table>
          <tr><th>Plan</th><td>${account.plan === 'trial' ? 'Free trial' : escapeHtml(account.plan)}</td></tr>
          <tr><th>Shipments this month</th><td>${shipmentsThisMonth}</td></tr>
          <tr><th>Users</th><td>${escapeHtml(account.teamSize ?? 'not set')}</td></tr>
        </table>
        <h2>Change plan</h2>
        <p>Starter is £49 a month for up to 10 users. Growth is £149 a month for up to 25 users.
        For 26 users or more you will need an Enterprise plan.</p>
        <p><a href="/pricing">Compare all plans</a></p>
        <form method="post" action="/app/account/billing">
          <label for="plan">Move to</label>
          <select id="plan" name="plan" style="width:auto">
            <option value="">Choose a plan</option>
            <option value="starter">Starter</option>
            <option value="growth">Growth</option>
          </select>
          <button type="submit">Change plan</button>
        </form>
      `),
    );
  }

  if (path === '/app/account/billing' && method === 'POST') {
    const plan = (await readBody(req)).get('plan') ?? '';
    if (plan === 'starter' || plan === 'growth') account.plan = plan;
    return redirect(res, '/app/account/billing');
  }

  return html(res, appPage('Not found', 'none', '<h1>Page not found</h1>'), 404);
}

// -------------------------------------------------------------- form bodies

function companyBody(error: string | null): string {
  return `
    <h1>Tell us about your company</h1>
    <p class="sub">Step 1 of 2</p>
    ${errorBox(error)}
    <form method="post" action="/onboarding/company">
      <label for="company">Company name</label>
      <input id="company" name="company" type="text" autocomplete="organization">
      <label for="country">Country you operate from</label>
      <select id="country" name="country">
        <option value="">Choose a country</option>
        <option value="GB">United Kingdom</option>
        <option value="NL">Netherlands</option>
        <option value="DE">Germany</option>
        <option value="IE">Ireland</option>
      </select>
      <button type="submit">Continue</button>
    </form>
  `;
}

function sizeBody(error: string | null): string {
  return `
    <h1>How many people will use FreightFlow?</h1>
    <p class="sub">Step 2 of 2</p>
    ${errorBox(error)}
    <form method="post" action="/onboarding/size">
      <label for="teamSize">People using FreightFlow</label>
      <select id="teamSize" name="teamSize">
        <option value="">Choose a range</option>
        <option value="1-9">1 to 9</option>
        <option value="10-24">10 to 24</option>
        <option value="25-49">25 to 49</option>
        <option value="50+">50 or more</option>
      </select>
      <button type="submit">Finish setup</button>
    </form>
  `;
}

function customerFormBody(error: string | null, name: string, contact: string): string {
  return `
    <h1>Add a customer</h1>
    ${errorBox(error)}
    <form method="post" action="/app/customers/new">
      <label for="name">Customer name</label>
      <input id="name" name="name" type="text" value="${escapeHtml(name)}">
      <label for="contact">Contact email</label>
      <input id="contact" name="contact" type="email" value="${escapeHtml(contact)}">
      <button type="submit">Save customer</button>
    </form>
    <p><a href="/app/customers">Back to customers</a></p>
  `;
}

function shipmentFormBody(
  workspace: Workspace,
  error: string | null,
  values: { customerId?: string; origin?: string; destination?: string; weight?: string },
): string {
  const options = workspace.customers
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}"${values.customerId === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`,
    )
    .join('');

  return `
    <h1>Book a shipment</h1>
    ${errorBox(error)}
    <form method="post" action="/app/shipments/new">
      <label for="customerId">Customer</label>
      <select id="customerId" name="customerId">
        <option value="">Choose a customer</option>
        ${options}
      </select>
      <label for="origin">Origin</label>
      <input id="origin" name="origin" type="text" value="${escapeHtml(values.origin ?? '')}">
      <label for="destination">Destination</label>
      <input id="destination" name="destination" type="text" value="${escapeHtml(values.destination ?? '')}">
      <label for="weight">Weight</label>
      <input id="weight" name="weight" type="text" value="${escapeHtml(values.weight ?? '')}">
      <button type="submit">Book shipment</button>
    </form>
    <p><a href="/app/shipments">Back to shipments</a></p>
  `;
}

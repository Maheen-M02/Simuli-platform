/**
 * A tiny deterministic SaaS app: signup -> onboarding -> invoice.
 *
 * This exists so the whole system can be tested without ever touching an
 * external website. It is a plausible product, not a happy path: the friction
 * below is deliberate, because a simulation platform that only works on
 * frictionless sites measures nothing.
 *
 * Deliberate friction points:
 *  - Password rules are only revealed after a failed attempt.
 *  - Onboarding's team-size select has no default and no inline validation.
 *  - Invoices live behind a nav item labelled "Billing", not "Invoices".
 *  - The amount field rejects currency symbols and thousands commas.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { accountForToken, createSession, createStore, type Store } from './state.ts';
import { errorBox, money, page, escapeHtml, type NavState } from './render.ts';

export type FixtureSite = {
  /** Origin with no trailing slash, e.g. http://127.0.0.1:53017 */
  readonly url: string;
  readonly store: Store;
  close(): Promise<void>;
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

/** Amount parsing is strict on purpose - see the friction note above. */
function parseAmountCents(raw: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(raw.trim())) return null;
  return Math.round(Number(raw.trim()) * 100);
}

export async function startFixtureSite(): Promise<FixtureSite> {
  const store = createStore();

  const server = createServer((req, res) => {
    handle(req, res, store).catch(() => {
      if (!res.headersSent) {
        html(res, page('Error', { signedIn: false }, '<h1>Something went wrong</h1>'), 500);
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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

function signupPage(nav: NavState, error: string | null, email: string): string {
  return page('Sign up', nav, `
    <h1>Create your account</h1>
    <p class="lede">Free forever for your first 5 invoices.</p>
    ${errorBox(error)}
    <form method="post" action="/signup">
      <label for="email">Work email</label>
      <input id="email" name="email" type="email" value="${escapeHtml(email)}" autocomplete="email">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="new-password">
      <button type="submit">Create account</button>
    </form>
  `);
}

function companyPage(nav: NavState, error: string | null): string {
  return page('Set up your account', nav, `
    <h1>Set up your account</h1>
    <p class="lede">Step 1 of 2</p>
    ${errorBox(error)}
    <form method="post" action="/onboarding">
      <label for="company">Company name</label>
      <input id="company" name="company" type="text" autocomplete="organization">
      <button type="submit">Continue</button>
    </form>
  `);
}

function teamPage(nav: NavState, error: string | null): string {
  return page('Set up your account', nav, `
    <h1>How big is your team?</h1>
    <p class="lede">Step 2 of 2</p>
    ${errorBox(error)}
    <form method="post" action="/onboarding/team">
      <label for="teamSize">Team size</label>
      <select id="teamSize" name="teamSize">
        <option value="">Choose an option</option>
        <option value="1">Just me</option>
        <option value="2-10">2-10</option>
        <option value="11-50">11-50</option>
        <option value="51+">51 or more</option>
      </select>
      <button type="submit">Finish setup</button>
    </form>
  `);
}

function newInvoicePage(nav: NavState, error: string | null, client: string, amount: string): string {
  return page('New invoice', nav, `
    <h1>New invoice</h1>
    ${errorBox(error)}
    <form method="post" action="/app/billing/new">
      <label for="client">Client name</label>
      <input id="client" name="client" type="text" value="${escapeHtml(client)}">
      <label for="amount">Amount</label>
      <input id="amount" name="amount" type="text" value="${escapeHtml(amount)}">
      <button type="submit">Create invoice</button>
    </form>
  `);
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  const account = accountForToken(store, readCookie(req, 'sid'));
  const nav: NavState = { signedIn: account !== null };

  // ---- Public pages -------------------------------------------------------

  if (path === '/' && method === 'GET') {
    return html(res, page('Invoicing that gets out of your way', nav, `
      <h1>Invoicing that gets out of your way</h1>
      <p class="lede">Send your first invoice in under two minutes.</p>
      <p><a href="/signup"><button>Get started free</button></a></p>
      <p class="hint">No card required. Cancel any time.</p>
    `));
  }

  if (path === '/pricing' && method === 'GET') {
    return html(res, page('Pricing', nav, `
      <h1>Pricing</h1>
      <p class="lede">Free while you find your feet.</p>
      <table>
        <tr><th>Plan</th><th>Price</th><th>Invoices</th></tr>
        <tr><td>Free</td><td>$0</td><td>5 / month</td></tr>
        <tr><td>Pro</td><td>$29</td><td>Unlimited</td></tr>
      </table>
      <p><a href="/signup"><button>Get started free</button></a></p>
    `));
  }

  // ---- Signup -------------------------------------------------------------

  if (path === '/signup' && method === 'GET') {
    return html(res, signupPage(nav, null, ''));
  }

  if (path === '/signup' && method === 'POST') {
    const body = await readBody(req);
    const email = (body.get('email') ?? '').trim();
    const password = body.get('password') ?? '';

    if (!email.includes('@') || email.length < 3) {
      return html(res, signupPage(nav, 'Enter a valid email address.', email), 400);
    }
    if (store.accounts.has(email)) {
      return html(res, signupPage(nav, 'An account with that email already exists.', email), 400);
    }
    // Rules deliberately withheld until now.
    if (password.length < 10 || !/\d/.test(password)) {
      return html(
        res,
        signupPage(nav, 'Password must be at least 10 characters and include a number.', email),
        400,
      );
    }

    store.accounts.set(email, { email, password, onboarded: false, company: null, teamSize: null });
    store.invoices.set(email, []);
    return redirect(res, '/onboarding', `sid=${createSession(store, email)}; Path=/; HttpOnly`);
  }

  // ---- Everything below requires an account -------------------------------

  if (account === null) {
    if (path.startsWith('/onboarding') || path.startsWith('/app') || path === '/settings') {
      return redirect(res, '/signup');
    }
    return html(res, page('Not found', nav, '<h1>Page not found</h1>'), 404);
  }

  if (path === '/onboarding' && method === 'GET') {
    return html(res, companyPage(nav, null));
  }

  if (path === '/onboarding' && method === 'POST') {
    const company = (await readBody(req)).get('company')?.trim() ?? '';
    if (company === '') return html(res, companyPage(nav, 'Company name is required.'), 400);
    account.company = company;
    return redirect(res, '/onboarding/team');
  }

  if (path === '/onboarding/team' && method === 'GET') {
    return html(res, teamPage(nav, null));
  }

  if (path === '/onboarding/team' && method === 'POST') {
    const teamSize = (await readBody(req)).get('teamSize') ?? '';
    if (teamSize === '') return html(res, teamPage(nav, 'Select a team size to continue.'), 400);
    account.teamSize = teamSize;
    account.onboarded = true;
    return redirect(res, '/app');
  }

  if (!account.onboarded && (path.startsWith('/app') || path === '/settings')) {
    return redirect(res, '/onboarding');
  }

  // ---- The app ------------------------------------------------------------

  if (path === '/app' && method === 'GET') {
    return html(res, page('Home', nav, `
      <h1>Welcome, ${escapeHtml(account.company ?? '')}</h1>
      <p class="lede">Your account is ready.</p>
      <p>Invoices, payments and receipts live under <strong>Billing</strong>.</p>
      <p><a href="/app/billing"><button>Go to Billing</button></a></p>
    `));
  }

  if (path === '/settings' && method === 'GET') {
    return html(res, page('Settings', nav, `
      <h1>Settings</h1>
      <label for="company">Company name</label>
      <input id="company" value="${escapeHtml(account.company ?? '')}" readonly>
      <label for="teamSize">Team size</label>
      <input id="teamSize" value="${escapeHtml(account.teamSize ?? '')}" readonly>
    `));
  }

  const invoices = store.invoices.get(account.email) ?? [];

  if (path === '/app/billing' && method === 'GET') {
    const rows = invoices
      .map(
        (inv) => `<tr>
          <td><a href="/app/billing/${inv.id}">${escapeHtml(inv.id)}</a></td>
          <td>${escapeHtml(inv.client)}</td>
          <td>${money(inv.amountCents)}</td>
          <td>${inv.status}</td>
        </tr>`,
      )
      .join('');

    return html(res, page('Billing', nav, `
      <h1>Billing</h1>
      <p><a href="/app/billing/new"><button>New invoice</button></a></p>
      ${
        invoices.length === 0
          ? '<p class="empty">No invoices yet.</p>'
          : `<table><tr><th>Invoice</th><th>Client</th><th>Amount</th><th>Status</th></tr>${rows}</table>`
      }
    `));
  }

  if (path === '/app/billing/new' && method === 'GET') {
    return html(res, newInvoicePage(nav, null, '', ''));
  }

  if (path === '/app/billing/new' && method === 'POST') {
    const body = await readBody(req);
    const client = (body.get('client') ?? '').trim();
    const rawAmount = body.get('amount') ?? '';

    if (client === '') {
      return html(res, newInvoicePage(nav, 'Client name is required.', client, rawAmount), 400);
    }
    const amountCents = parseAmountCents(rawAmount);
    if (amountCents === null || amountCents <= 0) {
      return html(res, newInvoicePage(nav, 'Enter an amount like 250 or 250.00.', client, rawAmount), 400);
    }

    const id = `INV-${String(store.nextInvoiceId++).padStart(4, '0')}`;
    invoices.push({ id, client, amountCents, status: 'draft' });
    return redirect(res, `/app/billing/${id}`);
  }

  const detail = /^\/app\/billing\/(INV-\d{4})$/.exec(path);
  if (detail !== null && method === 'GET') {
    const invoice = invoices.find((i) => i.id === detail[1]);
    if (invoice === undefined) {
      return html(res, page('Not found', nav, '<h1>Invoice not found</h1>'), 404);
    }

    return html(res, page(invoice.id, nav, `
      <h1>Invoice ${escapeHtml(invoice.id)}</h1>
      <p class="lede">Status: ${invoice.status}</p>
      <table>
        <tr><th>Client</th><td>${escapeHtml(invoice.client)}</td></tr>
        <tr><th>Amount</th><td>${money(invoice.amountCents)}</td></tr>
      </table>
      ${
        invoice.status === 'draft'
          ? `<form method="post" action="/app/billing/${invoice.id}/send">
               <button type="submit">Send invoice</button>
             </form>`
          : '<p>This invoice has been sent.</p>'
      }
      <p><a href="/app/billing">Back to Billing</a></p>
    `));
  }

  const send = /^\/app\/billing\/(INV-\d{4})\/send$/.exec(path);
  if (send !== null && method === 'POST') {
    const invoice = invoices.find((i) => i.id === send[1]);
    if (invoice !== undefined) invoice.status = 'sent';
    return redirect(res, `/app/billing/${send[1]}`);
  }

  return html(res, page('Not found', nav, '<h1>Page not found</h1>'), 404);
}

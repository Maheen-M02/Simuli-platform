/**
 * In-memory state for the fixture site.
 *
 * Deterministic by construction: ids are sequential, there are no timestamps in
 * rendered output, and every server instance starts empty. Tests that assert on
 * page text must not be perturbed by run order.
 */

export type Account = {
  readonly email: string;
  readonly password: string;
  /** Onboarding must be completed before the app is usable. */
  onboarded: boolean;
  company: string | null;
  teamSize: string | null;
};

export type Invoice = {
  readonly id: string;
  readonly client: string;
  /** Whole cents, to keep money off floating point. */
  readonly amountCents: number;
  status: 'draft' | 'sent';
};

export type Store = {
  readonly accounts: Map<string, Account>;
  /** session token -> account email */
  readonly sessions: Map<string, string>;
  readonly invoices: Map<string, Invoice[]>;
  nextSessionId: number;
  nextInvoiceId: number;
};

export function createStore(): Store {
  return {
    accounts: new Map(),
    sessions: new Map(),
    invoices: new Map(),
    nextSessionId: 1,
    nextInvoiceId: 1,
  };
}

export function createSession(store: Store, email: string): string {
  const token = `s${store.nextSessionId++}`;
  store.sessions.set(token, email);
  return token;
}

export function accountForToken(store: Store, token: string | null): Account | null {
  if (token === null) return null;
  const email = store.sessions.get(token);
  if (email === undefined) return null;
  return store.accounts.get(email) ?? null;
}

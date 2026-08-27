/**
 * In-memory state for FreightFlow.
 *
 * Deterministic by construction: sequential ids, no timestamps in rendered
 * output, and every server instance starts from the same seed. Two runs of the
 * same persona must see the same application, or a behavioural difference
 * between personas cannot be attributed to the persona.
 */

export type Account = {
  readonly email: string;
  readonly password: string;
  company: string | null;
  country: string | null;
  teamSize: string | null;
  onboarded: boolean;
  plan: 'trial' | 'starter' | 'growth';
};

export type Customer = {
  readonly id: string;
  readonly name: string;
  readonly contact: string;
};

export type Shipment = {
  readonly id: string;
  readonly customerId: string;
  readonly origin: string;
  readonly destination: string;
  /** Whole kilograms. The unit is deliberately not stated in the UI. */
  readonly weightKg: number;
  status: 'booked' | 'in-transit' | 'delivered';
  /** Set once an invoice has been generated from this shipment. */
  invoiceId: string | null;
};

export type Invoice = {
  readonly id: string;
  readonly customerId: string;
  readonly shipmentId: string;
  readonly amountCents: number;
  status: 'draft' | 'sent' | 'paid';
};

export type Workspace = {
  readonly customers: Customer[];
  readonly shipments: Shipment[];
  readonly invoices: Invoice[];
  nextCustomer: number;
  nextShipment: number;
  nextInvoice: number;
};

export type Store = {
  readonly accounts: Map<string, Account>;
  /** session token -> account email */
  readonly sessions: Map<string, string>;
  readonly workspaces: Map<string, Workspace>;
  nextSession: number;
};

export function createStore(): Store {
  return { accounts: new Map(), sessions: new Map(), workspaces: new Map(), nextSession: 1 };
}

/**
 * A new workspace is not empty.
 *
 * An empty product is easier to navigate than a real one, and would flatter us:
 * a dashboard with no data has nothing to get lost in. Seeded with enough to
 * look like a company that has been running for a fortnight.
 */
export function seedWorkspace(): Workspace {
  return {
    customers: [
      { id: 'CUS-001', name: 'Meridian Foods', contact: 'ops@meridianfoods.test' },
      { id: 'CUS-002', name: 'Halton Electrical', contact: 'accounts@halton.test' },
      { id: 'CUS-003', name: 'Brightline Retail', contact: 'logistics@brightline.test' },
    ],
    shipments: [
      {
        id: 'SHP-1001',
        customerId: 'CUS-001',
        origin: 'Rotterdam',
        destination: 'Manchester',
        weightKg: 8400,
        status: 'delivered',
        invoiceId: 'INV-2001',
      },
      {
        id: 'SHP-1002',
        customerId: 'CUS-002',
        origin: 'Felixstowe',
        destination: 'Leeds',
        weightKg: 2150,
        status: 'in-transit',
        invoiceId: null,
      },
    ],
    invoices: [
      { id: 'INV-2001', customerId: 'CUS-001', shipmentId: 'SHP-1001', amountCents: 184_000, status: 'paid' },
    ],
    nextCustomer: 4,
    nextShipment: 1003,
    nextInvoice: 2002,
  };
}

export function createSession(store: Store, email: string): string {
  const token = `s${store.nextSession++}`;
  store.sessions.set(token, email);
  return token;
}

export function accountForToken(store: Store, token: string | null): Account | null {
  if (token === null) return null;
  const email = store.sessions.get(token);
  if (email === undefined) return null;
  return store.accounts.get(email) ?? null;
}

export function workspaceFor(store: Store, account: Account): Workspace {
  const existing = store.workspaces.get(account.email);
  if (existing !== undefined) return existing;
  const created = seedWorkspace();
  store.workspaces.set(account.email, created);
  return created;
}

export function customerName(workspace: Workspace, id: string): string {
  return workspace.customers.find((customer) => customer.id === id)?.name ?? 'Unknown customer';
}

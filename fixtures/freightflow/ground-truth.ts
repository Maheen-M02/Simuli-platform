/**
 * What we know to be true about FreightFlow.
 *
 * THIS FILE MUST NEVER BE IMPORTED BY `server.ts`.
 *
 * The agent's entire view of the target is the HTTP responses that server
 * writes, so the way we keep known answers away from it is to keep them out of
 * that file. Two tests enforce it: one asserts the import is absent, and one
 * crawls every route looking for the marker strings below. If either fails, the
 * experiment is compromised and its numbers are worthless — an agent that can
 * read the answer key is not being measured.
 *
 * The harness imports this freely. The harness is not the agent.
 *
 * On honesty: every issue here was written into the product *before* any agent
 * saw it, and the list is not adjusted after a run. Adding an issue because the
 * agent happened to find it, or removing one because it kept missing it, would
 * turn recall into a number that only measures our willingness to move the
 * target.
 */

import type { Classification } from '../../src/evaluation/schema.ts';

/** Marker the leak test greps for. Never render this anywhere. */
export const GROUND_TRUTH_MARKER = 'FREIGHTFLOW_GROUND_TRUTH';

export type KnownIssue = {
  readonly id: string;
  /** What a fair reviewer would accept as a real problem. */
  readonly description: string;
  /** Why this is the product's fault and not the agent's. */
  readonly rationale: string;
  /** What the evaluator ought to call it. */
  readonly expected: Classification;
  /**
   * How a report gets credited with finding this.
   *
   * Matching is keyword-and-path based and therefore approximate. It is stated
   * openly rather than dressed up: a human should read the findings before
   * believing a recall number computed this way. Both conditions must hold —
   * the finding has to mention the subject AND rest on a step where the problem
   * is actually visible — because either alone matches far too much.
   */
  readonly detection: {
    /** Any one of these phrases appearing in the finding text. */
    readonly anyKeyword: readonly string[];
    /** At least one cited step must be on one of these paths. Empty means any. */
    readonly onPaths: readonly string[];
  };
  /** Which tasks can plausibly surface it. Others cannot be scored for it. */
  readonly reachableFromTasks: readonly string[];
};

/**
 * Deliberate product problems.
 *
 * Each one is a thing a real B2B product does, not a contrived trap. That
 * matters: an agent that only finds implausible problems has not shown it can
 * find real ones.
 */
export const KNOWN_PRODUCT_ISSUES: readonly KnownIssue[] = [
  {
    id: 'billing-hard-to-discover',
    description:
      'Billing is not reachable from the dashboard. It sits two levels down, behind a ' +
      'sidebar item called "Account", and nothing on the dashboard points at it.',
    rationale:
      'The customer wants to know what they will pay. The word "Billing" appears nowhere ' +
      'in the navigation, and the dashboard offers only shipment and customer actions.',
    expected: 'PRODUCT_ISSUE',
    detection: {
      anyKeyword: ['billing', 'account', 'discover', 'find', 'hidden', 'nav', 'sidebar'],
      onPaths: ['/app', '/app/account', '/app/account/billing'],
    },
    reachableFromTasks: ['find-billing', 'understand-cost-before-committing', 'supports-40-people'],
  },
  {
    id: 'invoice-requires-shipment',
    description:
      'An invoice cannot be created from the Invoices page. It has no create action and no ' +
      'explanation; the only route is to open a shipment and use "Generate invoice" there.',
    rationale:
      'Every other list in the product has a create button on it. Invoices does not, and the ' +
      'empty state says only "No invoices to show." A customer looking to invoice someone ' +
      'starts at Invoices and finds a dead end.',
    expected: 'PRODUCT_ISSUE',
    detection: {
      anyKeyword: ['invoice', 'create', 'no button', 'dead end', 'shipment', 'generate'],
      onPaths: ['/app/invoices'],
    },
    reachableFromTasks: ['create-first-invoice', 'invoice-a-customer'],
  },
  {
    id: 'weight-validation-uncommunicated',
    description:
      'The shipment weight field states no unit and no range, and rejects bad input with ' +
      'the message "Invalid value." It requires whole kilograms up to 30000.',
    rationale:
      'Contrast the signup form, which states its password rule up front. Here the customer ' +
      'is told neither the unit nor the limit, before or after failing.',
    expected: 'PRODUCT_ISSUE',
    detection: {
      anyKeyword: ['weight', 'unit', 'kg', 'kilogram', 'invalid value', 'validation'],
      onPaths: ['/app/shipments/new'],
    },
    reachableFromTasks: ['create-first-shipment', 'create-first-invoice'],
  },
  {
    id: 'pricing-not-linked-in-app',
    description:
      'Once signed in there is no link to pricing anywhere except inside the billing page, ' +
      'which is itself two levels down. The marketing site links it from the top nav.',
    rationale:
      'A customer evaluating cost during a trial has to leave the product or guess. The ' +
      'information exists and is simply not reachable from where the question arises.',
    expected: 'PRODUCT_ISSUE',
    detection: {
      anyKeyword: ['pricing', 'price', 'cost', 'how much', 'plan'],
      onPaths: ['/app', '/app/account', '/app/account/billing'],
    },
    reachableFromTasks: ['understand-cost-before-committing', 'supports-40-people'],
  },
];

/**
 * Things that work properly.
 *
 * A PRODUCT_ISSUE finding about any of these is a false positive. This list is
 * the more valuable half of the file: recall is easy to game by reporting
 * everything, and this is what stops that.
 */
export const KNOWN_NON_ISSUES: readonly {
  readonly id: string;
  readonly description: string;
  readonly paths: readonly string[];
}[] = [
  {
    id: 'signup-works',
    description:
      'Signup takes an email and a password, states its password rule up front, and works ' +
      'first time with valid input. No email verification.',
    paths: ['/signup'],
  },
  {
    id: 'signin-works',
    description: 'Sign-in works with correct credentials and gives a clear message otherwise.',
    paths: ['/signin'],
  },
  {
    id: 'onboarding-works',
    description:
      'Two clearly numbered steps, each with a labelled required field and a specific error ' +
      'message when one is missed.',
    paths: ['/onboarding/company', '/onboarding/size'],
  },
  {
    id: 'team-size-selection-works',
    description: 'The team-size dropdown is labelled, has sensible ranges, and validates clearly.',
    paths: ['/onboarding/size'],
  },
  {
    id: 'customer-creation-works',
    description:
      'Customers has a visible "Add a customer" button, a two-field form, and specific errors.',
    paths: ['/app/customers', '/app/customers/new'],
  },
  {
    id: 'shipment-booking-works',
    description:
      'Shipments has a visible "Book a shipment" button and the form works given valid input. ' +
      'The weight field is a separate, known issue.',
    paths: ['/app/shipments', '/app/shipments/new'],
  },
  {
    id: 'navigation-is-consistent',
    description:
      'The sidebar is on every signed-in page, marks the current section, and its links work.',
    paths: ['/app'],
  },
  {
    id: 'search-works',
    description:
      'Search is in the header on every page and matches shipments, customers and invoices, ' +
      'with a clear empty state.',
    paths: ['/app/search'],
  },
  {
    id: 'pricing-discoverable-on-marketing-site',
    description:
      'Pricing is in the public top nav with three named plans and per-plan user limits. ' +
      'Only its absence *inside* the app is an issue.',
    paths: ['/pricing'],
  },
  {
    id: 'signout-works',
    description: 'Sign out is in the header of every signed-in page and returns to the landing page.',
    paths: ['/app'],
  },
];

/**
 * Controlled failures.
 *
 * A note on taxonomy, because the obvious label is wrong. `/app/reports`
 * returns a 500 from the *product*, so the honest classification is
 * PRODUCT_ISSUE — the product broke. Our ENVIRONMENT_ERROR class means *our*
 * simulation broke, and a fixture cannot cause that by serving a page. So this
 * is recorded as a controlled failure with its true expected classification
 * rather than filed under a label that would quietly corrupt the metric.
 */
export const KNOWN_CONTROLLED_FAILURES: readonly {
  readonly id: string;
  readonly path: string;
  readonly description: string;
  readonly expected: Classification;
  readonly note: string;
}[] = [
  {
    id: 'reports-returns-500',
    path: '/app/reports',
    description:
      'The Reports page always returns HTTP 500 with a visible error. It is in the sidebar, ' +
      'so an exploring agent will find it.',
    expected: 'PRODUCT_ISSUE',
    note:
      'A product-side failure, correctly PRODUCT_ISSUE. Useful for checking the agent notices ' +
      'and reports a broken page rather than looping on it — and that it does not attribute a ' +
      'server error to our own tooling.',
  },
];

/** Everything the agent could legitimately reach. Used to sanity-check paths. */
export const KNOWN_PATHS: readonly string[] = [
  '/',
  '/pricing',
  '/signup',
  '/signin',
  '/onboarding/company',
  '/onboarding/size',
  '/app',
  '/app/shipments',
  '/app/shipments/new',
  '/app/customers',
  '/app/customers/new',
  '/app/invoices',
  '/app/search',
  '/app/account',
  '/app/account/billing',
  '/app/reports',
];

export function knownIssueById(id: string): KnownIssue | undefined {
  return KNOWN_PRODUCT_ISSUES.find((issue) => issue.id === id);
}

/** Known issues a given task could plausibly surface. */
export function issuesReachableFrom(taskId: string): readonly KnownIssue[] {
  return KNOWN_PRODUCT_ISSUES.filter((issue) => issue.reachableFromTasks.includes(taskId));
}

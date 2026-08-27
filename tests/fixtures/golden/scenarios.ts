import { ActionSchema, type Action } from '../../../src/actions/schema.ts';
import { GoalSchema } from '../../../src/goals/schema.ts';
import { PersonaSchema, type Persona } from '../../../src/personas/schema.ts';
import type { SessionRecord, StepRecord, Outcome, TerminationReason } from '../../../src/sessions/types.ts';
import type { ActionResult, ErrorKind } from '../../../src/types/shared.ts';
import type { Classification } from '../../../src/evaluation/schema.ts';

/**
 * The golden evaluation dataset.
 *
 * Hand-authored session records with a human-defined expected classification
 * each. Plain data: no browser, no model, no clock — so the same input always
 * produces the same evaluator prompt, and a change in the numbers means a change
 * in the evaluator rather than a change in the weather.
 *
 * Every scenario is either a mechanism we have actually seen produce a false
 * finding, or a genuine problem we must not lose while suppressing those. The
 * dataset is small enough to read in one sitting on purpose: each expectation
 * has to be defensible by a person, because a golden set nobody trusts is worse
 * than no golden set at all.
 *
 * `expected` is what the *primary* classification of the run should be. For
 * scenarios where the honest answer is "no product issue here", the metric that
 * matters is that no PRODUCT_ISSUE finding is produced.
 */

const PERSONA: Persona = PersonaSchema.parse({
  name: 'Sam, a small business owner',
  background: 'Runs a six-person consultancy. Comfortable with everyday software but not technical.',
  techLevel: 'average',
  patience: 'medium',
});

const SITE = 'http://shop.test';

type StepSpec = {
  readonly url: string;
  readonly title: string;
  /** Lines of the serialised observation, as the agent would have seen them. */
  readonly page: readonly string[];
  readonly action?: unknown;
  readonly ok?: boolean;
  readonly errorKind?: ErrorKind;
  readonly errorMessage?: string;
  readonly navigated?: boolean;
  readonly plannerError?: string;
};

function buildStep(index: number, spec: StepSpec): StepRecord {
  const action: Action | null = spec.action === undefined ? null : ActionSchema.parse(spec.action);

  let result: ActionResult | null = null;
  if (action !== null) {
    result =
      spec.ok === false
        ? {
            ok: false,
            error: {
              kind: spec.errorKind ?? 'UNKNOWN',
              message: spec.errorMessage ?? 'The action could not be completed.',
            },
            durationMs: 40,
            navigated: false,
          }
        : { ok: true, durationMs: 40, navigated: spec.navigated === true };
  }

  return {
    index,
    observation: {
      generation: index + 1,
      // Fixed timestamps: the dataset must not drift with the clock.
      capturedAt: 1_700_000_000_000 + index * 1000,
      url: spec.url,
      title: spec.title,
      text: [`URL: ${spec.url}`, `Title: ${spec.title}`, '', ...spec.page].join('\n'),
      nodeCount: spec.page.length,
      screenshotPath: `data/artifacts/golden/step-${String(index).padStart(3, '0')}.png`,
    },
    action,
    result,
    plannerError: spec.plannerError ?? null,
    startedAt: 1_700_000_000_000 + index * 1000,
    endedAt: 1_700_000_000_000 + index * 1000 + 500,
  };
}

export type GoldenScenario = {
  readonly id: string;
  /** Which of the requested categories this covers. */
  readonly category: string;
  /** Why a human says this is the right answer. Read this before trusting a metric. */
  readonly rationale: string;
  readonly expected: Classification;
  /** True when at least one PRODUCT_ISSUE finding is the correct output. */
  readonly expectProductIssue: boolean;
  readonly record: SessionRecord;
};

function scenario(input: {
  id: string;
  category: string;
  rationale: string;
  expected: Classification;
  goal: string;
  outcome: Outcome;
  terminationReason: TerminationReason;
  agentSummary?: string;
  steps: readonly StepSpec[];
}): GoldenScenario {
  const steps = input.steps.map((spec, index) => buildStep(index, spec));

  return {
    id: input.id,
    category: input.category,
    rationale: input.rationale,
    expected: input.expected,
    expectProductIssue: input.expected === 'PRODUCT_ISSUE',
    record: {
      id: `golden-${input.id}`,
      startUrl: SITE,
      persona: PERSONA,
      goal: GoalSchema.parse({ description: input.goal }),
      plannerModel: 'golden-fixture',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_000_000 + steps.length * 1000 + 500,
      outcome: input.outcome,
      terminationReason: input.terminationReason,
      agentSummary: input.agentSummary ?? null,
      steps,
    },
  };
}

const R = { reasoning: 'placeholder', expectation: 'placeholder' };

export const GOLDEN_SCENARIOS: readonly GoldenScenario[] = [
  // ---------------------------------------------------------------- product

  scenario({
    id: 'hidden-nav-label',
    category: 'missing discoverability',
    rationale:
      'The customer needed invoices. No element anywhere says "invoice"; the feature lives under ' +
      '"Billing". The record shows four pages visited and the target never named. That is the ' +
      'product failing to be discoverable, and it is visible in page content alone.',
    expected: 'PRODUCT_ISSUE',
    goal: 'Find where to create an invoice',
    outcome: 'SUCCESS',
    terminationReason: 'AGENT_FINISHED',
    agentSummary: 'Found it eventually under Billing.',
    steps: [
      {
        url: `${SITE}/app`,
        title: 'Home',
        page: ['heading1 "Welcome"', 'link "Billing" [e1]', 'link "Settings" [e2]', 'link "Reports" [e3]'],
        action: { action: 'click', ref: 'e2', ...R },
        navigated: true,
      },
      {
        url: `${SITE}/settings`,
        title: 'Settings',
        page: ['heading1 "Settings"', 'link "Billing" [e1]', 'textbox "Company name" [e2]'],
        action: { action: 'go_back', ...R },
        navigated: true,
      },
      {
        url: `${SITE}/app`,
        title: 'Home',
        page: ['heading1 "Welcome"', 'link "Billing" [e1]', 'link "Settings" [e2]', 'link "Reports" [e3]'],
        action: { action: 'click', ref: 'e3', ...R },
        navigated: true,
      },
      {
        url: `${SITE}/reports`,
        title: 'Reports',
        page: ['heading1 "Reports"', 'text "No reports yet."', 'link "Billing" [e1]'],
        action: { action: 'click', ref: 'e1', ...R },
        navigated: true,
      },
      {
        url: `${SITE}/billing`,
        title: 'Billing',
        page: ['heading1 "Billing"', 'link "New invoice" [e1]', 'text "No invoices yet."'],
        action: { action: 'finish', goalAchieved: true, evidence: 'Invoices are under Billing', ...R },
      },
    ],
  }),

  scenario({
    id: 'broken-submit',
    category: 'genuine broken functionality',
    rationale:
      'A valid form was submitted three times and every attempt returned a server error page. ' +
      'Page content shows the error, the URL never advances. Nothing about our tooling failed.',
    expected: 'PRODUCT_ISSUE',
    goal: 'Save my company details',
    outcome: 'STUCK',
    terminationReason: 'REPEATED_ACTION_LOOP',
    steps: [
      {
        url: `${SITE}/settings`,
        title: 'Settings',
        page: ['heading1 "Company details"', 'textbox "Company name" [e1]', 'button "Save" [e2]'],
        action: { action: 'type', ref: 'e1', value: 'Acme Ltd', ...R },
      },
      {
        url: `${SITE}/settings`,
        title: 'Settings',
        page: [
          'heading1 "Company details"',
          'textbox "Company name" [e1]  (current value: "Acme Ltd")',
          'button "Save" [e2]',
        ],
        action: { action: 'click', ref: 'e2', ...R },
        navigated: true,
      },
      {
        url: `${SITE}/settings`,
        title: 'Error',
        page: ['heading1 "Something went wrong"', 'alert "Error 500: could not save your changes."', 'link "Back" [e1]'],
        action: { action: 'go_back', ...R },
        navigated: true,
      },
      {
        url: `${SITE}/settings`,
        title: 'Settings',
        page: [
          'heading1 "Company details"',
          'textbox "Company name" [e1]  (current value: "Acme Ltd")',
          'button "Save" [e2]',
        ],
        action: { action: 'click', ref: 'e2', ...R },
        navigated: true,
      },
      {
        url: `${SITE}/settings`,
        title: 'Error',
        page: ['heading1 "Something went wrong"', 'alert "Error 500: could not save your changes."', 'link "Back" [e1]'],
        action: { action: 'fail', reason: 'Saving keeps failing', blocker: 'PRODUCT_ERROR', ...R },
      },
    ],
  }),

  scenario({
    id: 'hidden-password-rule',
    category: 'genuine UX friction',
    rationale:
      'The signup form states no password rule. After a rejected attempt the page reveals one. ' +
      'Two different validation messages, both in page content: the rule existed and was withheld.',
    expected: 'PRODUCT_ISSUE',
    goal: 'Create an account',
    outcome: 'SUCCESS',
    terminationReason: 'AGENT_FINISHED',
    steps: [
      {
        url: `${SITE}/signup`,
        title: 'Sign up',
        page: ['heading1 "Create your account"', 'textbox "Email" [e1]', 'password "Password" [e2]', 'button "Create account" [e3]'],
        action: { action: 'type', ref: 'e2', value: 'sunshine', ...R },
      },
      {
        url: `${SITE}/signup`,
        title: 'Sign up',
        page: ['heading1 "Create your account"', 'password "Password" [e2]  (value hidden)', 'button "Create account" [e3]'],
        action: { action: 'click', ref: 'e3', ...R },
        navigated: true,
      },
      {
        url: `${SITE}/signup`,
        title: 'Sign up',
        page: [
          'heading1 "Create your account"',
          'alert "Password must be at least 12 characters and contain a symbol."',
          'password "Password" [e2]  (value hidden)',
          'button "Create account" [e3]',
        ],
        action: { action: 'type', ref: 'e2', value: 'sunshine-in-may!', ...R },
      },
      {
        url: `${SITE}/app`,
        title: 'Home',
        page: ['heading1 "Welcome"'],
        action: { action: 'finish', goalAchieved: true, evidence: 'Account created', ...R },
      },
    ],
  }),

  scenario({
    id: 'ambiguous-duplicate-labels',
    category: 'ambiguous UI',
    rationale:
      'Two distinct controls on one page are both named "Continue" with nothing to tell them apart. ' +
      'Page content proves the duplication. A real person would also have to guess.',
    expected: 'PRODUCT_ISSUE',
    goal: 'Complete checkout',
    outcome: 'STUCK',
    terminationReason: 'NO_CHANGE_LOOP',
    steps: [
      {
        url: `${SITE}/checkout`,
        title: 'Checkout',
        page: [
          'heading1 "Checkout"',
          'text "Choose delivery"',
          'button "Continue" [e1]',
          'text "Or collect in store"',
          'button "Continue" [e2]',
        ],
        action: { action: 'click', ref: 'e1', ...R },
      },
      {
        url: `${SITE}/checkout`,
        title: 'Checkout',
        page: [
          'heading1 "Checkout"',
          'alert "Select an option to continue."',
          'button "Continue" [e1]',
          'button "Continue" [e2]',
        ],
        action: { action: 'click', ref: 'e2', ...R },
      },
      {
        url: `${SITE}/checkout`,
        title: 'Checkout',
        page: [
          'heading1 "Checkout"',
          'alert "Select an option to continue."',
          'button "Continue" [e1]',
          'button "Continue" [e2]',
        ],
        action: { action: 'fail', reason: 'Both buttons say the same thing', blocker: 'CANNOT_FIND_PATH', ...R },
      },
    ],
  }),

  scenario({
    id: 'misleading-error-state',
    category: 'misleading error state',
    rationale:
      'A successful-looking action produced a message that says nothing actionable ("An error ' +
      'occurred"). The message is in page content, so the uninformativeness is observable.',
    expected: 'PRODUCT_ISSUE',
    goal: 'Add a payment method',
    outcome: 'FAILURE',
    terminationReason: 'AGENT_FAILED',
    steps: [
      {
        url: `${SITE}/billing/cards`,
        title: 'Payment methods',
        page: ['heading1 "Add a card"', 'textbox "Cardholder name" [e1]', 'button "Save card" [e2]'],
        action: { action: 'type', ref: 'e1', value: 'Sam Patel', ...R },
      },
      {
        url: `${SITE}/billing/cards`,
        title: 'Payment methods',
        page: ['heading1 "Add a card"', 'textbox "Cardholder name" [e1]  (current value: "Sam Patel")', 'button "Save card" [e2]'],
        action: { action: 'click', ref: 'e2', ...R },
        navigated: true,
      },
      {
        url: `${SITE}/billing/cards`,
        title: 'Payment methods',
        page: ['heading1 "Add a card"', 'alert "An error occurred."', 'button "Save card" [e2]'],
        action: { action: 'fail', reason: 'The error does not say what is wrong', blocker: 'PRODUCT_ERROR', ...R },
      },
    ],
  }),

  // ------------------------------------------------- agent misunderstanding

  scenario({
    id: 'typed-into-dropdown',
    category: 'agent misunderstanding',
    rationale:
      'The dropdown was shown with all five options listed. The agent typed into it. Our executor ' +
      'named the mistake. The control was never broken — this is our simulated customer failing.',
    expected: 'AGENT_MISUNDERSTANDING',
    goal: 'Finish onboarding',
    outcome: 'STUCK',
    terminationReason: 'NO_CHANGE_LOOP',
    steps: [
      {
        url: `${SITE}/onboarding/team`,
        title: 'Set up',
        page: [
          'heading1 "How big is your team?"',
          'combobox "Team size" [e1]  (options: "Choose an option", "Just me", "2-10", "11-50"; current value: "Choose an option")',
          'button "Finish setup" [e2]',
        ],
        action: { action: 'type', ref: 'e1', value: '2-10', ...R },
        ok: false,
        errorKind: 'WRONG_ELEMENT_TYPE',
        errorMessage: '"Team size" is a dropdown, not a text field. Use the select action.',
      },
      {
        url: `${SITE}/onboarding/team`,
        title: 'Set up',
        page: [
          'heading1 "How big is your team?"',
          'combobox "Team size" [e1]  (options: "Choose an option", "Just me", "2-10", "11-50"; current value: "Choose an option")',
          'button "Finish setup" [e2]',
        ],
        action: { action: 'type', ref: 'e1', value: 'two to ten', ...R },
        ok: false,
        errorKind: 'WRONG_ELEMENT_TYPE',
        errorMessage: '"Team size" is a dropdown, not a text field. Use the select action.',
      },
    ],
  }),

  scenario({
    id: 'persistent-validation-message',
    category: 'persistent validation error',
    rationale:
      'The agent submitted an empty form, got one server-rendered message, then filled the fields. ' +
      'The message persisted because the page had not re-rendered. The agent concluded the product ' +
      'was rejecting valid input. It was not: MESSAGE_PERSISTED_UNCHANGED proves one rejection, not ' +
      'three. This is the exact false-positive mechanism we observed in production.',
    expected: 'AGENT_MISUNDERSTANDING',
    goal: 'Sign up',
    outcome: 'SUCCESS',
    terminationReason: 'AGENT_FINISHED',
    steps: [
      {
        url: `${SITE}/signup`,
        title: 'Sign up',
        page: ['heading1 "Create your account"', 'textbox "Email" [e1]', 'password "Password" [e2]', 'button "Create account" [e3]'],
        action: { action: 'click', ref: 'e3', ...R },
        navigated: true,
      },
      {
        url: `${SITE}/signup`,
        title: 'Sign up',
        page: [
          'heading1 "Create your account"',
          'alert "Enter a valid email address."',
          'textbox "Email" [e1]',
          'password "Password" [e2]',
          'button "Create account" [e3]',
        ],
        action: {
          action: 'type',
          ref: 'e1',
          value: 'sam@example.com',
          reasoning: 'Enter a valid email address.',
          expectation: 'the error clears',
        },
      },
      {
        url: `${SITE}/signup`,
        title: 'Sign up',
        page: [
          'heading1 "Create your account"',
          'alert "Enter a valid email address."',
          'textbox "Email" [e1]  (current value: "sam@example.com")',
          'password "Password" [e2]',
          'button "Create account" [e3]',
        ],
        action: {
          action: 'type',
          ref: 'e1',
          value: 'sam@acme.co',
          reasoning: 'I suspect the site rejects example.com as a placeholder domain.',
          expectation: 'a real-looking domain will be accepted',
        },
      },
      {
        url: `${SITE}/signup`,
        title: 'Sign up',
        page: [
          'heading1 "Create your account"',
          'alert "Enter a valid email address."',
          'textbox "Email" [e1]  (current value: "sam@acme.co")',
          'password "Password" [e2]',
          'button "Create account" [e3]',
        ],
        action: {
          action: 'type',
          ref: 'e2',
          value: 'long-enough-1',
          reasoning: 'The form still thinks the email is invalid until a password is entered.',
          expectation: 'the error clears once both fields are filled',
        },
      },
      {
        url: `${SITE}/app`,
        title: 'Home',
        page: ['heading1 "Welcome"'],
        action: { action: 'finish', goalAchieved: true, evidence: 'Signed up', ...R },
      },
    ],
  }),

  scenario({
    id: 'incorrect-verification-assumption',
    category: 'incorrect agent assumption',
    rationale:
      'Nothing on any page mentions email verification. The agent assumed it was required and gave ' +
      'up while the next control was on screen and enabled. A wholly invented blocker.',
    expected: 'AGENT_MISUNDERSTANDING',
    goal: 'Create my first project',
    outcome: 'FAILURE',
    terminationReason: 'AGENT_FAILED',
    steps: [
      {
        url: `${SITE}/app`,
        title: 'Home',
        page: ['heading1 "Welcome"', 'button "New project" [e1]', 'link "Billing" [e2]'],
        action: {
          action: 'fail',
          reason: 'I probably need to verify my email before I can create anything.',
          blocker: 'REQUIRES_VERIFICATION',
          reasoning: 'This probably means my account is not verified yet.',
          expectation: 'nothing will work until I confirm my email',
        },
      },
    ],
  }),

  scenario({
    id: 'gave-up-with-path-open',
    category: 'agent misunderstanding',
    rationale:
      'The agent reported it could not find a way forward on a page whose content includes a link ' +
      'named exactly for the thing it wanted. ELEMENT_PRESENT contradicts the claim.',
    expected: 'AGENT_MISUNDERSTANDING',
    goal: 'Download my invoice',
    outcome: 'FAILURE',
    terminationReason: 'AGENT_FAILED',
    steps: [
      {
        url: `${SITE}/billing/INV-0001`,
        title: 'Invoice INV-0001',
        page: ['heading1 "Invoice INV-0001"', 'link "Download PDF" [e1]', 'link "Back to Billing" [e2]'],
        action: {
          action: 'fail',
          reason: 'There is no way to download this invoice.',
          blocker: 'CANNOT_FIND_PATH',
          reasoning: 'I cannot see a download option anywhere.',
          expectation: 'there should be a download button',
        },
      },
    ],
  }),

  // ----------------------------------------------------- environment errors

  scenario({
    id: 'browser-crashed',
    category: 'browser/runtime failure',
    rationale:
      'The page died under us. Every fact is RUNTIME_FAILURE. Nothing whatsoever is known about ' +
      'the product from this run.',
    expected: 'ENVIRONMENT_ERROR',
    goal: 'Buy a subscription',
    outcome: 'ERROR',
    terminationReason: 'BROWSER_LOST',
    steps: [
      {
        url: `${SITE}/pricing`,
        title: 'Pricing',
        page: ['heading1 "Pricing"', 'button "Choose Pro" [e1]'],
        action: { action: 'click', ref: 'e1', ...R },
        ok: false,
        errorKind: 'BROWSER_CRASHED',
        errorMessage: 'The browser stopped responding.',
      },
    ],
  }),

  scenario({
    id: 'destructive-block',
    category: 'browser/runtime failure',
    rationale:
      'Our own denylist refused the final button. That is our safety policy working, and it is not ' +
      'a fact about the product.',
    expected: 'ENVIRONMENT_ERROR',
    goal: 'Send the invoice',
    outcome: 'SUCCESS',
    terminationReason: 'AGENT_FINISHED',
    steps: [
      {
        url: `${SITE}/billing/INV-0001`,
        title: 'Invoice INV-0001',
        page: ['heading1 "Invoice INV-0001"', 'text "Status: draft"', 'button "Send invoice" [e1]'],
        action: { action: 'click', ref: 'e1', ...R },
        ok: false,
        errorKind: 'ACTION_BLOCKED',
        errorMessage: '"Send invoice" looks like it would take a real action that cannot be undone.',
      },
      {
        url: `${SITE}/billing/INV-0001`,
        title: 'Invoice INV-0001',
        page: ['heading1 "Invoice INV-0001"', 'text "Status: draft"', 'button "Send invoice" [e1]'],
        action: { action: 'finish', goalAchieved: true, evidence: 'Reached the send step', ...R },
      },
    ],
  }),

  scenario({
    id: 'missing-credential',
    category: 'browser/runtime failure',
    rationale:
      'A credential the run needed was not configured. Our setup error, and the login page told us ' +
      'nothing about the product.',
    expected: 'ENVIRONMENT_ERROR',
    goal: 'Log in and check my orders',
    outcome: 'ERROR',
    terminationReason: 'CONSECUTIVE_ERRORS',
    steps: [
      {
        url: `${SITE}/login`,
        title: 'Log in',
        page: ['heading1 "Log in"', 'textbox "Email" [e1]', 'password "Password" [e2]', 'button "Log in" [e3]'],
        action: { action: 'type', ref: 'e2', value: { secret: 'PASSWORD' }, ...R },
        ok: false,
        errorKind: 'SECRET_NOT_FOUND',
        errorMessage: 'No credential named PASSWORD is available in this run.',
      },
      {
        url: `${SITE}/login`,
        title: 'Log in',
        page: ['heading1 "Log in"', 'textbox "Email" [e1]', 'password "Password" [e2]', 'button "Log in" [e3]'],
        action: { action: 'type', ref: 'e2', value: { secret: 'PASSWORD' }, ...R },
        ok: false,
        errorKind: 'SECRET_NOT_FOUND',
        errorMessage: 'No credential named PASSWORD is available in this run.',
      },
    ],
  }),

  scenario({
    id: 'navigation-blocked',
    category: 'browser/runtime failure',
    rationale:
      'The origin allowlist refused a third-party payment page. Our sandbox boundary, not a ' +
      'product dead end.',
    expected: 'ENVIRONMENT_ERROR',
    goal: 'Pay for my order',
    outcome: 'FAILURE',
    terminationReason: 'AGENT_FAILED',
    steps: [
      {
        url: `${SITE}/checkout`,
        title: 'Checkout',
        page: ['heading1 "Checkout"', 'link "Pay with PayCo" [e1]'],
        action: { action: 'click', ref: 'e1', ...R },
        ok: false,
        errorKind: 'NAVIGATION_BLOCKED',
        errorMessage: 'That leads to https://payco.test, outside the site this simulation may visit.',
      },
      {
        url: `${SITE}/checkout`,
        title: 'Checkout',
        page: ['heading1 "Checkout"', 'link "Pay with PayCo" [e1]'],
        action: { action: 'fail', reason: 'Cannot leave the site', blocker: 'BLOCKED_BY_SITE', ...R },
      },
    ],
  }),

  scenario({
    id: 'planner-failed',
    category: 'browser/runtime failure',
    rationale:
      'Our planner returned nothing usable three times running. No action was ever attempted, so ' +
      'the product was never exercised.',
    expected: 'ENVIRONMENT_ERROR',
    goal: 'Update my address',
    outcome: 'ERROR',
    terminationReason: 'CONSECUTIVE_ERRORS',
    steps: [
      {
        url: `${SITE}/settings`,
        title: 'Settings',
        page: ['heading1 "Settings"', 'textbox "Address" [e1]', 'button "Save" [e2]'],
        plannerError: 'Model returned malformed JSON three times.',
      },
      {
        url: `${SITE}/settings`,
        title: 'Settings',
        page: ['heading1 "Settings"', 'textbox "Address" [e1]', 'button "Save" [e2]'],
        plannerError: 'Model returned malformed JSON three times.',
      },
      {
        url: `${SITE}/settings`,
        title: 'Settings',
        page: ['heading1 "Settings"', 'textbox "Address" [e1]', 'button "Save" [e2]'],
        plannerError: 'Model returned malformed JSON three times.',
      },
    ],
  }),

  // ------------------------------------------------------------ inconclusive

  scenario({
    id: 'thin-evidence-giveup',
    category: 'ambiguous UI',
    rationale:
      'One step, a vague complaint, no message on the page and no failed action. Something may well ' +
      'be wrong, but this run cannot show what. The honest answer is that we do not know.',
    expected: 'INCONCLUSIVE',
    goal: 'Change my plan',
    outcome: 'FAILURE',
    terminationReason: 'AGENT_FAILED',
    steps: [
      {
        url: `${SITE}/billing`,
        title: 'Billing',
        page: ['heading1 "Billing"', 'text "Current plan: Free"', 'link "Compare plans" [e1]'],
        action: {
          action: 'fail',
          reason: 'This page feels confusing.',
          blocker: 'CANNOT_FIND_PATH',
          reasoning: 'I am not sure where to go.',
          expectation: 'a clearer path',
        },
      },
    ],
  }),

  scenario({
    id: 'timeout-mid-flow',
    category: 'ambiguous UI',
    rationale:
      'The run hit its wall clock in the middle of a working flow. Nothing failed and nothing was ' +
      'shown to be hard; we simply ran out of time. Reporting a product issue here would be invention.',
    expected: 'INCONCLUSIVE',
    goal: 'Set up my account fully',
    outcome: 'TIMEOUT',
    terminationReason: 'WALL_CLOCK',
    steps: [
      {
        url: `${SITE}/onboarding`,
        title: 'Set up',
        page: ['heading1 "Step 1 of 4"', 'textbox "Company name" [e1]', 'button "Continue" [e2]'],
        action: { action: 'type', ref: 'e1', value: 'Acme', ...R },
      },
      {
        url: `${SITE}/onboarding`,
        title: 'Set up',
        page: ['heading1 "Step 1 of 4"', 'textbox "Company name" [e1]  (current value: "Acme")', 'button "Continue" [e2]'],
        action: { action: 'click', ref: 'e2', ...R },
        navigated: true,
      },
      {
        url: `${SITE}/onboarding/2`,
        title: 'Set up',
        page: ['heading1 "Step 2 of 4"', 'textbox "Industry" [e1]', 'button "Continue" [e2]'],
        action: { action: 'type', ref: 'e1', value: 'Consulting', ...R },
      },
    ],
  }),

  // ---------------------------------------------------------------- clean run

  scenario({
    id: 'clean-success',
    category: 'successful workflow',
    rationale:
      'Every action succeeded, the flow advanced on each step, no message appeared and the goal was ' +
      'met in four steps. There is nothing to report. A finding here is a manufactured one.',
    expected: 'INCONCLUSIVE',
    goal: 'Create an invoice for Globex',
    outcome: 'SUCCESS',
    terminationReason: 'AGENT_FINISHED',
    agentSummary: 'Invoice INV-0001 created for Globex.',
    steps: [
      {
        url: `${SITE}/billing`,
        title: 'Billing',
        page: ['heading1 "Billing"', 'link "New invoice" [e1]'],
        action: { action: 'click', ref: 'e1', ...R },
        navigated: true,
      },
      {
        url: `${SITE}/billing/new`,
        title: 'New invoice',
        page: ['heading1 "New invoice"', 'textbox "Client name" [e1]', 'textbox "Amount" [e2]', 'button "Create invoice" [e3]'],
        action: { action: 'type', ref: 'e1', value: 'Globex', ...R },
      },
      {
        url: `${SITE}/billing/new`,
        title: 'New invoice',
        page: [
          'heading1 "New invoice"',
          'textbox "Client name" [e1]  (current value: "Globex")',
          'textbox "Amount" [e2]',
          'button "Create invoice" [e3]',
        ],
        action: { action: 'type', ref: 'e2', value: '1250.00', ...R },
      },
      {
        url: `${SITE}/billing/INV-0001`,
        title: 'Invoice INV-0001',
        page: ['heading1 "Invoice INV-0001"', 'text "Globex"', 'text "$1250.00"', 'text "Status: draft"'],
        action: { action: 'finish', goalAchieved: true, evidence: 'Invoice INV-0001 exists', ...R },
      },
    ],
  }),
];

/** Sanity: ids must be unique, or metrics silently double-count. */
export function duplicateIds(): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const scenario of GOLDEN_SCENARIOS) {
    if (seen.has(scenario.id)) duplicates.push(scenario.id);
    seen.add(scenario.id);
  }
  return duplicates;
}

import { describeAction, isSecretRef } from '../actions/schema.ts';
import type { SessionRecord, StepRecord } from '../sessions/types.ts';
import type { ErrorKind } from '../types/shared.ts';

/**
 * The evidence ledger: everything we can state as fact about a run.
 *
 * This module exists because the evaluator previously received one prose blob
 * in which what the page did and what the agent guessed were indistinguishable.
 * Three separate kinds of false product finding came out of that, all with the
 * same shape: a belief, a stale message or one of our own crashes was read as
 * product behaviour.
 *
 * So facts get their own id space and are generated *by code*. A model can
 * only cite them, never author them. Beliefs are carried separately, with
 * their own ids, and are not admissible as evidence for anything.
 *
 * Nothing here uses a model, and nothing here touches a browser.
 */

/**
 * A closed vocabulary of what a persisted record can actually witness.
 *
 * Each kind answers "what does the record prove?", not "what does it mean?".
 * Interpretation is the evaluator's job; this is the substrate it must work on.
 */
export const FACT_KINDS = [
  /** The agent was shown a page at this URL with this title. */
  'PAGE_VISITED',
  /** The URL differed from the previous step's. */
  'URL_CHANGED',
  /** An element with this role and name was present in the snapshot. */
  'ELEMENT_PRESENT',
  /** A named element the agent had previously seen was no longer in the snapshot. */
  'ELEMENT_ABSENT',
  /** The page carried a message in an alert/status region. */
  'VALIDATION_MESSAGE_SHOWN',
  /** The same alert text was already on screen in the previous step. */
  'MESSAGE_PERSISTED_UNCHANGED',
  /** An action was executed and reported success. */
  'ACTION_SUCCEEDED',
  /** An action was executed and reported failure, for a product-side reason. */
  'ACTION_FAILED',
  /** The action moved the browser to a different document. */
  'NAVIGATION_OCCURRED',
  /** The page was structurally identical to the previous step's. */
  'PAGE_UNCHANGED',
  /** Our executor refused the action to avoid a real-world side effect. */
  'DESTRUCTIVE_ACTION_BLOCKED',
  /** Our own machinery failed. Never evidence about the product. */
  'RUNTIME_FAILURE',
  /** The planner produced nothing usable. Never evidence about the product. */
  'PLANNER_FAILURE',
  /** A screenshot exists on disk for this step. */
  'SCREENSHOT_CAPTURED',
  /** The run stopped, and why. */
  'RUN_TERMINATED',
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

/**
 * Fact kinds that describe *our* failure rather than the product's.
 *
 * A product finding resting only on these is mechanically wrong, and the policy
 * pass reclassifies it rather than asking the model to know better.
 */
export const OUR_FAULT_FACT_KINDS: ReadonlySet<FactKind> = new Set<FactKind>([
  'RUNTIME_FAILURE',
  'PLANNER_FAILURE',
  'DESTRUCTIVE_ACTION_BLOCKED',
]);

/** Error kinds that mean our machinery broke, not that the product misbehaved. */
const OUR_FAULT_ERRORS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'BROWSER_CRASHED',
  'UNKNOWN',
  'STALE_SNAPSHOT',
  'SECRET_NOT_FOUND',
  'REF_NOT_FOUND',
  'REF_AMBIGUOUS',
  'NAVIGATION_BLOCKED',
  'WRONG_ELEMENT_TYPE',
]);

export type ObservedFact = {
  /** Stable within one evaluation: `f1`, `f2`, ... Cited by findings. */
  readonly id: string;
  readonly kind: FactKind;
  readonly stepIndex: number;
  /** Mechanically generated. No model wrote this sentence. */
  readonly statement: string;
};

/**
 * An interpretation the simulated customer offered at the time.
 *
 * Kept because it is genuinely useful — a customer's wrong guess about why
 * something failed is often the most interesting thing in a run — but held in a
 * separate id space so it can never be cited as proof of anything.
 */
export type AgentBelief = {
  /** `b1`, `b2`, ... Deliberately not interchangeable with a fact id. */
  readonly id: string;
  readonly stepIndex: number;
  readonly reasoning: string;
  readonly expectation: string;
};

export type EvidenceLedger = {
  readonly facts: readonly ObservedFact[];
  readonly beliefs: readonly AgentBelief[];
};

/** Pulls alert lines out of a serialised observation. */
function alertsIn(observationText: string): string[] {
  const alerts: string[] = [];
  for (const line of observationText.split('\n')) {
    const match = /^alert "(.*)"/.exec(line.trim());
    if (match?.[1] !== undefined) alerts.push(match[1]);
  }
  return alerts;
}

/** Pulls `role "name"` pairs out of a serialised observation. */
function elementsIn(observationText: string): string[] {
  const elements: string[] = [];
  for (const line of observationText.split('\n')) {
    const match = /^(link|button|textbox|password|combobox|checkbox|radio) "(.*?)"/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) elements.push(`${match[1]} "${match[2]}"`);
  }
  return elements;
}

/** A structural signature, used only to say whether the page moved. */
function pageSignature(step: StepRecord): string {
  return `${step.observation.url}\n${step.observation.text}`;
}

function actionDescription(step: StepRecord): string {
  return step.action === null ? 'no action' : describeAction(step.action);
}

/**
 * Builds the ledger for a record.
 *
 * Deliberately mechanical throughout: every statement is a template filled from
 * persisted values. If a claim cannot be produced this way, it is not a fact
 * and the evaluator does not get to treat it as one.
 */
export function deriveEvidence(record: SessionRecord): EvidenceLedger {
  const facts: ObservedFact[] = [];
  const beliefs: AgentBelief[] = [];

  let nextFact = 1;
  let nextBelief = 1;

  const add = (kind: FactKind, stepIndex: number, statement: string): void => {
    facts.push({ id: `f${nextFact++}`, kind, stepIndex, statement });
  };

  let previous: StepRecord | undefined;
  /** Element names seen so far, to notice one disappearing. */
  const seenElements = new Set<string>();

  for (const step of record.steps) {
    const { index, observation } = step;

    add('PAGE_VISITED', index, `The page at ${observation.url} was shown, titled "${observation.title}".`);

    if (previous !== undefined && previous.observation.url !== observation.url) {
      add('URL_CHANGED', index, `The URL changed from ${previous.observation.url} to ${observation.url}.`);
    }

    if (previous !== undefined && pageSignature(previous) === pageSignature(step)) {
      add(
        'PAGE_UNCHANGED',
        index,
        'The page was structurally identical to the previous step: same URL, same elements, same text.',
      );
    }

    const elements = elementsIn(observation.text);
    if (elements.length > 0) {
      add(
        'ELEMENT_PRESENT',
        index,
        `These elements were on the page and available to the customer: ${elements.join('; ')}.`,
      );
    }

    for (const element of seenElements) {
      if (!elements.includes(element)) {
        add('ELEMENT_ABSENT', index, `${element}, seen earlier in the run, was no longer on the page.`);
      }
    }
    for (const element of elements) seenElements.add(element);

    const alerts = alertsIn(observation.text);
    const previousAlerts = previous === undefined ? [] : alertsIn(previous.observation.text);
    for (const alert of alerts) {
      add('VALIDATION_MESSAGE_SHOWN', index, `The page displayed the message: "${alert}".`);
      if (previousAlerts.includes(alert)) {
        // The mechanism behind a real false finding: a server-rendered message
        // stays on screen until the page re-renders, so the same message across
        // several steps is one rejection being looked at, not several.
        add(
          'MESSAGE_PERSISTED_UNCHANGED',
          index,
          `The message "${alert}" was already on screen in the previous step. It persisted; ` +
            'it was not raised again in response to this step.',
        );
      }
    }

    if (observation.screenshotPath !== null) {
      add('SCREENSHOT_CAPTURED', index, 'A screenshot of this step exists on disk.');
    }

    if (step.plannerError !== null) {
      add(
        'PLANNER_FAILURE',
        index,
        `Our simulated customer could not decide what to do: ${step.plannerError}. ` +
          'This is a limitation of the simulation, not something the product did.',
      );
    }

    if (step.action !== null) {
      const result = step.result;
      const description = actionDescription(step);

      if (result === null) {
        add('RUNTIME_FAILURE', index, `The action "${description}" was recorded with no result.`);
      } else if (result.ok) {
        add('ACTION_SUCCEEDED', index, `The customer did: ${description}. It went through.`);
        if (result.navigated) {
          add('NAVIGATION_OCCURRED', index, `That action moved the browser to a different page.`);
        }
      } else {
        const kind = result.error?.kind;
        const message = result.error?.message ?? 'no message';

        if (kind === 'ACTION_BLOCKED') {
          add(
            'DESTRUCTIVE_ACTION_BLOCKED',
            index,
            `The simulation refused "${description}" to avoid a real-world side effect. ` +
              'This is our own safety policy, not a product defect.',
          );
        } else if (kind !== undefined && OUR_FAULT_ERRORS.has(kind)) {
          add(
            'RUNTIME_FAILURE',
            index,
            `The attempt "${description}" failed with ${kind}: ${message}. ` +
              'This is a failure of our simulation, not evidence about the product.',
          );
        } else {
          add('ACTION_FAILED', index, `The attempt "${description}" failed with ${kind ?? 'an error'}: ${message}`);
        }
      }

      // Beliefs are recorded, and quarantined.
      beliefs.push({
        id: `b${nextBelief++}`,
        stepIndex: index,
        reasoning: step.action.reasoning,
        expectation: step.action.expectation,
      });

      if (step.action.action === 'type' && !isSecretRef(step.action.value)) {
        add('ACTION_SUCCEEDED', index, `The value typed was ${JSON.stringify(step.action.value)}.`);
      }
    }

    previous = step;
  }

  if (record.outcome !== null) {
    add(
      'RUN_TERMINATED',
      Math.max(0, record.steps.length - 1),
      `The run ended as ${record.outcome}, because of ${record.terminationReason ?? 'an unknown reason'}.`,
    );
  }

  return { facts, beliefs };
}

/** Renders the ledger for the model. Facts first, beliefs fenced off after. */
export function renderEvidence(ledger: EvidenceLedger): string {
  const lines: string[] = [
    'OBSERVED FACTS',
    'Each line is derived mechanically from the persisted recording. These are the',
    'only things you may cite as evidence.',
    '',
  ];

  for (const fact of ledger.facts) {
    lines.push(`[${fact.id}] step ${fact.stepIndex} · ${fact.kind}: ${fact.statement}`);
  }

  lines.push(
    '',
    'AGENT BELIEFS — NOT EVIDENCE',
    'What the simulated customer thought at the time. These are guesses it made,',
    'frequently wrong, and they are recorded only so you can see how the product',
    'was understood. They are NOT admissible as evidence and must never be cited',
    'in an evidenceRefs list. A belief that the product did something is not proof',
    'that it did.',
    '',
  );

  if (ledger.beliefs.length === 0) {
    lines.push('(none)');
  } else {
    for (const belief of ledger.beliefs) {
      lines.push(
        `[${belief.id}] step ${belief.stepIndex} · believed: ${belief.reasoning} · expected: ${belief.expectation}`,
      );
    }
  }

  return lines.join('\n');
}

import { GoalSchema, type Goal } from '../../src/goals/schema.ts';

/**
 * What we ask a customer to accomplish.
 *
 * Every task states a desired outcome and never a route. That is not a style
 * preference: the moment a goal names a button we are testing whether the agent
 * can follow instructions, which is QA, and we have stopped measuring whether a
 * person could find their way. Several of these are only achievable by a path
 * the product does not advertise, and finding it is the whole point.
 */

export type TaskEntry = {
  /** CLI id, e.g. --goal create-first-invoice */
  readonly id: string;
  readonly label: string;
  readonly goal: Goal;
  /** Where the customer starts. Public landing unless signing in matters. */
  readonly startPath: string;
  /**
   * True when the task needs an account. The runner signs up rather than being
   * handed a session, because signing up is part of what we are measuring.
   */
  readonly requiresAccount: boolean;
};

function task(entry: {
  id: string;
  label: string;
  description: string;
  successCriteria?: string;
  startPath?: string;
  requiresAccount?: boolean;
}): TaskEntry {
  return {
    id: entry.id,
    label: entry.label,
    goal: GoalSchema.parse({
      description: entry.description,
      ...(entry.successCriteria === undefined ? {} : { successCriteria: entry.successCriteria }),
    }),
    startPath: entry.startPath ?? '/',
    requiresAccount: entry.requiresAccount ?? true,
  };
}

export const TASKS: readonly TaskEntry[] = [
  task({
    id: 'find-pricing',
    label: 'Find out what it costs',
    description: 'Find out how much this product costs.',
    successCriteria: 'You can state an actual price and what it includes.',
    requiresAccount: false,
  }),

  task({
    id: 'supports-40-people',
    label: 'Establish whether it suits a 40-person company',
    description:
      'Work out whether this product would suit a company with about forty people, and what ' +
      'that would cost.',
    successCriteria: 'You can say which plan applies to forty users and what it costs.',
    requiresAccount: false,
  }),

  task({
    id: 'complete-onboarding',
    label: 'Sign up and finish setup',
    description: 'Sign up for the product and get as far as actually being able to use it.',
    successCriteria: 'You are inside the product with setup finished.',
  }),

  task({
    id: 'add-customer',
    label: 'Add a customer',
    description: 'Add a new customer called Northgate Timber, contact accounts@northgate.test.',
    successCriteria: 'Northgate Timber appears in the list of customers.',
  }),

  task({
    id: 'create-first-shipment',
    label: 'Book a shipment',
    description:
      'Book a shipment of 1,200 kilograms for one of the existing customers, from Dover to ' +
      'Glasgow.',
    successCriteria: 'The shipment exists and shows the right route and weight.',
  }),

  task({
    id: 'create-first-invoice',
    label: 'Create an invoice',
    description: 'Create an invoice for one of your customers for work you have done for them.',
    successCriteria: 'An invoice exists that you could send to that customer.',
  }),

  task({
    id: 'invoice-a-customer',
    label: 'Invoice a specific delivered load',
    description:
      'Meridian Foods have had a load delivered and have not been invoiced for a second one. ' +
      'Get an invoice raised for the load that is outstanding.',
    successCriteria: 'An invoice exists against the load that had not been invoiced.',
  }),

  task({
    id: 'find-billing',
    label: 'Find the billing information',
    description:
      'You are already using the product. Find out what you are currently being charged and ' +
      'what happens when the trial ends.',
    successCriteria: 'You can state the current plan and what the trial does.',
  }),

  task({
    id: 'understand-cost-before-committing',
    label: 'Understand the cost from inside the product',
    description:
      'You have signed up and are looking around. Before you put any real data in, find out ' +
      'what this will cost you and whether you can leave.',
    successCriteria: 'You can state the price and the trial terms.',
  }),
];

export function taskById(id: string): TaskEntry | undefined {
  return TASKS.find((entry) => entry.id === id);
}

export const TASK_IDS: readonly string[] = TASKS.map((entry) => entry.id);

import { CustomerContextSchema, type CustomerContext } from '../../src/personas/context.ts';

/**
 * The customers we point at FreightFlow.
 *
 * Six people who would each buy freight software for different reasons and give
 * up for different reasons. They are deliberately *materially* different, not
 * six shades of the same careful user: if all six produce the same path through
 * the product, the persona input is decoration and we should say so.
 *
 * Each is supplied as input. Nothing generates these — a generator would let us
 * produce endless plausible-looking runs before we know whether one run is
 * trustworthy.
 *
 * These are descriptions of *types* of buyer, not real people, and a run against
 * one is not evidence about how any actual person behaves.
 */

export type PersonaEntry = {
  /** CLI id, e.g. --persona first-time-owner */
  readonly id: string;
  /** One line, for report headers. */
  readonly label: string;
  readonly context: CustomerContext;
};

function persona(entry: {
  id: string;
  label: string;
  context: Parameters<typeof CustomerContextSchema.parse>[0];
}): PersonaEntry {
  return { id: entry.id, label: entry.label, context: CustomerContextSchema.parse(entry.context) };
}

export const PERSONAS: readonly PersonaEntry[] = [
  persona({
    id: 'first-time-owner',
    label: 'First-time SMB owner, 40 staff, spreadsheets today',
    context: {
      persona: {
        name: 'Ade, owner of a 40-person haulage firm',
        background:
          'Built the company from two vans. Runs everything on spreadsheets and a WhatsApp ' +
          'group. Has never bought software before and is not confident with it.',
        techLevel: 'novice',
        patience: 'medium',
        priorities: ['knowing what it costs before committing', 'not having to train everyone'],
        wontDo: ['enter card details during a trial', 'sign anything without seeing a price'],
      },
      background:
        'Forty staff, twelve drivers, and an office manager who is drowning in paperwork. ' +
        'Looking for the first real system the company has ever had.',
      motivation: 'Wants to stop losing invoices and get paid faster.',
      expectations: [
        'the price should be easy to find',
        'it should be obvious what to do first',
        'it should suit a company of about forty people',
      ],
      constraints: ['very price sensitive', 'cannot spend a week learning it'],
    },
  }),

  persona({
    id: 'finance-manager',
    label: 'Experienced finance manager, expects accounting conventions',
    context: {
      persona: {
        name: 'Marguerite, finance manager at a freight forwarder',
        background:
          'Fifteen years in logistics finance. Has used three freight systems and two ledgers. ' +
          'Knows exactly what an invoice should contain and is impatient with software that ' +
          'invents its own vocabulary.',
        techLevel: 'confident',
        patience: 'medium',
        priorities: ['correct invoicing', 'conventional terminology', 'an audit trail'],
        wontDo: ['approve a tool that cannot raise a credit note'],
      },
      background:
        'Evaluating a replacement for a system being retired at the end of the quarter. ' +
        'She, not the operations team, will sign this off.',
      motivation: 'Needs to be satisfied the billing side is sound before anyone else looks at it.',
      expectations: [
        'invoices should be created from the invoices area',
        'terminology should match normal accounting practice',
        'amounts and tax treatment should be visible',
      ],
      constraints: ['must be able to explain the tool to an auditor'],
    },
  }),

  persona({
    id: 'operations-manager',
    label: 'Operations manager, high urgency, shipment-focused',
    context: {
      persona: {
        name: 'Tomas, operations manager on shift',
        background:
          'Runs the day desk. Books loads, chases drivers, fixes problems. Uses software all ' +
          'day but only ever the three screens he needs.',
        techLevel: 'average',
        patience: 'low',
        priorities: ['booking a load in under a minute', 'seeing what is in transit'],
        wontDo: ['read documentation', 'complete anything optional'],
      },
      background:
        'Trialling this while still running the desk. Has about ten minutes between calls.',
      motivation: 'Wants to know whether he can book a load faster than he does now.',
      expectations: [
        'booking a shipment should be immediate',
        'nothing should ask him for information twice',
      ],
      constraints: ['will abandon anything that takes more than a few steps'],
    },
  }),

  persona({
    id: 'technical-power-user',
    label: 'Technical power user, expects search and predictable navigation',
    context: {
      persona: {
        name: 'Rin, systems lead at a mid-size shipper',
        background:
          'Integrates and administers the tools the business runs on. Reads URLs, uses search ' +
          'before menus, and forms a mental model of an application within a minute.',
        techLevel: 'expert',
        patience: 'high',
        priorities: ['predictable navigation', 'search that works', 'understanding the data model'],
        wontDo: ['accept a tool with no way to find things'],
      },
      background:
        'Doing the technical part of a vendor assessment. Will map what the product can do ' +
        'before deciding whether to recommend it.',
      motivation: 'Wants to establish how the product is structured and where its limits are.',
      expectations: [
        'search should reach anything',
        'every list should behave the same way',
        'the navigation should mean what it says',
      ],
      constraints: ['reports findings to a committee, so needs specifics'],
    },
  }),

  persona({
    id: 'skeptical-buyer',
    label: 'Skeptical buyer, wants billing and trust answered first',
    context: {
      persona: {
        name: 'Delia, managing director evaluating a vendor',
        background:
          'Has been burned by a SaaS contract that auto-renewed at triple the price. Now reads ' +
          'the billing terms before touching the product.',
        techLevel: 'average',
        patience: 'low',
        priorities: ['knowing exactly what it costs', 'knowing how to leave', 'no surprise charges'],
        wontDo: ['enter payment details', 'start using a tool before understanding the billing'],
      },
      background:
        'Was sent a link by a colleague who liked it. Sceptical by default and looking for a ' +
        'reason to stop.',
      motivation: 'Wants the commercial terms clear before investing any time in the product.',
      expectations: [
        'pricing and billing should be easy to reach at any point',
        'the trial terms should be stated plainly',
      ],
      constraints: ['will stop evaluating if the cost is unclear'],
    },
  }),

  persona({
    id: 'office-administrator',
    label: 'Office administrator, cautious, does exactly what is asked',
    context: {
      persona: {
        name: 'Bev, office administrator',
        background:
          'Has been asked by her boss to "get it set up and put our customers in". Careful and ' +
          'methodical, follows the interface literally, and does not experiment.',
        techLevel: 'novice',
        patience: 'high',
        priorities: ['doing what she was asked exactly', 'not breaking anything'],
        wontDo: ['guess at what a button does', 'change any setting she was not asked to'],
      },
      background:
        'Given a login and a short list of things to do. Nobody has explained the product to her.',
      motivation: 'Wants to complete the task she was given and not get anything wrong.',
      expectations: ['the interface should tell her what to do next'],
      constraints: ['will not go looking outside the obvious path'],
    },
  }),
];

export function personaById(id: string): PersonaEntry | undefined {
  return PERSONAS.find((entry) => entry.id === id);
}

export const PERSONA_IDS: readonly string[] = PERSONAS.map((entry) => entry.id);

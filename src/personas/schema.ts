import { z } from 'zod';

/**
 * Who the simulated customer is.
 *
 * The persona is not flavour text. It is the whole reason this is a simulation
 * rather than a test script: a cautious first-time buyer and an impatient power
 * user hit completely different walls in the same product, and the difference
 * between them is what we sell. Fields here exist because they change what the
 * agent decides to do, not because they read well.
 */

export const TECH_LEVELS = ['novice', 'average', 'confident', 'expert'] as const;
export const PATIENCE_LEVELS = ['low', 'medium', 'high'] as const;

export const PersonaSchema = z
  .object({
    name: z.string().min(1).max(80),
    /** Role and context, in the persona's own terms. */
    background: z.string().min(1).max(1000),
    /** How comfortable they are with software. Drives how much they will poke. */
    techLevel: z.enum(TECH_LEVELS).default('average'),
    /** How quickly they give up when something is unclear. */
    patience: z.enum(PATIENCE_LEVELS).default('medium'),
    /** What they actually care about; shapes what they notice and complain about. */
    priorities: z.array(z.string().min(1).max(200)).max(10).default([]),
    /** Things this person would refuse to do, e.g. hand over a card number. */
    wontDo: z.array(z.string().min(1).max(200)).max(10).default([]),
  })
  .strict();

export type Persona = z.infer<typeof PersonaSchema>;

/**
 * The default when a run names no persona. Deliberately ordinary: an average
 * person with average patience is the honest baseline, and a product that
 * fails them is failing most of its market.
 */
export const DEFAULT_PERSONA: Persona = PersonaSchema.parse({
  name: 'Sam, a small business owner',
  background:
    'Runs a six-person consultancy. Comfortable with everyday software but not technical. ' +
    'Signed up because a peer recommended the product, and wants to see if it is worth switching.',
  techLevel: 'average',
  patience: 'medium',
  priorities: ['getting to the point quickly', 'not being asked for a card up front'],
  wontDo: ['enter real payment details', 'contact support to finish a basic task'],
});

/** How the persona is described to the model. */
export function describePersona(persona: Persona): string {
  const lines = [
    `You are ${persona.name}.`,
    persona.background,
    `Technical comfort: ${persona.techLevel}. Patience when things are unclear: ${persona.patience}.`,
  ];
  if (persona.priorities.length > 0) {
    lines.push(`What matters to you: ${persona.priorities.join('; ')}.`);
  }
  if (persona.wontDo.length > 0) {
    lines.push(`You will not: ${persona.wontDo.join('; ')}.`);
  }
  return lines.join('\n');
}

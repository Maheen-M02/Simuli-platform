import { z } from 'zod';
import { describePersona, PersonaSchema } from './schema.ts';

/**
 * The full context a simulated customer arrives with.
 *
 * A persona says who someone is. This says what they are *here for*, which is
 * what actually changes their behaviour: someone evaluating a tool against a
 * deadline abandons at the first wall, while someone idly comparing options
 * will poke at everything. Same person, different run.
 *
 * Supplied as input. There is no persona generation yet, deliberately — a
 * generated persona would let us produce infinite plausible-looking runs before
 * we know whether one run is trustworthy.
 */

export const CustomerContextSchema = z
  .object({
    persona: PersonaSchema,
    /**
     * The situation the customer is in, as distinct from who they are.
     *
     * `persona.background` describes the person; this describes their
     * circumstances — the company, the deadline, what they are switching from.
     * Kept separate because the same person in a different situation is a
     * different customer for our purposes.
     */
    background: z.string().max(2000).default(''),
    /** What they assume will be true. The gap from reality is friction. */
    expectations: z.array(z.string().min(1).max(300)).max(10).default([]),
    /** Why they are here at all. Governs how much friction they will absorb. */
    motivation: z.string().max(1000).default(''),
    /** Hard limits: no budget, no admin rights, needs it working today. */
    constraints: z.array(z.string().min(1).max(300)).max(10).default([]),
  })
  .strict();

export type CustomerContext = z.infer<typeof CustomerContextSchema>;

/**
 * How the context is described to the model.
 *
 * Written as the customer's own situation rather than as a specification, so
 * the model inhabits it instead of treating it as a checklist to satisfy.
 */
export function describeCustomerContext(context: CustomerContext): string {
  const lines = [describePersona(context.persona)];

  if (context.background !== '') lines.push('', `Your situation: ${context.background}`);
  if (context.motivation !== '') lines.push(`Why you are doing this: ${context.motivation}`);

  if (context.expectations.length > 0) {
    lines.push(
      '',
      'What you are expecting:',
      ...context.expectations.map((expectation) => `- ${expectation}`),
      'If the product does not match these, notice it rather than adapting silently.',
    );
  }

  if (context.constraints.length > 0) {
    lines.push('', 'Things that are true of you and cannot change:', ...context.constraints.map((c) => `- ${c}`));
  }

  return lines.join('\n');
}

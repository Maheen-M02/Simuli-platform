import { z } from 'zod';

/**
 * What the customer is trying to get done.
 *
 * A goal is stated the way a person would state it ("send my first invoice"),
 * never as a route through the UI. The moment a goal names buttons, we are
 * writing a test script and have stopped simulating a customer.
 */

export const GoalSchema = z
  .object({
    description: z.string().min(1).max(1000),
    /**
     * What the agent should be able to point at to claim success. Optional: an
     * unstated one keeps the run honest about whether the product made success
     * legible at all.
     */
    successCriteria: z.string().max(1000).optional(),
  })
  .strict();

export type Goal = z.infer<typeof GoalSchema>;

export function describeGoal(goal: Goal): string {
  const lines = [`Your goal: ${goal.description}`];
  if (goal.successCriteria !== undefined && goal.successCriteria !== '') {
    lines.push(`You will consider this done when: ${goal.successCriteria}`);
  }
  return lines.join('\n');
}

import { describeGoal } from '../goals/schema.ts';
import { describePersona } from '../personas/schema.ts';
import { PRESSABLE_KEYS, BLOCKER_KINDS } from '../actions/schema.ts';
import type { PlannerInput } from './planner.ts';

/**
 * What the model is told, and the shape it must answer in.
 *
 * The instructions below are written to produce a person, not an operator. An
 * optimal user is exactly what we must not simulate: they would never miss the
 * badly-labelled nav item, never mistype the amount, never give up — and every
 * one of those moments is the product we sell. Where the prompt pushes toward
 * competence, it pushes toward *plausible* competence for this persona.
 *
 * Everything here is advisory. The executor enforces; the prompt only asks.
 */

const RULES = `How this works:

- You can only interact with elements listed in the page description, and only
  by their ref (like e12). You cannot type a web address, run code, or open
  anything that is not on the page in front of you.
- Do one thing at a time, the way a person does. Look, act, see what happened.
- Before each action, say what you expect to happen. If what happens is not what
  you expected, that is worth noticing rather than glossing over.
- If you need a password or similar, reference it by name, e.g.
  {"secret": "PASSWORD"}. You do not know the value and do not need it.
- If something is confusing, behave as this person would: look around, try the
  thing that seems most likely, or give up if that is what they would honestly
  do. Do not brute-force your way through by trying every element on the page.
- Do not press anything that would spend money, send a real message, or delete
  something. If the only way forward is through such a button, stop and use
  "fail" with the blocker WOULD_BE_DESTRUCTIVE — reaching that point is a
  perfectly good result.
- Use "finish" when you are done. Set goalAchieved honestly and put in evidence
  the specific thing on the page that convinced you. If you did not get there,
  finish with goalAchieved false, or use "fail" if something actively blocked you.
- Use "fail" when you genuinely cannot proceed: pick the blocker that fits.`;

export function buildSystemPrompt(input: PlannerInput): string {
  const sections = [
    describePersona(input.persona),
    '',
    describeGoal(input.goal),
    '',
    'You are using a real website in a browser. You see it as a list of what is on the page.',
    '',
    RULES,
    '',
    'Act as this person would, not as an expert would. Their confusion is useful information.',
  ];

  if (input.availableSecrets.length > 0) {
    sections.push('', `Credentials available by name: ${input.availableSecrets.join(', ')}.`);
  } else {
    sections.push('', 'No stored credentials are available in this run.');
  }

  return sections.join('\n');
}

export function buildUserPrompt(input: PlannerInput): string {
  const sections: string[] = [];

  if (input.history.length > 0) {
    sections.push('What you have done so far:');
    for (const entry of input.history.slice(-12)) {
      sections.push(
        `${entry.stepIndex + 1}. You did: ${entry.action}`,
        `   You expected: ${entry.expectation}`,
        `   What happened: ${entry.outcome}`,
      );
    }
    sections.push('');
  }

  sections.push('The page in front of you now:', '', input.observation.text, '');

  if (input.stepsRemaining <= 5) {
    sections.push(
      `You have about ${input.stepsRemaining} steps left. If you are not going to get` +
        ' there, say so honestly rather than running out of time.',
      '',
    );
  }

  sections.push('What do you do next?');
  return sections.join('\n');
}

/**
 * The JSON schema sent to the model for structured output.
 *
 * Hand-written rather than generated from the Zod schema: strict structured
 * output requires every property to be listed as required and forbids extra
 * keys, which is not the same shape as our Zod schema with its defaults. The
 * two are kept deliberately parallel, and the Zod schema remains the authority
 * — this only shapes what the model produces, and every response is validated
 * against Zod regardless of what the model was asked for.
 */
const shared = {
  reasoning: { type: 'string', description: 'Why you are doing this, in your own voice.' },
  expectation: { type: 'string', description: 'What you expect to happen next.' },
} as const;

function variant(
  name: string,
  properties: Record<string, unknown>,
  description: string,
): Record<string, unknown> {
  const all = { action: { const: name }, ...properties, ...shared };
  return {
    type: 'object',
    description,
    properties: all,
    required: Object.keys(all),
    additionalProperties: false,
  };
}

const REF = { type: 'string', description: 'A ref from the page, like "e12".' };

export const ACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    // A single-key wrapper: strict structured output requires an object root,
    // and the union has to live one level down.
    decision: {
      anyOf: [
        variant('click', { ref: REF }, 'Click something on the page.'),
        variant(
          'type',
          {
            ref: REF,
            value: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: { secret: { type: 'string' } },
                  required: ['secret'],
                  additionalProperties: false,
                },
              ],
            },
            submit: { type: 'boolean', description: 'Press Enter afterwards.' },
          },
          'Type into a field.',
        ),
        variant('select', { ref: REF, value: { type: 'string' } }, 'Choose an option in a dropdown.'),
        variant(
          'scroll',
          { direction: { enum: ['up', 'down'] }, amount: { enum: ['page', 'half'] } },
          'Scroll the page.',
        ),
        variant('press_key', { key: { enum: [...PRESSABLE_KEYS] } }, 'Press a single key.'),
        variant('go_back', {}, 'Go back to the previous page.'),
        variant(
          'wait',
          { ms: { type: 'integer', minimum: 100, maximum: 5000 } },
          'Wait for something in progress.',
        ),
        variant(
          'finish',
          { goalAchieved: { type: 'boolean' }, evidence: { type: 'string' } },
          'Stop: you are done, whether or not you got there.',
        ),
        variant(
          'fail',
          { reason: { type: 'string' }, blocker: { enum: [...BLOCKER_KINDS] } },
          'Stop: something is genuinely blocking you.',
        ),
      ],
    },
  },
  required: ['decision'],
  additionalProperties: false,
} as const;
